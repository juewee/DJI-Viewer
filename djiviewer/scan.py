"""目录扫描：把 DJI 目录里的文件整理成「素材条目」（MP4 + LRF 配对）。"""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Iterable, Optional

from . import cache, config, ffmpeg
from .parser import classify_resolution, format_duration, format_size, parse_filename


def norm_id(path: str) -> str:
    return hashlib.sha1(cache.path_key(path).encode("utf-8", "replace")).hexdigest()[:16]


def _walk(root: Path, recursive: bool, max_depth: int = 3) -> Iterable[Path]:
    root_depth = len(root.parts)
    stack: "list[tuple[Path,int]]" = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if not recursive or (len(Path(entry.path).parts) - root_depth) >= max_depth:
                        continue
                    if entry.name in config.IGNORE_DIRS or entry.name.startswith("."):
                        continue
                    stack.append((Path(entry.path), depth + 1))
                elif entry.is_file(follow_symlinks=False):
                    if Path(entry.name).suffix.lower() in config.MEDIA_EXT:
                        yield Path(entry.path)
            except OSError:
                continue


def _date_cn(date_str: str) -> str:
    """2026-10-05 -> 2026年10月5日 周一"""
    try:
        dt = time.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return date_str
    weekday = "一二三四五六日"[dt.tm_wday]
    return f"{dt.tm_year}年{dt.tm_mon}月{dt.tm_mday}日 周{weekday}"


def list_roots(hint_folder: str = "") -> dict:
    """探测可用的素材根目录：各盘符下的 DCIM，以及"当前素材所在的 DCIM"。"""
    roots = []
    seen = set()

    def add(path: str, label: str) -> None:
        key = os.path.normcase(path)
        if key in seen:
            return
        sub = []
        try:
            for name in sorted(os.listdir(path)):
                p = os.path.join(path, name)
                if os.path.isdir(p) and not name.startswith("."):
                    sub.append(p)
        except OSError:
            pass
        seen.add(key)
        roots.append({"path": path, "label": label, "children": sub})

    if os.name == "nt":
        import ctypes

        try:
            mask = ctypes.windll.kernel32.GetLogicalDrives()
        except Exception:
            mask = 0
        for i in range(26):
            if not (mask >> i) & 1:
                continue
            drive = f"{chr(65 + i)}:\\"
            dcim = os.path.join(drive, "DCIM")
            if os.path.isdir(dcim):
                add(dcim, f"{chr(65 + i)}: DCIM")
    # 当前/上次素材目录往上的 DCIM（比如 C:\Users\...\Desktop\1007\DCIM\DJI_001）
    if hint_folder:
        try:
            cur = Path(hint_folder).expanduser()
            for parent in list(cur.parents)[:4]:
                if parent.name.upper() == "DCIM" and parent.is_dir():
                    add(str(parent), f"当前素材 · {parent}")
                    break
        except (OSError, ValueError):
            pass
    for extra in (Path.home() / "Videos", Path.home() / "Desktop", Path.home() / "Downloads"):
        if extra.is_dir():
            key = os.path.normcase(str(extra))
            if key not in seen:
                seen.add(key)
                roots.append({"path": str(extra), "label": extra.name, "children": []})
    return {"roots": roots}


def scan(folder: str, recursive: bool = True, force: bool = False) -> dict:
    """扫描目录，返回素材条目列表（命中缓存的直接带上 detail）。"""
    t0 = time.time()
    root = Path(folder).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"目录不存在: {folder}")
    if not root.is_dir():
        raise NotADirectoryError(f"不是目录: {folder}")

    files = list(_walk(root, recursive))
    groups: dict = {}
    for f in files:
        stem_key = cache.path_key(str(f.with_suffix("")))
        info = parse_filename(f)
        try:
            st = f.stat()
        except OSError:
            continue
        ext = f.suffix.lower()
        if ext in config.VIDEO_EXT:
            kind = "video"
        elif ext in config.PROXY_EXT:
            kind = "proxy"
        elif ext in config.PREVIEW_EXT:
            kind = "preview"       # 相机自带预览图（SCR/THM）
        else:
            kind = "photo"
        groups.setdefault(stem_key, []).append({
            "path": str(f),
            "name": f.name,
            "ext": f.suffix.lower(),
            "kind": kind,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "info": info,
        })

    clips = []
    needs_probe = []
    published_thumbs = 0
    for stem_key, members in groups.items():
        members.sort(key=lambda m: (m["kind"] != "video", m["kind"] != "proxy", m["name"]))
        main = members[0]
        proxy = next((m for m in members if m["kind"] == "proxy"), None)
        video = next((m for m in members if m["kind"] == "video"), None)
        photo = next((m for m in members if m["kind"] == "photo"), None)
        scr = next((m for m in members if m["ext"] == ".scr"), None)
        thm = next((m for m in members if m["ext"] == ".thm"), None)

        if video:
            primary = video
        elif proxy:
            primary = proxy
        elif photo:
            primary = photo
        else:
            # 只有预览图的情况（例如只拷了 THM 目录）：用它自身当条目
            primary = scr or thm or main

        info = primary["info"]
        other_paths = [m["path"] for m in members if m["path"] != primary["path"]]
        clip_id = norm_id(primary["path"])
        cached = None if force else cache.get_meta(primary["path"])
        clip_is_scrub = video is None and proxy is None and photo is None

        # 逐文件缓存状态（SCR/THM 预览图无需 ffprobe：它们只是可直接使用的 JPEG）
        file_meta = {}
        for m in members:
            fm = cache.get_meta(m["path"])
            file_meta[m["path"]] = fm
            if fm is None and m["kind"] != "preview":
                needs_probe.append(m["path"])

        clip = {
            "id": clip_id,
            "kind": primary["kind"],
            "name": primary["name"],
            "stem": Path(primary["name"]).stem,
            "path": primary["path"],
            "path_key": cache.path_key(primary["path"]),
            "ext": primary["ext"],
            "size": primary["size"],
            "mtime": primary["mtime"],
            "size_label": format_size(primary["size"]),
            "date": info.get("date") or "未知日期",
            "date_label": _date_cn(info.get("date") or ""),
            "time": info.get("time") or "--:--:--",
            "shot_at": info.get("shot_at"),
            "seq": info.get("seq"),
            "suffix": info.get("suffix"),
            "color": info.get("color"),
            "segment": info.get("segment"),
            "burst_index": info.get("burst_index"),
            "burst_base": info.get("burst_base"),
            "burst_key": None,
            "burst_pos": None,
            "burst_count": 1,
            "parsed": bool(info.get("parsed")),
            "has_video": video is not None,
            "has_proxy": proxy is not None,
            "is_photo": photo is not None and video is None and proxy is None,
            "video_path": video["path"] if video else None,
            "video_size": video["size"] if video else None,
            "video_size_label": format_size(video["size"]) if video else None,
            "proxy_path": proxy["path"] if proxy else None,
            "proxy_size": proxy["size"] if proxy else None,
            "proxy_size_label": format_size(proxy["size"]) if proxy else None,
            "photo_path": photo["path"] if photo else None,
            "scr_path": scr["path"] if scr else None,
            "thm_path": thm["path"] if thm else None,
            "preview_path": (scr or thm)["path"] if (scr or thm) else None,
            "is_scrub": video is None and proxy is None and photo is None,
            "preview_size_label": format_size((scr or thm)["size"]) if (scr or thm) else None,
            "preview_resolution": None,
            "extra_files": other_paths,
            "thumb": None,
            "detail": None,
            "files": [
                {
                    "path": m["path"],
                    "name": m["name"],
                    "kind": m["kind"],
                    "size": m["size"],
                    "size_label": format_size(m["size"]),
                    "probed": file_meta[m["path"]] is not None,
                }
                for m in members
            ],
        }

        thumb = None
        for m in members:
            fm = file_meta[m["path"]]
            if fm and fm.get("thumb"):
                thumb = fm["thumb"]
                break
        # 缓存里没有缩略图时：立刻把相机自带的 SCR/THM 发布成缩略图（纯文件复制，不等 ffprobe）
        if not thumb:
            thumb = cache.publish_preview(primary["path"])
            if thumb:
                published_thumbs += 1
        if not thumb and (scr or thm):
            # 没有可复制的预览图（或复制失败）：退回直接引用原来的 SCR/THM 文件名
            preview = scr or thm
            thumb = Path(preview["path"]).name
            dims = ffmpeg.jpeg_dimensions(preview["path"])
            res_cls = classify_resolution(*dims) if dims else None
            clip["preview_resolution"] = res_cls["label"] if res_cls else None
            if dims:
                clip["width"], clip["height"] = dims
            if clip_is_scrub and dims:
                clip["resolution"] = clip["preview_resolution"]
        if (scr or thm) and not clip["preview_resolution"]:
            dims = ffmpeg.jpeg_dimensions((scr or thm)["path"])
            res_cls = classify_resolution(*dims) if dims else None
            clip["preview_resolution"] = res_cls["label"] if res_cls else None
            if dims:
                clip["preview_width"], clip["preview_height"] = dims
            cache.put_meta((scr or thm)["path"], {
                "path": (scr or thm)["path"], "name": (scr or thm)["name"],
                "ext": (scr or thm)["ext"], "size": (scr or thm)["size"],
                "mtime": (scr or thm)["mtime"], "ok": bool(dims),
                "width": dims[0] if dims else None,
                "height": dims[1] if dims else None,
                "resolution": clip["preview_resolution"],
                "aspect": res_cls["aspect"] if res_cls else None,
                "codec_label": "JPEG",
                "is_preview": True,
                "thumb": thumb,
                "error": None if dims else "无法读取预览图尺寸",
                "probed_at": time.time(),
            })
        if clip_is_scrub and not clip.get("resolution"):
            clip["resolution"] = clip.get("preview_resolution")
        clip["thumb"] = thumb
        if cached:
            clip["detail"] = _shrink(cached)
        clips.append(clip)

    clips.sort(key=lambda c: (c["date"], c["time"], c["seq"] if c["seq"] is not None else 0))

    _mark_bursts(clips)

    # 分析队列按日期由近到远：先分析最近拍的素材，越久远的越靠后
    order = {c["path"]: i for i, c in
             enumerate(sorted(clips, key=lambda c: (c["date"], c["time"]), reverse=True))}
    needs_probe.sort(key=lambda p: order.get(p, len(order)))

    summary = _summarize(clips)
    return {
        "folder": str(root),
        "recursive": recursive,
        "scan_ms": round((time.time() - t0) * 1000, 1),
        "clip_count": len(clips),
        "file_count": len(files),
        "clips": clips,
        "needs_probe": needs_probe,
        "instant_thumbs": published_thumbs,   # 本次扫描立刻发布出来的缩略图数量
        "probe_order": "date-desc",           # 分析顺序：由近到远
        "summary": summary,
        "cache": cache.stats(),
        "generated_at": time.time(),
    }


def _shrink(meta: dict) -> dict:
    """给列表用的小体积元数据。"""
    keep = ("ok", "error", "width", "height", "resolution", "tier", "aspect",
            "megapixels", "fps", "fps_label", "codec", "codec_label", "profile",
            "pix_fmt", "bit_depth", "hdr", "duration", "bit_rate", "nb_frames",
            "has_audio", "has_embedded_thumb", "encoder", "creation_time",
            "timecode", "color_transfer", "color_primaries", "size", "thumb",
            "probed_at", "name", "ext")
    return {k: meta.get(k) for k in keep if k in meta}


def _mark_bursts(clips: "list[dict]") -> None:
    """把同一组连拍照片标成一个 burst（>=2 张才算）。

    DJI 连拍/包围曝光在标准名后面挂 `_001`、`_002` …，基准名相同即为同一组。
    单张的会清掉标记，前端就按普通照片展示。
    """
    groups: dict = {}
    for c in clips:
        base = c.get("burst_base")
        if not base:
            continue
        key = (os.path.dirname(c["path"]), base)
        groups.setdefault(key, []).append(c)
    for (folder, base), members in groups.items():
        if len(members) < 2:
            for c in members:
                c["burst_base"] = None
                c["burst_index"] = None
            continue
        members.sort(key=lambda c: (c.get("burst_index") or 0, c["name"]))
        burst_key = cache.path_key(os.path.join(folder, base))
        for pos, c in enumerate(members, 1):
            c["burst_key"] = burst_key
            c["burst_pos"] = pos
            c["burst_count"] = len(members)


def _summarize(clips: "list[dict]") -> dict:
    total_size = sum((c["size"] or 0) for c in clips)
    dates = {}
    res_count: dict = {}
    fps_count: dict = {}
    codec_count: dict = {}
    duration_total = 0.0
    today = time.strftime("%Y-%m-%d")
    day_count: dict = {}
    for c in clips:
        dates[c["date"]] = dates.get(c["date"], 0) + 1
        detail = c.get("detail") or {}
        if detail.get("ok"):
            res = detail.get("resolution") or "未知"
            res_count[res] = res_count.get(res, 0) + 1
            fps = detail.get("fps_label") or "-"
            fps_count[fps] = fps_count.get(fps, 0) + 1
            codec = detail.get("codec_label") or "-"
            codec_count[codec] = codec_count.get(codec, 0) + 1
            if detail.get("duration"):
                duration_total += float(detail["duration"])
        day_count[today] = day_count.get(today, 0) + (1 if c["date"] == today else 0)

    return {
        "total_size": total_size,
        "total_size_label": format_size(total_size),
        "duration_total": round(duration_total, 1),
        "duration_label": format_duration(duration_total),
        "dates": dates,
        "date_count": len(dates),
        "resolution": res_count,
        "fps": fps_count,
        "codec": codec_count,
        "photos": sum(1 for c in clips if c["is_photo"]),
        "videos": sum(1 for c in clips if not c["is_photo"]),
        "burst_groups": len({c["burst_key"] for c in clips if c.get("burst_key")}),
        "burst_photos": sum(1 for c in clips if c.get("burst_key")),
        "with_proxy": sum(1 for c in clips if c["has_proxy"]),
        "orphan_proxy": sum(1 for c in clips if c["has_proxy"] and not c["has_video"]),
        "empty_files": sum(1 for c in clips if not c["size"]),
    }
