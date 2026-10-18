"""导出（转存）原始素材：把勾选的素材拷贝到指定文件夹。

设计要点
* **只导出原片**：MP4 / MOV / JPG / DNG，LRF 代理文件一律跳过（用户明确要求）。
* 先出**计划**（干跑）再执行：清单、体积、磁盘余量、重名冲突都在动手前就能看到。
* 进度可轮询、可取消；同名文件支持 skip / overwrite / rename 三种策略。
* 可选写 `_export_manifest.csv` 清单，便于核对转存结果。
"""
from __future__ import annotations

import csv
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from . import config
from . import cache
from . import ffmpeg as ffmod
from .parser import format_size, parse_filename

# 只导出这些（原片）；LRF 是预览代理、SCR/THM 是相机自带缩略图，都不导出
SOURCE_EXTS = {".mp4", ".mov", ".jpg", ".jpeg", ".dng", ".png"}
PROXY_EXTS = {".lrf"} | getattr(config, "PREVIEW_EXT", {".scr", ".thm"})
COPY_WORKERS = 3
COPY_CHUNK = 4 * 1024 * 1024

_jobs: dict = {}
_jobs_lock = threading.Lock()
_job_seq = 0

CONFLICT_MODES = {"skip", "overwrite", "rename"}


# ------------------------------------------------------------------ 工具
def is_source_file(path) -> bool:
    """是否是"原片"（需要导出的文件）。"""
    return Path(path).suffix.lower() in SOURCE_EXTS


def source_paths_of(clip: dict) -> "list[str]":
    """从扫描出的素材条目里取出要导出的原片路径（排除 LRF）。"""
    out = []
    if clip.get("video_path"):
        out.append(clip["video_path"])
    if clip.get("photo_path"):
        out.append(clip["photo_path"])
    if not out:
        # 兜底：只有 LRF 的条目没有原片可导，直接跳过
        only = clip.get("path")
        if only and is_source_file(only):
            out.append(only)
    return [p for p in out if is_source_file(p)]


def free_space(path: str) -> Optional[int]:
    """目标可用空间；目录还不存在时沿父级向上找最近的已存在目录。"""
    p = Path(path).expanduser()
    seen = 0
    while not p.exists() and p != p.parent and seen < 40:
        p = p.parent
        seen += 1
    try:
        return shutil.disk_usage(str(p)).free
    except OSError:
        return None


def _unique_path(dest: Path) -> Path:
    stem, suffix, parent = dest.stem, dest.suffix, dest.parent
    i = 2
    while True:
        cand = parent / f"{stem} ({i}){suffix}"
        if not cand.exists():
            return cand
        i += 1


# ------------------------------------------------------------------ 计划
def build_plan(paths: "list[str]", dest: str, opts: dict) -> dict:
    """生成导出计划：目标路径、体积、冲突、告警。不写任何文件。"""
    dest_root = Path(dest).expanduser()
    by_date = bool(opts.get("byDate", True))
    keep_dir = bool(opts.get("keepDirName", False))
    conflict = opts.get("conflict", "overwrite")
    if conflict not in CONFLICT_MODES:
        conflict = "overwrite"

    items = []
    warnings = []
    seen_targets = {}
    total = 0
    missing = 0
    skipped_proxy = 0

    for raw in paths:
        p = Path(raw)
        if p.suffix.lower() in PROXY_EXTS:
            skipped_proxy += 1
            continue
        if not is_source_file(p):
            continue
        if not p.exists():
            missing += 1
            warnings.append(f"源文件不存在：{raw}")
            continue
        try:
            size = p.stat().st_size
        except OSError as exc:
            missing += 1
            warnings.append(f"无法读取：{raw}（{exc}）")
            continue

        info = parse_filename(p)
        date = info.get("date") or "未知日期"
        parts = [dest_root]
        if by_date:
            parts.append(date)
        if keep_dir:
            parts.append(p.parent.name)
        target = Path(*parts) / p.name

        key = os.path.normcase(str(target))
        clash = "none"
        if key in seen_targets or target.exists():
            clash = "exists"
            if conflict == "rename":
                target = _unique_path(target)
                key = os.path.normcase(str(target))
        seen_targets[key] = True

        items.append({
            "src": str(p),
            "dst": str(target),
            "name": p.name,
            "size": size,
            "size_label": format_size(size),
            "date": date,
            "time": info.get("time") or "",
            "kind": "photo" if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".dng") else "video",
            "empty": size == 0,
            "clash": clash,
        })
        total += size

    dates = {}
    for it in items:
        d = dates.setdefault(it["date"], {"count": 0, "size": 0})
        d["count"] += 1
        d["size"] += it["size"]

    dest_ok, dest_error = _check_dest(dest_root)
    free = free_space(str(dest_root))
    enough = None if free is None else free > total * 1.02 + 64 * 1024 * 1024
    if enough is False:
        warnings.append(
            f"目标磁盘可用空间不足：需要约 {format_size(total)}，可用 {format_size(free)}")

    # 色彩还原导出：只对视频重新编码（照片本身颜色正常，不套 LUT）
    want_lut = bool(opts.get("lut")) and bool(config.lut_rel())
    video_items = [it for it in items if it["kind"] == "video" and not it["empty"]]
    if want_lut:
        if not video_items:
            warnings.append("勾选的素材里没有视频，色彩还原导出不会改变任何文件")
        else:
            warnings.append(
                f"色彩还原导出会**重新编码** {len(video_items)} 个视频（套 LUT 后 10bit HEVC），"
                "耗时大约是拷贝的几倍，文件体积也会变化；照片直接拷贝不套 LUT")
    for it in items:
        it["transcode"] = bool(want_lut and it["kind"] == "video" and not it["empty"])

    return {
        "ok": True,
        "dest": str(dest_root),
        "dest_ok": dest_ok,
        "dest_error": dest_error,
        "dest_exists": dest_root.exists(),
        "conflict": conflict,
        "byDate": by_date,
        "keepDirName": keep_dir,
        "lut": want_lut,
        "lut_name": (config.lut_info().get("name") if want_lut else None),
        "transcode_count": sum(1 for it in items if it["transcode"]),
        "items": items,
        "count": len(items),
        "total_size": total,
        "total_size_label": format_size(total),
        "dates": dates,
        "date_count": len(dates),
        "missing": missing,
        "skipped_proxy": skipped_proxy,
        "clash_count": sum(1 for it in items if it["clash"] == "exists"),
        "empty_count": sum(1 for it in items if it["empty"]),
        "free": free,
        "free_label": format_size(free) if free is not None else None,
        "enough_space": enough,
        "warnings": warnings[:20],
    }


def _check_dest(dest: Path) -> "tuple[bool, Optional[str]]":
    """目标目录是否可用于写入（不存在则检查其可创建性）。"""
    if dest.exists():
        if not dest.is_dir():
            return False, "目标路径已存在且不是文件夹"
        if not os.access(dest, os.W_OK):
            return False, "目标文件夹不可写"
        return True, None
    parent = dest
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    if not parent.exists():
        return False, "目标所在磁盘不存在"
    if not os.access(parent, os.W_OK):
        return False, f"没有权限在 {parent} 下创建文件夹"
    return True, None


# ------------------------------------------------------------------ 执行
def start(paths: "list[str]", dest: str, opts: Optional[dict] = None) -> dict:
    global _job_seq
    opts = dict(opts or {})
    plan = build_plan(paths, dest, opts)
    if not plan["dest_ok"]:
        raise ValueError(plan["dest_error"] or "目标文件夹不可用")

    with _jobs_lock:
        _job_seq += 1
        job_id = f"exp{_job_seq:04d}"
        job = {
            "id": job_id,
            "status": "running",       # running | done | cancelled | error
            "dest": plan["dest"],
            "total": plan["count"],
            "done": 0,
            "failed": 0,
            "bytes_total": plan["total_size"],
            "bytes_done": 0,
            "current": "",
            "log": [],
            "started": time.time(),
            "finished": None,
            "error": None,
            "results": [],
            "in_flight": {},
            "cancel": False,
            # 转码任务用「文件数 + 当前文件进度」算百分比：
            # 重新编码后体积和源文件完全不同，按字节算永远到不了 100%
            "mode": "transcode" if plan.get("transcode_count") else "copy",
            "transcode_total": plan.get("transcode_count", 0),
            "manifest": str(Path(plan["dest"]) / "_export_manifest.csv") if opts.get("manifest") else None,
        }
        _jobs[job_id] = job

    thread = threading.Thread(
        target=_run, args=(job_id, plan, opts), name=f"export-{job_id}", daemon=True)
    thread.start()
    return {"ok": True, "job": job_id, "plan": _plan_summary(plan), "dest": plan["dest"]}


def _plan_summary(plan: dict) -> dict:
    keep = ("count", "total_size", "total_size_label", "date_count", "dates",
            "missing", "clash_count", "enough_space", "free_label", "warnings")
    return {k: plan.get(k) for k in keep}


def _log(job: dict, msg: str) -> None:
    with _jobs_lock:
        job["log"].append(msg)
        if len(job["log"]) > 200:
            del job["log"][:100]


def _run(job_id: str, plan: dict, opts: dict) -> None:
    job = _jobs[job_id]
    dest_root = Path(plan["dest"])
    by_date = plan["byDate"]
    keep_dir = plan["keepDirName"]
    conflict = plan["conflict"]

    try:
        dest_root.mkdir(parents=True, exist_ok=True)
        if by_date:
            for date in plan["dates"]:
                (dest_root / date).mkdir(parents=True, exist_ok=True)
        if keep_dir:
            for it in plan["items"]:
                Path(it["dst"]).parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        with _jobs_lock:
            job["status"] = "error"
            job["error"] = f"创建目标文件夹失败：{exc}"
            job["finished"] = time.time()
        return

    _log(job, f"开始导出 {plan['count']} 个文件 → {dest_root}")

    def copy_one(item: dict) -> dict:
        if job["cancel"]:
            return {"src": item["src"], "dst": item["dst"], "ok": False, "skipped": True,
                    "error": "已取消"}
        src = Path(item["src"])
        dst = Path(item["dst"])
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists() and conflict == "skip":
                return {"src": item["src"], "dst": str(dst), "ok": True, "skipped": True,
                        "size": item["size"], "error": None}
            if dst.exists() and conflict == "rename":
                dst = _unique_path(dst)
            with _jobs_lock:
                job["current"] = item["name"]
                # 记录在处理的文件，progress() 靠它实时估算进度与速度。
                # 转码时输出体积和源文件对不上，改用 ffmpeg 的 out_time 比例 frac 算百分比。
                slot = {
                    "dst": str(dst), "size": item["size"],
                    "transcode": bool(item.get("transcode")), "frac": 0.0,
                }
                job.setdefault("in_flight", {})[item["name"]] = slot

            def _on_prog(value, slot=slot):
                with _jobs_lock:
                    slot["frac"] = value

            try:
                if item.get("transcode"):
                    # 色彩还原导出：重新编码并烘入 LUT（仅视频）
                    written = _transcode_file(src, dst, lambda: job["cancel"], _on_prog)
                else:
                    written = _copy_file(src, dst, lambda: job["cancel"])
                cancelled = False
            except _Cancelled:
                # 拷贝途中被取消：删掉半截文件，避免留下不完整的素材
                try:
                    dst.unlink(missing_ok=True)
                except OSError:
                    pass
                written, cancelled = 0, True
            finally:
                with _jobs_lock:
                    job.get("in_flight", {}).pop(item["name"], None)
            return {"src": item["src"], "dst": str(dst), "ok": not cancelled,
                    "skipped": cancelled, "size": written,
                    "error": "已取消（未完成）" if cancelled else None}
        except Exception as exc:  # 单个文件失败不影响整体
            with _jobs_lock:
                job.get("in_flight", {}).pop(item["name"], None)
            return {"src": item["src"], "dst": str(dst), "ok": False, "skipped": False,
                    "size": 0, "error": f"{type(exc).__name__}: {exc}"}

    with ThreadPoolExecutor(max_workers=COPY_WORKERS, thread_name_prefix="copy") as pool:
        for res in pool.map(copy_one, plan["items"]):
            with _jobs_lock:
                job["results"].append(res)
                if res["ok"]:
                    job["done"] += 1
                    job["bytes_done"] += res.get("size") or 0
                elif res.get("skipped"):
                    pass                     # 取消导致的中断不计入失败
                else:
                    job["failed"] += 1
                if job["cancel"]:
                    job["totals_note"] = "已取消，未处理完的文件被跳过"
            if job["cancel"]:
                break

    if job.get("manifest"):
        try:
            _write_manifest(Path(job["manifest"]), job["results"])
            _log(job, f"已写入清单 {job['manifest']}")
        except OSError as exc:
            _log(job, f"清单写入失败：{exc}")

    with _jobs_lock:
        job["status"] = "cancelled" if job["cancel"] else "done"
        job["finished"] = time.time()
        job["current"] = ""
    _log(job, f"完成：成功 {job['done']}，失败 {job['failed']}")


class _Cancelled(Exception):
    """拷贝途中收到取消请求。"""


def _probe_duration(path: Path) -> float:
    """拿素材时长（用于把 ffmpeg 的 out_time 换算成百分比）。"""
    try:
        meta = cache.get_meta(str(path))
        dur = float((meta or {}).get("duration") or 0)
        if dur > 0:
            return dur
    except Exception:
        pass
    try:
        tools = config.find_tools()
        proc = subprocess.run(
            [tools["ffprobe"], "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, timeout=60, **config.no_window_kwargs())
        return float((proc.stdout or b"0").decode("utf-8", "replace").strip() or 0)
    except Exception:
        return 0.0


def _transcode_file(src: Path, dst: Path, should_cancel=None, on_progress=None) -> int:
    """套 LUT 重新编码（只用于视频）；先写 .part，成功后改名，避免半成品被当成成品。

    on_progress(frac) 会把 ffmpeg 的 out_time 换算成 0~1 的进度——
    转码后的文件大小和源文件对不上，光看字节数算百分比会永远到不了 100%。
    """
    tools = config.find_tools()
    ff = tools.get("ffmpeg")
    if not ff:
        raise RuntimeError("找不到 ffmpeg，无法做色彩还原导出")
    rel = config.lut_rel()
    if not rel:
        raise RuntimeError("没有可用的 LUT")
    # 临时名保留原扩展名（放在后面会让 ffmpeg 猜不出容器格式）
    tmp = dst.with_name(f"{dst.stem}.part{dst.suffix}")
    duration = _probe_duration(src)
    cmd = [
        ff, "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-progress", "pipe:1", "-nostats",
        "-i", str(src),
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", f"lut3d={rel}",
        *ffmod.lut_encode_args(),
        "-c:a", "copy", "-movflags", "+faststart",
        str(tmp),
    ]
    proc = subprocess.Popen(
        cmd, cwd=str(config.ROOT),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        **config.no_window_kwargs(),
    )

    def _pump_progress(stream=proc.stdout) -> None:
        """把 ffmpeg 的 out_time_us 换算成 0~1 交给上层。"""
        if not stream or not on_progress or duration <= 0:
            return
        try:
            for raw in stream:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("out_time_us="):
                    continue
                try:
                    us = int(line.split("=", 1)[1] or 0)
                except ValueError:
                    continue
                on_progress(min(0.995, max(0.0, (us / 1e6) / duration)))
        except Exception:
            pass

    threading.Thread(target=_pump_progress, daemon=True, name="exp-progress").start()

    err = ""
    try:
        while proc.poll() is None:
            if should_cancel and should_cancel():
                proc.kill()
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                raise _Cancelled()
            time.sleep(0.15)
        if proc.stderr:
            err = (proc.stderr.read() or b"").decode("utf-8", "replace")
    finally:
        try:
            if proc.stderr:
                proc.stderr.close()
        except Exception:
            pass
    if proc.returncode != 0:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise RuntimeError(f"ffmpeg 转码失败(exit {proc.returncode}): {err.strip()[:180]}")
    try:
        tmp.replace(dst)
    except OSError:
        shutil.move(str(tmp), str(dst))
    if on_progress:
        on_progress(1.0)
    return dst.stat().st_size


def _copy_file(src: Path, dst: Path, should_cancel=None) -> int:
    """分块拷贝并保留时间戳；每块检查一次取消，保证"停止"能立刻生效。"""
    written = 0
    with open(src, "rb") as fh_in, open(dst, "wb") as fh_out:
        while True:
            if should_cancel and should_cancel():
                raise _Cancelled()
            chunk = fh_in.read(COPY_CHUNK)
            if not chunk:
                break
            fh_out.write(chunk)
            written += len(chunk)
    try:
        shutil.copystat(src, dst)
    except OSError:
        pass
    return written


def _write_manifest(path: Path, results: "list[dict]") -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(["状态", "源文件", "目标文件", "大小(字节)", "说明"])
        for r in results:
            writer.writerow([
                "跳过" if r.get("skipped") else ("成功" if r["ok"] else "失败"),
                r["src"], r["dst"], r.get("size") or 0, r.get("error") or "",
            ])


# ------------------------------------------------------------------ 查询
def progress(job_id: str) -> Optional[dict]:
    job = _jobs.get(job_id)
    if not job:
        return None
    with _jobs_lock:
        snapshot = dict(job)
        in_flight = list((job.get("in_flight") or {}).values())
    snapshot["log"] = snapshot["log"][-40:]
    snapshot["recent"] = snapshot.pop("results", [])[-8:]
    snapshot.pop("cancel", None)
    snapshot["elapsed"] = round((snapshot["finished"] or time.time()) - snapshot["started"], 1)

    # 已写字节 = 已完成 + 正在处理的那几个文件的实时进度
    done_bytes = snapshot["bytes_done"]
    live_bytes = 0
    for item in in_flight:
        try:
            part = os.path.getsize(item["dst"]) if os.path.exists(item["dst"]) else 0
        except OSError:
            part = 0
        # 转码输出的体积和源文件无关，不能按源大小截断
        live_bytes += part if item.get("transcode") else min(part, item["size"])
    written = done_bytes + live_bytes
    elapsed = max(0.001, (snapshot["finished"] or time.time()) - snapshot["started"])
    speed = written / elapsed
    remaining = max(0, snapshot["bytes_total"] - written)

    mode = snapshot.get("mode") or "copy"
    total_files = snapshot["total"] or 0
    if mode == "transcode" and total_files:
        # 进度按文件算，当前文件再用 ffmpeg 的 out_time 比例补齐
        partial = sum(min(0.995, max(0.0, (i.get("frac") or 0)))
                      for i in in_flight if i.get("transcode"))
        pct = min(100.0, (snapshot["done"] + partial) / total_files * 100)
        done_files = snapshot["done"]
        rate = done_files / elapsed if done_files else 0
        eta = (total_files - done_files - partial) / rate if rate > 0.0001 else None
        snap_eta = int(eta) if eta and eta < 24 * 3600 else None
    else:
        pct = written / snapshot["bytes_total"] * 100 if snapshot["bytes_total"] else 0.0
        snap_eta = None
        if snapshot["status"] == "running" and speed > 1024:
            eta = remaining / speed
            snap_eta = int(eta) if eta < 24 * 3600 else None

    snapshot["bytes_written"] = written
    snapshot["progress"] = round(min(100.0, pct), 1)
    snapshot["speed"] = int(speed)
    snapshot["speed_label"] = f"{format_size(int(speed))}/s" if speed > 1 else "-"
    snapshot["eta"] = snap_eta
    snapshot["eta_label"] = _duration_label(snap_eta)
    snapshot["failures"] = [
        {"src": r["src"], "dst": r["dst"], "error": r.get("error") or "未知错误"}
        for r in job.get("results", []) if not r.get("ok") and not r.get("skipped")
    ][:500]
    snapshot["failure_count"] = sum(
        1 for r in job.get("results", []) if not r.get("ok") and not r.get("skipped"))
    return snapshot


def _duration_label(seconds: Optional[float]) -> Optional[str]:
    if seconds is None:
        return None
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds} 秒"
    m, s = divmod(seconds, 60)
    if m < 60:
        return f"{m} 分 {s:02d} 秒"
    h, m = divmod(m, 60)
    return f"{h} 小时 {m:02d} 分"


def failure_report_csv(job_id: str) -> Optional[str]:
    """把失败明细导出成 CSV（UTF-8 BOM，Excel 直接打开）。"""
    job = _jobs.get(job_id)
    if not job:
        return None
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["结果", "源文件", "目标文件", "错误原因"])
    for r in job.get("results", []):
        if r.get("ok") or r.get("skipped"):
            continue
        writer.writerow(["失败", r["src"], r["dst"], r.get("error") or ""])
    if not any(not r.get("ok") and not r.get("skipped") for r in job.get("results", [])):
        writer.writerow(["(无失败)", "", "", ""])
    return buf.getvalue()


def cancel(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if not job:
        return {"ok": False, "error": "任务不存在"}
    job["cancel"] = True
    _log(job, "收到取消请求，正在停止…")
    return {"ok": True}


def list_jobs() -> dict:
    return {"ok": True, "jobs": [
        {"id": j["id"], "status": j["status"], "done": j["done"], "failed": j["failed"],
         "total": j["total"], "dest": j["dest"]} for j in list(_jobs.values())[-10:]
    ]}
