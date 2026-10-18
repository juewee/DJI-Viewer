"""探测结果与缩略图缓存 + 后台探测队列。

设计目标：
* 首次扫描立刻返回文件列表（纯文件系统操作），界面秒开；
* ffprobe / 缩略图抽取在线程池里后台跑，前端轮询增量刷新；
* 结果按「路径 + 大小 + 修改时间」缓存到 cache/probe_cache.json，二次打开瞬时完成。
"""
from __future__ import annotations

import json
import os
import re
import shutil  # noqa: F401  (缩略图复用 / 清缓存)
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from . import config, ffmpeg
from .parser import classify_resolution, format_size

_LOCK = threading.RLock()
_cache: dict = {}
_dirty = False
_last_flush = 0.0
_queued: set = set()
_running: dict = {}          # path -> start time
_progress = {"total": 0, "done": 0, "failed": 0, "active": 0, "generation": "",
             "phase": "idle"}
_pool: Optional[ThreadPoolExecutor] = None
_watch: dict = {}            # path -> {"size":int,"mtime":float} 用于判断列表是否变化


# ------------------------------------------------------------------ 基础
def _stat_key(st) -> dict:
    return {"size": int(st.st_size), "mtime": round(float(st.st_mtime), 3)}


def path_key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def thumb_name(path: str, lut: bool = False) -> str:
    import hashlib

    h = hashlib.sha1(path_key(path).encode("utf-8", "replace")).hexdigest()[:20]
    stem = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(path).stem)[:40]
    tag = "_lut" if lut else ""
    return f"{stem}_{h}{tag}.jpg"


def thumb_path(path: str, lut: bool = False) -> Path:
    return config.THUMB_DIR / thumb_name(path, lut)


def load() -> None:
    global _cache
    config.ensure_cache_dirs()
    if config.PROBE_CACHE_FILE.exists():
        try:
            with open(config.PROBE_CACHE_FILE, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            _cache = data if isinstance(data, dict) else {}
        except Exception:
            _cache = {}


def get_meta(path: str) -> Optional[dict]:
    """命中缓存则返回，否则 None（键含大小/修改时间，文件变化自动失效）。"""
    key = path_key(path)
    try:
        st = os.stat(path)
    except OSError:
        return None
    entry = _cache.get(key)
    if not entry:
        return None
    sk = _stat_key(st)
    if entry.get("size") != sk["size"] or abs(entry.get("mtime", 0) - sk["mtime"]) > 0.001:
        return None
    meta = entry.get("meta")
    if not meta:
        return None
    if meta.get("thumb") and not (config.THUMB_DIR / meta["thumb"]).exists():
        meta = dict(meta, thumb=None)
    return meta


def put_meta(path: str, meta: dict) -> None:
    global _dirty
    try:
        st = os.stat(path)
    except OSError:
        return
    with _LOCK:
        sk = _stat_key(st)
        _cache[path_key(path)] = {
            "size": sk["size"], "mtime": sk["mtime"],
            "meta": meta, "ts": time.time(),
        }
        _dirty = True
    _maybe_flush()


def _maybe_flush(force: bool = False) -> None:
    global _dirty, _last_flush
    with _LOCK:
        if not _dirty:
            return
        now = time.time()
        if not force and now - _last_flush < 2.0:
            return
        _last_flush = now
        _dirty = False
        snapshot = dict(_cache)
    tmp = config.PROBE_CACHE_FILE.with_suffix(".tmp")
    try:
        config.ensure_cache_dirs()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False)
        os.replace(tmp, config.PROBE_CACHE_FILE)
    except Exception as exc:  # 缓存写失败不影响主流程
        config.log(f"[cache] 写入失败: {exc}")


def flush() -> None:
    _maybe_flush(force=True)


def stats() -> dict:
    with _LOCK:
        return {"entries": len(_cache),
                "pending": len(_thumb_queue) + len(_analyze_queue),
                "running": len(_running)}


def purge() -> dict:
    """清空缓存（探测结果 + 缩略图）。"""
    with _LOCK:
        _cache.clear()
    try:
        if config.PROBE_CACHE_FILE.exists():
            config.PROBE_CACHE_FILE.unlink()
        if config.THUMB_DIR.exists():
            shutil.rmtree(config.THUMB_DIR, ignore_errors=True)
        config.THUMB_DIR.mkdir(parents=True, exist_ok=True)
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


# ------------------------------------------------- 后台队列（两阶段流水线）
# 阶段① thumb  : 先给**每一个**素材出缩略图。SCR/THM 直接复制（毫秒级），
#                没有预览图才动用 ffmpeg 抓一帧（硬解、短超时）。
# 阶段② analyze: 再逐个 ffprobe，解析分辨率/帧率/编码/时长等参数。
#
# ThreadPoolExecutor 的工作队列是 FIFO，所以"把所有 thumb 任务先投递完、
# 再投递 analyze 任务"就能保证：**所有缩略图出完之前，不会开始分析任何一条素材**。
_thumb_queue: "list[str]" = []
_analyze_queue: "list[str]" = []
_thumb_progress = {"total": 0, "done": 0, "failed": 0}


def _thumb_ready(path: str) -> bool:
    dest = thumb_path(path)
    try:
        return dest.exists() and dest.stat().st_size > 0
    except OSError:
        return False


# 对外暴露（前端"边生成边贴图"用）
thumb_ready = _thumb_ready


def _thumb_only(path: str, lut: bool = False) -> bool:
    """只负责出图：预览图直出 → 照片缩放 → 视频抓一帧。

    lut=True 时改为"抽一帧 + 套 LUT（D-Log M→Rec.709）"，输出到独立的 _lut.jpg，
    与普通缩略图并存，切换时不用重算。
    """
    dest = thumb_path(path, lut)
    if dest.exists() and dest.stat().st_size > 0:
        return True
    p = Path(path)
    ext = p.suffix.lower()
    if lut:
        return _lut_thumb_only(p, ext, dest)
    if ext in config.PREVIEW_EXT:
        return bool(_preview_thumb(path))
    if ext in (".jpg", ".jpeg"):
        return bool(_photo_thumb(path))
    # ① 相机自带 SCR/THM（同时会把图共享给成对的 LRF）
    if publish_preview(path):
        return True
    # ② 成对素材优先拿 LRF 当抽帧源：720p H.264 比 4K/8K HEVC 快一个数量级
    if ext in config.VIDEO_EXT:
        lrf = _sibling(p, ".LRF")
        try:
            usable = lrf and lrf.exists() and lrf.stat().st_size > 0
        except OSError:
            usable = False
        if usable and ffmpeg.quick_thumb(str(lrf), str(dest)):
            _share_thumb_with_pair(p, dest)   # LRF 的图也就一起有了
            return True
    # ③ 最后才直接解自己
    if ffmpeg.quick_thumb(path, str(dest)):
        _share_thumb_with_pair(p, dest)
        return True
    return False


def _lut_thumb_only(p: Path, ext: str, dest: Path) -> bool:
    """套 LUT 出图：静态图不让 ffmpeg 带 -ss（会失败），视频优先用 LRF（更快）。"""
    source = p
    still = ext in config.PHOTO_EXT or ext in config.PREVIEW_EXT
    if ext in config.VIDEO_EXT:
        lrf = _sibling(p, ".LRF")
        try:
            if lrf and lrf.exists() and lrf.stat().st_size > 0:
                source, still = lrf, False
        except OSError:
            pass
    return ffmpeg.quick_thumb(str(source), str(dest),
                              ts=None if still else 1.0, lut=True)


def lut_thumb(path: str) -> Optional[str]:
    """生成/复用"带 LUT 的缩略图"，返回文件名；没有 LUT 时返回 None。"""
    if not config.lut_rel():
        return None
    dest = thumb_path(path, lut=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    return dest.name if _thumb_only(path, lut=True) else None


def probe_now(path: str) -> dict:
    """同步分析一个文件（"点开才分析"用）：直接在主调用线程里跑，结果写缓存。

    只对单个文件使用——一两个 ffprobe 的代价可以接受，换来点开立刻有参数。
    """
    meta = get_meta(path)
    if meta and meta.get("ok"):
        return meta
    meta = _probe_file(path)
    put_meta(path, meta)
    return meta


def thumb_status(paths: "list[str]") -> dict:
    """返回这批路径里"缩略图已经可用"的 {路径: 缩略图文件名}，供前端增量贴图。"""
    out = {}
    for p in paths:
        if _thumb_ready(p):
            out[p] = thumb_name(p)
    return out


def _worker(path: str) -> None:
    meta = _probe_file(path)
    put_meta(path, meta)
    with _LOCK:
        if meta.get("ok"):
            _progress["done"] += 1
        else:
            _progress["failed"] += 1


def _pool_get() -> ThreadPoolExecutor:
    global _pool
    with _LOCK:
        if _pool is None:
            _pool = ThreadPoolExecutor(
                max_workers=config.PROBE_WORKERS, thread_name_prefix="probe"
            )
        return _pool


def enqueue(paths: "list[str]", generation: str = "") -> int:
    """把未缓存的路径排进两阶段队列，返回新入队数量。"""
    with _LOCK:
        if generation and generation != _progress.get("generation"):
            _progress.update({"total": 0, "done": 0, "failed": 0})
            _thumb_progress.update({"total": 0, "done": 0, "failed": 0})
            _progress["generation"] = generation
        added = 0
        for p in paths:
            k = path_key(p)
            if k in _queued or p in _running:
                continue
            _queued.add(k)
            if _thumb_ready(p):
                _analyze_queue.append(p)          # 图已经有了，直接排队分析
            else:
                _thumb_queue.append(p)            # 先出图…
                _thumb_progress["total"] += 1
                _analyze_queue.append(p)          # …出完图再分析（FIFO 保证顺序）
            _progress["total"] += 1
            added += 1
    if added:
        _pump()
    return added


def warm_thumbs(paths: "list[str]") -> int:
    """只为补齐缩略图入队（这些文件参数已缓存，不需要再分析一次）。"""
    with _LOCK:
        added = 0
        for p in paths:
            k = path_key(p)
            if k in _queued or p in _running or _thumb_ready(p):
                continue
            _queued.add(k)
            _thumb_queue.append(p)
            _thumb_progress["total"] += 1
            added += 1
    if added:
        _pump()
    return added


def _pump() -> None:
    """派发任务。

    **硬性保证：所有缩略图没出完之前，绝不派发任何分析任务。**
    只靠 FIFO 顺序不够——enqueue() 和 warm_thumbs() 是两次独立调用，
    第二批缩略图会被追加到已经投递的分析任务后面，分析就提前跑了。
    所以这里显式检查"出图是否全部完成"，最后一个缩略图任务结束时会再调一次 _pump()，
    把攒着的分析任务放行。
    """
    pool = _pool_get()
    batch: "list[tuple[str, str]]" = []
    with _LOCK:
        for path in _thumb_queue:
            _running[path] = time.time()
            batch.append((path, "thumb"))
        _thumb_queue.clear()
        thumbs_done = _thumb_progress["done"] >= _thumb_progress["total"]
        if thumbs_done:
            for path in _analyze_queue:
                _running[path] = time.time()
                batch.append((path, "analyze"))
            _analyze_queue.clear()
        _progress["active"] = len(_running)
    for path, kind in batch:
        pool.submit(_task, path, kind)


def _task(path: str, kind: str) -> None:
    try:
        if kind == "thumb":
            ok = _thumb_only(path)
            with _LOCK:
                _thumb_progress["done"] += 1
                if not ok:
                    _thumb_progress["failed"] += 1
        else:
            _worker(path)
    except Exception as exc:
        config.log(f"[{kind}] {path} 失败: {exc}")
        with _LOCK:
            if kind == "thumb":
                _thumb_progress["done"] += 1
                _thumb_progress["failed"] += 1
            else:
                _progress["failed"] += 1
    finally:
        with _LOCK:
            if kind == "thumb":
                # 出完图还没分析：去重标记要留着，否则同一条会被重复排进分析队列
                still = path in _analyze_queue
            else:
                still = False
            _running.pop(path, None)
            if not still:
                # _queued 里存的是 path_key，这里必须用同一个键去清，否则这条路径
                # 会永远卡在"已入队"状态，同一个进程里再也排不进队列
                _queued.discard(path_key(path))
            _progress["active"] = len(_running)
            thumbs_finished = (kind == "thumb" and
                               _thumb_progress["done"] >= _thumb_progress["total"])
            has_waiting = bool(_analyze_queue or _thumb_queue)
        # 最后一个缩略图刚出完：把攒着的分析任务放行
        if thumbs_finished and has_waiting:
            _pump()


def progress() -> dict:
    with _LOCK:
        p = dict(_progress)
        p["pending"] = len(_thumb_queue) + len(_analyze_queue)
        p["active"] = len(_running)
        p["thumb_total"] = _thumb_progress["total"]
        p["thumb_done"] = _thumb_progress["done"]
        p["thumb_failed"] = _thumb_progress["failed"]
        thumb_pending = len(_thumb_queue) or (
            _thumb_progress["done"] < _thumb_progress["total"])
        analyze_pending = len(_analyze_queue) or (
            p["done"] + p["failed"] < p["total"])
        if thumb_pending:
            p["phase"] = "thumb"
        elif analyze_pending:
            p["phase"] = "analyze"
        elif p["total"]:
            p["phase"] = "done"
        else:
            p["phase"] = "idle"
    return p


def reset_progress(generation: str) -> None:
    with _LOCK:
        _progress.update({"total": 0, "done": 0, "failed": 0,
                          "generation": generation, "active": 0, "phase": "idle"})
        _thumb_progress.update({"total": 0, "done": 0, "failed": 0})


# ------------------------------------------------------------- 单个文件
def _probe_file(path: str) -> dict:
    ext = Path(path).suffix.lower()
    p = Path(path)
    try:
        st = p.stat()
    except OSError as exc:
        return {"ok": False, "error": f"无法访问: {exc}"}

    base = {
        "path": path,
        "name": p.name,
        "ext": ext,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "probed_at": time.time(),
    }
    if st.st_size == 0:
        return dict(base, ok=False, error="文件为 0 字节（拷贝未完成或已损坏）")

    if ext in (".jpg", ".jpeg"):
        info = ffmpeg.analyze_photo(path)
        thumb = _photo_thumb(path)
        return dict(base, **info, thumb=thumb)

    if ext in config.PREVIEW_EXT:
        # 相机自带预览图：本身就是 JPEG，直接当缩略图用，不做任何解码
        info = ffmpeg.analyze_photo(path)
        thumb = _preview_thumb(path)
        return dict(base, **info, thumb=thumb, is_preview=True)

    info = ffmpeg.analyze_video(path)
    if not info.get("ok"):
        return dict(base, **info)
    thumb = _video_thumb(path)
    return dict(base, **info, thumb=thumb)


def _video_thumb(path: str, clip: Optional[dict] = None) -> Optional[str]:
    """优先用相机自带的 SCR/THM（标准 JPEG，直接复制即可），其次才让 ffmpeg 抽帧。"""
    dest = thumb_path(path)
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    p = Path(path)

    # ① 相机自带预览图：1280x720 的 SCR 优先，其次 256x144 的 THM。
    #    完全不解码视频——对 4K/8K HEVC 素材又快又稳，画质还更干净。
    #    clip 里带了扫描时配好对的路径；单文件探测时退回"同目录同名"查找。
    previews = [(clip or {}).get("scr_path"), (clip or {}).get("thm_path")]
    if not any(previews):
        previews = [_sibling(p, ".SCR"), _sibling(p, ".THM")]
    for candidate in previews:
        if candidate and os.path.exists(candidate) and os.path.getsize(candidate) > 0:
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(candidate, dest)
                _share_thumb_with_pair(p, dest)
                return dest.name
            except OSError:
                pass

    is_proxy = p.suffix.lower() in config.PROXY_EXT
    sibling = _sibling(p, ".MP4" if is_proxy else ".LRF")

    if is_proxy and sibling:
        # 成对素材：直接复用 MP4 的封面，省一次抽帧
        src_thumb = thumb_path(str(sibling))
        if src_thumb.exists() and src_thumb.stat().st_size > 0:
            try:
                shutil.copyfile(src_thumb, dest)
                return dest.name
            except OSError:
                pass

    # ② 退路：成对文件以及自己，交给 ffmpeg 抽帧 / 取内嵌封面
    candidates: "list[tuple[str, str]]" = []
    if sibling and sibling.exists() and sibling.stat().st_size > 0:
        candidates.append((str(sibling), "video"))
    candidates.append((path, "embedded" if not is_proxy else "video"))
    candidates.append((path, "video"))

    for src, kind in candidates:
        if not os.path.exists(src) or os.path.getsize(src) == 0:
            continue
        if kind == "embedded":
            ok = ffmpeg.extract_embedded_thumb(src, str(dest))
            if not ok:
                ok = ffmpeg.make_thumbnail_hw(src, str(dest), ts=_seek_ts(src))
        else:
            ok = ffmpeg.make_thumbnail(src, str(dest), ts=_seek_ts(src))
        if ok:
            _share_thumb_with_pair(p, dest)
            return dest.name
    return None


def _share_thumb_with_pair(p: Path, dest: Path) -> None:
    """成对的 MP4/LRF 共享同一张封面，避免重复生成。"""
    if p.suffix.lower() in config.PROXY_EXT:
        return
    sibling = _sibling(p, ".LRF")
    if not sibling:
        return
    try:
        shutil.copy(dest, thumb_path(str(sibling)))
    except OSError:
        pass


def _seek_ts(src: str) -> float:
    """封面取帧时间点：短片取一半，长片取 1.0~2.0 秒，避开起始黑帧。"""
    dur = _quick_duration(src)
    if dur is None:
        return 1.0
    if dur <= 2.0:
        return max(0.0, dur * 0.5)
    if dur <= 6.0:
        return min(1.5, dur * 0.35)
    return 2.0


def _quick_duration(src: str) -> Optional[float]:
    """只读容器时长，比完整探测快很多（选帧位置用）。"""
    try:
        data = ffmpeg.probe_json(src, "format_only")
        fmt = data.get("format") or {}
        cand = fmt.get("duration")
        if cand is not None:
            return float(cand)
    except Exception:
        pass
    return None


def _sibling(p: Path, want_ext: str) -> Optional[Path]:
    cand = p.with_suffix(want_ext)
    if cand.exists():
        return cand
    # 大小写不敏感地找一遍
    try:
        for entry in p.parent.iterdir():
            if entry.stem.lower() == p.stem.lower() and entry.suffix.lower() == want_ext.lower():
                return entry
    except OSError:
        pass
    return None


def publish_preview(path: str) -> Optional[str]:
    """把相机自带的 SCR/THM 立刻发布成缩略图（纯文件复制，微秒级）。

    与探测解耦：扫描阶段就能出图，用户不必等 ffprobe。SCR 优先，其次 THM。
    """
    p = Path(path)
    dest = thumb_path(path)
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    for sibling in (_sibling(p, ".SCR"), _sibling(p, ".THM")):
        if not sibling:
            continue
        try:
            if not sibling.exists() or sibling.stat().st_size == 0:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sibling, dest)
            return dest.name
        except OSError:
            continue
    return None


def _preview_thumb(path: str) -> Optional[str]:
    """SCR/THM 本身就是 JPEG，直接复制成缩略图（不解码、不重采样）。"""
    dest = thumb_path(path)
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
        return dest.name
    except OSError:
        return None


def _photo_thumb(path: str) -> Optional[str]:
    dest = thumb_path(path)
    if dest.exists() and dest.stat().st_size > 0:
        return dest.name
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-i", path, "-frames:v", "1",
        "-vf", f"scale={config.THUMB_WIDTH}:-2:flags=lanczos",
        "-q:v", str(config.THUMB_QUALITY), str(dest),
    ]
    try:
        import subprocess

        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=config.FFMPEG_TIMEOUT, **config.no_window_kwargs())
        if proc.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
            return dest.name
    except Exception:
        return None
    return None


def human_size(num: Optional[int]) -> str:
    return format_size(num)
