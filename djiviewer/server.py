"""HTTP 服务：REST API + 静态页面 + 支持 Range 的本地视频流。

只在 127.0.0.1 上监听，没有第三方依赖（Python 标准库 http.server）。
"""
from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

from . import cache, config, export, ffmpeg, scan
from .parser import format_size

CHUNK = 512 * 1024
ALLOWED_EXT = config.MEDIA_EXT | {".mp3", ".wav", ".srt", ".txt"}

_settings = {
    "recursive": True,
    "allowed_roots": [],      # 为空 = 允许本机所有已存在路径
    "last_folder": "",
    "play_mode": "direct",    # direct | auto-transcode
    "last_export_dest": "",
    "export_history": [],     # 最近用过的导出目录（最多 8 个）
}
_settings_lock = threading.Lock()
_build_version: Optional[str] = None


def asset_version() -> str:
    """静态资源版本戳（按源码 mtime 计算），用于强制刷新前端缓存。"""
    global _build_version
    if _build_version is None:
        _build_version = config.build_version()
    return _build_version


# ------------------------------------------------------------- 安全检查
def _load_settings() -> None:
    config.ensure_cache_dirs()
    if config.SETTINGS_FILE.exists():
        try:
            with open(config.SETTINGS_FILE, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                _settings.update({k: v for k, v in data.items() if k in _settings})
        except Exception:
            pass


def _save_settings() -> None:
    """持久化界面偏好；allowed_roots 属于临时安全策略，不落盘。"""
    try:
        with _settings_lock:
            snapshot = {k: v for k, v in _settings.items() if k != "allowed_roots"}
        with open(config.SETTINGS_FILE, "w", encoding="utf-8") as fh:
            json.dump(snapshot, fh, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _allowed_roots() -> "list[str]":
    """返回允许访问的根目录；空列表 = 不限制（默认，本机自用工具）。"""
    with _settings_lock:
        roots = list(_settings.get("allowed_roots") or [])
    if not roots:
        return []
    roots.append(str(config.ROOT))
    roots.append(str(config.CACHE_DIR))
    return [os.path.normcase(os.path.abspath(r)) for r in roots if r]


def resolve_media_path(raw: str) -> Path:
    """校验并解析客户端传来的路径，拒绝目录穿越与不允许的根目录。"""
    if not raw:
        raise PermissionError("缺少 path 参数")
    p = Path(urllib.parse.unquote(raw)).expanduser()
    try:
        p = p.resolve()
    except OSError as exc:
        raise PermissionError(f"路径无法解析: {exc}")
    roots = _allowed_roots()
    if roots:
        norm = os.path.normcase(str(p))
        if not any(norm == r or norm.startswith(r + os.sep) for r in roots):
            raise PermissionError("该路径不在允许访问的根目录内")
    return p


def _group_by_folder(files: "list[Path]") -> dict:
    groups: dict = {}
    for p in files:
        groups.setdefault(str(p.parent), []).append(p)
    return groups


def _reveal_many_win(files: "list[Path]") -> "tuple[bool, str]":
    """在同一个资源管理器窗口里一次选中多个文件。

    `explorer /select,` 只支持单选，多选用 shell 的 SHOpenFolderAndSelectItems：
    它接受「目录 PIDL + 一组子 PIDL」，正是"在资源管理器里选中这些文件"的官方做法。
    """
    import ctypes
    from ctypes import wintypes

    try:
        shell32 = ctypes.windll.shell32
        ole32 = ctypes.windll.ole32
    except AttributeError:
        return False, "非 Windows 环境"

    ole32.CoInitialize(None)
    try:
        shell32.SHParseDisplayName.argtypes = [
            wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
            wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        shell32.SHParseDisplayName.restype = ctypes.c_long
        shell32.ILFindLastID.argtypes = [ctypes.c_void_p]
        shell32.ILFindLastID.restype = ctypes.c_void_p
        shell32.SHOpenFolderAndSelectItems.argtypes = [
            ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD]
        shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long

        def parse(target):
            pidl = ctypes.c_void_p()
            attrs = wintypes.DWORD(0)
            hr = shell32.SHParseDisplayName(
                str(target), None, ctypes.byref(pidl), 0, ctypes.byref(attrs))
            return pidl if hr == 0 and pidl.value else None

        folder_pidl = parse(files[0].parent)
        if not folder_pidl:
            return False, "无法解析目录"
        abs_pidls = [pidl for pidl in (parse(f) for f in files) if pidl]
        if not abs_pidls:
            return False, "无法解析文件路径"
        # 同一目录下，绝对 PIDL 的最后一段就是相对该目录的子 PIDL；
        # 这些指针指向 abs_pidls 内部，只要它们还活着就有效。
        childs = [shell32.ILFindLastID(p) for p in abs_pidls]
        array = (ctypes.c_void_p * len(childs))(*childs)
        hr = shell32.SHOpenFolderAndSelectItems(folder_pidl, len(childs), array, 0)
        return (hr == 0), f"HRESULT=0x{hr & 0xFFFFFFFF:08X}"
    finally:
        ole32.CoUninitialize()


def _reveal_many(files: "list[Path]") -> "tuple[bool, str]":
    """选中一组文件；Windows 走 shell API，失败退回单选。"""
    if not files:
        return False, "没有文件"
    if os.name == "nt":
        try:
            ok, detail = _reveal_many_win(files)
        except Exception as exc:      # 任何 COM 异常都不能影响主流程
            ok, detail = False, repr(exc)
        if ok:
            return True, detail
        try:
            subprocess.Popen(["explorer", "/select,", str(files[0])],
                             **config.no_window_kwargs())
        except OSError:
            return False, detail
        return False, detail
    if sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(files[0])])
    else:
        subprocess.Popen(["xdg-open", str(files[0].parent)])
    return len(files) == 1, "系统默认方式只能定位第一个"


def _disposition(name: str) -> str:
    """附件头：ASCII 兜底 + RFC 5987 的 UTF-8 文件名（中文名才不会乱码）。"""
    ascii_name = name.encode("ascii", "ignore").decode("ascii") or "download"
    ascii_name = ascii_name.replace('"', "")
    return (f'attachment; filename="{ascii_name}"; '
            f"filename*=UTF-8''{urllib.parse.quote(name, safe='')}")


def _guess_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".mp4", ".m4v"):
        return "video/mp4"
    if ext == ".lrf":
        return "video/mp4"          # LRF 实际是 H.264 MP4 容器
    if ext == ".mov":
        return "video/quicktime"
    if ext in (".jpg", ".jpeg", ".scr", ".thm"):
        return "image/jpeg"         # SCR/THM 是相机写的标准 JPEG
    if ext == ".dng":
        return "image/x-adobe-dng"
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    server_version = f"DJIFootageViewer/{config.APP_VERSION}"
    protocol_version = "HTTP/1.1"
    quiet = True

    # ------------------------------------------------------- 基础工具
    def log_message(self, fmt, *args):  # noqa: A003
        if not Handler.quiet:
            config.log("[http] " + (fmt % args))

    def log_error(self, fmt, *args):
        if not Handler.quiet:
            config.log("[http:err] " + (fmt % args))

    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json; charset=utf-8",
              extra: Optional[dict] = None, head_only: bool = False) -> None:
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body and not head_only:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200, head_only: bool = False) -> None:
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8", head_only=head_only)

    def _error(self, code: int, message: str) -> None:
        self._json({"ok": False, "error": message}, code)

    def _query(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        return {"path": urllib.parse.unquote(parsed.path), "query": q, "raw_query": parsed.query}

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {"value": data}
        except Exception:
            return {}

    # ------------------------------------------------------------ 路由
    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_HEAD(self):  # noqa: N802
        self._handle("HEAD")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def _handle(self, method: str) -> None:
        try:
            req = self._query()
            path = req["path"]
            if path.startswith("/_api/"):
                self._api(method, path, req)
            elif path.startswith("/_thumb/"):
                self._serve_thumb(req)
            elif path.startswith("/_media/"):
                self._serve_media(req, method)
            elif path.startswith("/_live/"):
                self._serve_live(req, method)
            elif path.startswith("/_photo/"):
                self._serve_photo(req, method)
            elif path.startswith("/_export/"):
                self._export(method, req)
            elif path.startswith("/favicon.ico"):
                self._serve_static("/favicon.svg", method)
            else:
                self._serve_static(path, method)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except PermissionError as exc:
            self._error(403, str(exc))
        except FileNotFoundError as exc:
            self._error(404, str(exc))
        except (NotADirectoryError, ValueError) as exc:
            self._error(400, str(exc))
        except Exception as exc:  # 兜底，避免单个请求打挂服务
            config.log(f"[http] 未处理异常 {self.path}: {exc!r}")
            try:
                self._error(500, f"{type(exc).__name__}: {exc}")
            except Exception:
                pass

    # -------------------------------------------------------------- API
    def _api(self, method: str, path: str, req: dict) -> None:
        q = req["query"]
        if path == "/_api/ping":
            return self._json({"ok": True, "app": config.APP_NAME, "version": config.APP_VERSION})

        if path == "/_api/info":
            tools = config.find_tools()
            cache.load()
            return self._json({
                "ok": True,
                "app": config.APP_NAME,
                "version": config.APP_VERSION,
                "build": asset_version(),
                "python": sys.version.split()[0],
                "ffmpeg": tools.get("version"),
                "ffmpeg_path": tools.get("ffmpeg"),
                "ffprobe_path": tools.get("ffprobe"),
                "tools_error": tools.get("error"),
                "cache": cache.stats(),
                "settings": {k: v for k, v in _settings.items() if k != "allowed_roots"},
                "roots": scan.list_roots(_settings.get("last_folder") or "").get("roots", []),
                "cache_dir": str(config.CACHE_DIR),
            })

        if path == "/_api/scan":
            folder = q.get("folder") or _settings.get("last_folder") or ""
            recursive = q.get("recursive", "1") not in ("0", "false", "False")
            force = q.get("force") in ("1", "true", "True")
            if not folder:
                return self._error(400, "缺少 folder 参数")
            p = resolve_media_path(folder)
            cache.load()
            result = scan.scan(str(p), recursive=recursive, force=force)
            with _settings_lock:
                _settings["last_folder"] = str(p)
                _settings["recursive"] = recursive
            _save_settings()
            result["ok"] = True
            # analyze=0：只出图，不预先 ffprobe（按需分析，避免扫描后 CPU 打满）
            analyze = q.get("analyze")
            auto_analyze = True if analyze is None else analyze not in ("0", "false", "False", "")
            queued = 0
            if auto_analyze and result["needs_probe"]:
                queued = cache.enqueue(result["needs_probe"], generation=str(p))
            # 参数已缓存、但还没有缩略图的素材：单独排进"出图"队列（纯复制，很轻）
            need_thumb = [
                c.get("video_path") or c.get("photo_path") or c.get("proxy_path") or c.get("path")
                for c in result["clips"] if not c.get("thumb")
            ]
            need_thumb = [x for x in need_thumb if x]
            if need_thumb:
                cache.warm_thumbs(need_thumb)
            result["auto_analyze"] = auto_analyze
            result["queued_for_analysis"] = queued   # 本次扫描真正排进分析队列的文件数
            result["progress"] = cache.progress()
            return self._json(result)

        if path == "/_api/meta":
            cache.load()
            if method == "POST":
                payload = self._body()
                paths = payload.get("paths") or []
                enqueue = payload.get("enqueue", True)
                if enqueue and paths:
                    cache.enqueue([str(x) for x in paths])
            else:
                paths = [p for p in q.get("path", "").split("|") if p]
            out = {}
            pending = 0
            for raw in paths:
                try:
                    p = resolve_media_path(str(raw))
                except PermissionError:
                    continue
                meta = cache.get_meta(str(p))
                if meta:
                    out[str(raw)] = scan._shrink(meta)
                else:
                    pending += 1
            return self._json({"ok": True, "meta": out, "pending": pending,
                               "progress": cache.progress()})

        if path == "/_api/progress":
            return self._json({"ok": True, "progress": cache.progress(), "cache": cache.stats()})

        if path == "/_api/thumb_status":
            # 缩略图阶段专用：告诉前端"这些路径的图已经能看了"，用于边生成边贴图
            if method == "POST":
                payload = self._body()
                paths = [str(x) for x in (payload.get("paths") or [])]
            else:
                paths = [p for p in q.get("path", "").split("|") if p]
            ready = {}
            for raw in paths:
                try:
                    p = resolve_media_path(raw)
                except PermissionError:
                    continue
                if cache.thumb_ready(str(p)):
                    ready[raw] = cache.thumb_name(str(p))
            return self._json({"ok": True, "ready": ready, "checked": len(paths),
                               "progress": cache.progress()})

        if path == "/_api/probe":  # 单文件深度探测（详情面板用，含完整信息）
            raw = q.get("path") or ""
            p = resolve_media_path(raw)
            # wait=1：同步分析（"点开才分析"模式，返回时就有参数）
            if q.get("wait") in ("1", "true", "True"):
                try:
                    meta = cache.probe_now(str(p))
                except Exception as exc:
                    return self._error(500, f"分析失败: {exc}")
                return self._json({"ok": True, "pending": False, "meta": meta})
            meta = cache.get_meta(str(p))
            if not meta:
                cache.enqueue([str(p)])
                return self._json({"ok": True, "pending": True})
            return self._json({"ok": True, "pending": False, "meta": meta})

        if path == "/_api/frames":  # 时间轴挑帧
            raw = q.get("path") or ""
            ts = float(q.get("t") or 0)
            width = int(q.get("w") or 320)
            p = resolve_media_path(raw)
            data = ffmpeg.grab_frames(str(p), ts, width=width)
            if not data:
                return self._error(404, "取帧失败")
            return self._send(200, data, "image/jpeg")

        if path == "/_api/cache/purge":
            if method != "POST":
                return self._error(405, "请用 POST")
            return self._json(dict(cache.purge(), ok=True))

        if path == "/_api/reveal_many":
            # 把一批勾选的文件在同一个资源管理器窗口里选中
            if method == "POST":
                payload = self._body()
                raw_paths = [str(x) for x in (payload.get("paths") or [])]
            else:
                raw_paths = [p for p in (q.get("path") or "").split("|") if p]
            files = []
            for raw in raw_paths:
                try:
                    p = resolve_media_path(raw)
                except PermissionError:
                    continue
                if p.exists() and p.is_file():
                    files.append(p)
            if not files:
                return self._error(404, "没有可定位的文件")
            groups = _group_by_folder(files)
            folder, members = max(groups.items(), key=lambda kv: len(kv[1]))
            plan = {
                "folder": folder,
                "names": [m.name for m in members],
                "count": len(members),
                "skipped": len(files) - len(members),
                "folder_count": len(groups),
            }
            if q.get("dry") in ("1", "true", "True"):
                return self._json({"ok": True, "dry": True, "plan": plan})
            ok, detail = _reveal_many(members)
            return self._json({"ok": True, "selected": len(members) if ok else 1,
                               "multi": ok, "detail": detail, **plan})

        if path == "/_api/reveal":
            raw = q.get("path") or ""
            p = resolve_media_path(raw)
            if not p.exists():
                return self._error(404, "文件不存在")
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select,", str(p)],
                                 **config.no_window_kwargs())
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", str(p)])
            else:
                subprocess.Popen(["xdg-open", str(p.parent)])
            return self._json({"ok": True})

        if path == "/_api/open":
            raw = q.get("path") or ""
            p = resolve_media_path(raw)
            if not p.exists():
                return self._error(404, "文件不存在")
            try:
                if os.name == "nt":
                    os.startfile(str(p))  # noqa: S606
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", str(p)])
                else:
                    subprocess.Popen(["xdg-open", str(p)])
            except Exception as exc:
                return self._error(500, f"无法打开: {exc}")
            return self._json({"ok": True})

        if path == "/_api/delete":
            if method != "POST":
                return self._error(405, "请用 POST")
            payload = self._body()
            paths = [str(x) for x in (payload.get("paths") or [])]
            if not paths:
                return self._error(400, "缺少 paths")
            if not payload.get("confirm"):
                return self._error(400, "需要 confirm=true 才执行删除")
            results = []
            for raw in paths:
                try:
                    p = resolve_media_path(raw)
                    if p.exists():
                        size = p.stat().st_size
                        p.unlink()
                        results.append({"path": raw, "ok": True, "freed": size})
                    else:
                        results.append({"path": raw, "ok": False, "error": "不存在"})
                except Exception as exc:
                    results.append({"path": raw, "ok": False, "error": str(exc)})
            return self._json({"ok": True, "results": results})

        if path == "/_api/export":  # 导出（转存）原始素材
            if method != "POST":
                return self._error(405, "请用 POST")
            payload = self._body()
            raw_paths = [str(x) for x in (payload.get("paths") or [])]
            dest = str(payload.get("dest") or "").strip()
            opts = {
                "byDate": payload.get("byDate", True),
                "keepDirName": payload.get("keepDirName", False),
                "conflict": payload.get("conflict", "overwrite"),
                "manifest": payload.get("manifest", True),
            }
            if not raw_paths:
                return self._error(400, "没有要导出的文件")
            if not dest:
                return self._error(400, "请先选择目标文件夹")
            dest_path = resolve_media_path(dest)
            paths = []
            for raw in raw_paths:
                try:
                    paths.append(str(resolve_media_path(raw)))
                except PermissionError:
                    continue
            if payload.get("dryRun"):
                return self._json(export.build_plan(paths, str(dest_path), opts))
            try:
                result = export.start(paths, str(dest_path), opts)
            except ValueError as exc:
                return self._error(400, str(exc))
            with _settings_lock:
                _settings["last_export_dest"] = str(dest_path)
                hist = [h for h in (_settings.get("export_history") or [])
                        if os.path.normcase(h) != os.path.normcase(str(dest_path))]
                hist.insert(0, str(dest_path))
                _settings["export_history"] = hist[:8]
            _save_settings()
            return self._json(result)

        if path == "/_api/export/report":  # 失败明细 CSV
            job_id = q.get("job") or ""
            csv_text = export.failure_report_csv(job_id)
            if csv_text is None:
                return self._error(404, "任务不存在")
            data = ("\ufeff" + csv_text).encode("utf-8")
            stamp = time.strftime("%Y%m%d_%H%M%S")
            return self._send(200, data, "text/csv; charset=utf-8", extra={
                "Content-Disposition": f'attachment; filename="dji_export_failures_{stamp}.csv"'})

        if path == "/_api/export/progress":
            job_id = q.get("job") or ""
            snap = export.progress(job_id)
            if not snap:
                return self._error(404, "任务不存在")
            return self._json({"ok": True, "job": snap})

        if path == "/_api/export/cancel":
            if method != "POST":
                return self._error(405, "请用 POST")
            return self._json(export.cancel(str(self._body().get("job") or "")))

        if path == "/_api/browse":  # 目录浏览（网页版"选择文件夹"）
            raw = q.get("path") or ""
            current = resolve_media_path(raw) if raw else Path.home()
            if not current.exists() or not current.is_dir():
                return self._error(404, f"目录不存在：{current}")
            dirs = []
            files = 0
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name in config.IGNORE_DIRS or entry.name.startswith("."):
                                    continue
                                dirs.append({"name": entry.name, "path": entry.path})
                            elif entry.is_file(follow_symlinks=False):
                                files += 1
                        except OSError:
                            continue
            except OSError as exc:
                return self._error(403, f"无法读取该目录：{exc}")
            dirs.sort(key=lambda d: d["name"].lower())
            parent = current.parent
            free = export.free_space(str(current))
            return self._json({
                "ok": True,
                "path": str(current),
                "parent": str(parent) if parent != current else None,
                "dirs": dirs[:400],
                "dir_count": len(dirs),
                "file_count": files,
                "free": free,
                "free_label": format_size(free),
                "writable": os.access(str(current), os.W_OK),
                "roots": self._drives(),
            })

        if path == "/_api/suggest_dest":  # 建议的导出目标目录
            folder = q.get("folder") or _settings.get("last_folder") or ""
            cands = []
            if folder:
                try:
                    src = resolve_media_path(folder)
                    parent = src.parent if src.parent != src else src
                    cands.append(str(parent / f"{src.name}_export"))
                    cands.append(str(parent / "DJI_export"))
                except PermissionError:
                    pass
            for extra in (Path.home() / "Videos", Path.home() / "Desktop", Path.home() / "Downloads"):
                if extra.is_dir():
                    cands.append(str(extra / "DJI_export"))
            seen = set()
            uniq = []
            for c in cands:
                key = os.path.normcase(c)
                if key in seen:
                    continue
                seen.add(key)
                p = Path(c)
                base = p if p.exists() else p.parent
                free = export.free_space(str(base))
                uniq.append({"path": c, "exists": p.exists(),
                             "free_label": format_size(free)})
            return self._json({
                "ok": True,
                "candidates": uniq[:6],
                "last": _settings.get("last_export_dest") or "",
                "history": list(_settings.get("export_history") or [])[:6],
            })

        return self._error(404, f"未知接口 {path}")

    def _drives(self) -> "list[dict]":
        """列出磁盘根目录（供目录浏览器使用）。"""
        out = []
        if os.name == "nt":
            import ctypes

            try:
                mask = ctypes.windll.kernel32.GetLogicalDrives()
            except Exception:
                mask = 0
            for i in range(26):
                if (mask >> i) & 1:
                    letter = chr(65 + i)
                    root = f"{letter}:\\"
                    if os.path.isdir(root):
                        out.append({"name": f"{letter}:", "path": root})
        else:
            out.append({"name": "/", "path": "/"})
            if Path.home().is_dir():
                out.append({"name": "~", "path": str(Path.home())})
        return out

    # -------------------------------------------------------- 缩略图
    def _serve_thumb(self, req: dict) -> None:
        name = posixpath.basename(req["path"][len("/_thumb/"):])
        # 缩略图文件名可能是生成的（hash.jpg），也可能是相机自带的 SCR/THM（原名直出）
        if not re.fullmatch(r"[\w.\- ]+\.(?:jpg|jpeg|scr|thm)", name or "", re.IGNORECASE):
            return self._error(400, "非法缩略图名")
        target = (config.THUMB_DIR / name).resolve()
        if config.CACHE_DIR.resolve() not in target.parents:
            return self._error(403, "越权访问")
        if not target.exists():
            # 回退：相机自带的预览图（SCR/THM）就在素材旁边，直接原图直出
            fallback = self._preview_sibling(req["query"].get("path"), name)
            if fallback:
                return self._send_file(fallback, "image/jpeg", cache_ok=True)
            return self._error(404, "缩略图尚未生成")
        self._send_file(target, "image/jpeg", cache_ok=True)

    @staticmethod
    def _preview_sibling(raw_path: Optional[str], name: str):
        """在素材所在目录里找同名预览图，用于"只拷了 SCR/THM"或缓存未生成的情况。"""
        if not raw_path or not name:
            return None
        try:
            p = resolve_media_path(raw_path)
        except PermissionError:
            return None
        cand = p.parent / name
        try:
            if cand.exists() and cand.is_file() and cand.suffix.lower() in config.PREVIEW_EXT:
                return cand
        except OSError:
            pass
        return None

    # ------------------------------------------- 图片直出（照片 / SCR / THM）
    def _serve_photo(self, req: dict, method: str) -> None:
        raw = req["path"][len("/_photo/"):]
        p = resolve_media_path(raw)
        if not p.exists():
            return self._error(404, "文件不存在")
        # SCR / THM 也是标准 JPEG，可直接当图片提供
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".scr", ".thm"):
            return self._error(415, "非图片文件")
        self._send_file(p, _guess_type(p), method=method, cache_ok=True)

    # -------------------------------------------------------- 视频流
    def _serve_media(self, req: dict, method: str) -> None:
        raw = req["path"][len("/_media/"):]
        p = resolve_media_path(raw)
        if not p.exists() or not p.is_file():
            return self._error(404, "文件不存在")
        if p.suffix.lower() not in ALLOWED_EXT:
            return self._error(415, "不支持的文件类型")
        try:
            size = p.stat().st_size
        except OSError as exc:
            return self._error(500, str(exc))
        if size == 0:
            return self._error(409, "文件为 0 字节，无法播放")
        # dl=1：以附件形式返回，供"从浏览器拖到资源管理器"时浏览器正确落盘
        extra = {}
        if req["query"].get("dl") in ("1", "true", "True"):
            extra["Content-Disposition"] = _disposition(p.name)
        self._stream_range(p, size, _guess_type(p), method, extra=extra)

    def _serve_live(self, req: dict, method: str) -> None:
        """实时转码流（fMP4），用于浏览器无法直接解码的素材。"""
        raw = req["path"][len("/_live/"):]
        p = resolve_media_path(raw)
        if not p.exists():
            return self._error(404, "文件不存在")
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for chunk in ffmpeg.transcode_stream(str(p)):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass
        except Exception as exc:
            config.log(f"[live] 转码失败 {p}: {exc!r}")
        try:
            self.close_connection = True
        except Exception:
            pass

    # ------------------------------------------------------ Range 发送
    def _stream_range(self, p: Path, size: int, ctype: str, method: str,
                      extra: Optional[dict] = None) -> None:
        start, end = 0, size - 1
        partial = False
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m:
                g1, g2 = m.group(1), m.group(2)
                if g1 == "" and g2:
                    start = max(0, size - int(g2))
                    end = size - 1
                else:
                    start = int(g1 or 0)
                    if g2:
                        end = min(int(g2), size - 1)
                if start > end or start >= size:
                    self._send(416, b"", ctype,
                               extra={"Content-Range": f"bytes */{size}"})
                    return
                partial = True

        length = end - start + 1
        try:
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if method == "HEAD":
                return
            with open(p, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self.close_connection = True

    def _send_file(self, p: Path, ctype: str, method: str = "GET", cache_ok: bool = False) -> None:
        try:
            size = p.stat().st_size
        except OSError as exc:
            return self._error(500, str(exc))
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400" if cache_ok else "no-store")
            self.end_headers()
            if method == "HEAD":
                return
            with open(p, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, CHUNK)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            self.close_connection = True

    # -------------------------------------------------------- CSV 导出
    def _export(self, method: str, req: dict) -> None:
        cache.load()
        if method == "POST":
            payload = self._body()
            paths = [str(x) for x in (payload.get("paths") or [])]
        else:
            paths = [x for x in req["query"].get("path", "").split("|") if x]
        rows = []
        for raw in paths:
            try:
                p = resolve_media_path(raw)
            except PermissionError:
                continue
            meta = cache.get_meta(str(p)) or {}
            rows.append((raw, meta))

        import csv
        import io

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "文件名", "拍摄日期", "拍摄时间", "分辨率", "宽", "高", "帧率",
            "编码", "位深", "色彩/HDR", "时长(秒)", "时长", "码率(Mbps)",
            "大小(字节)", "大小", "有LRF代理", "音频", "文件路径", "探测状态",
        ])
        for raw, m in rows:
            p = Path(raw)
            stem = p.stem
            parts = stem.split("_")
            stamp = parts[1] if len(parts) > 1 and parts[1].isdigit() and len(parts[1]) == 14 else ""
            date = f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}" if stamp else ""
            time_s = f"{stamp[8:10]}:{stamp[10:12]}:{stamp[12:14]}" if stamp else ""
            dur = m.get("duration")
            writer.writerow([
                p.name, date, time_s, m.get("resolution", ""), m.get("width", ""),
                m.get("height", ""), m.get("fps_label", ""), m.get("codec_label", ""),
                m.get("bit_depth", ""),
                ("HDR" if m.get("hdr") else "") or (m.get("profile") or ""),
                f"{dur:.2f}" if isinstance(dur, (int, float)) else "",
                _fmt_dur(dur), f"{(m.get('bit_rate') or 0)/1e6:.1f}" if m.get("bit_rate") else "",
                m.get("size", p.stat().st_size if p.exists() else ""),
                "",
                "", "有" if m.get("has_audio") else "",
                str(p), "OK" if m.get("ok") else (m.get("error") or "未探测"),
            ])
        data = ("\ufeff" + buf.getvalue()).encode("utf-8")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        self._send(200, data, "text/csv; charset=utf-8",
                   extra={"Content-Disposition": f'attachment; filename="dji_export_{stamp}.csv"'})

    # -------------------------------------------------------- 静态文件
    def _serve_static(self, url_path: str, method: str) -> None:
        rel = posixpath.normpath(urllib.parse.unquote(url_path)).lstrip("/")
        if rel in ("", "."):
            rel = "index.html"
        target = (config.STATIC_DIR / rel).resolve()
        try:
            if config.STATIC_DIR.resolve() not in target.parents and target != config.STATIC_DIR.resolve():
                return self._error(403, "越权访问")
        except Exception:
            return self._error(403, "越权访问")
        if not target.exists() or not target.is_file():
            return self._error(404, f"未找到 {rel}")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"

        # 首页：把 JS 导入图整体打上版本戳，避免浏览器拿旧模块
        if rel == "index.html":
            try:
                text = target.read_text(encoding="utf-8")
            except OSError as exc:
                return self._error(500, str(exc))
            text = stamp_assets(text, asset_version())
            return self._send(200, text.encode("utf-8"), ctype,
                              extra={"Cache-Control": "no-store"})
        self._send_file(target, ctype, method=method, cache_ok=False)


ASSET_RE = re.compile(
    r'(?P<attr>\b(?:src|href))="(?P<url>/(?:js|css)/[^"?]+)"'
    r'|/\*ASSET_VERSION\*/(?P<ver>null|"[^"]*")'
)


def stamp_assets(html: str, version: str) -> str:
    """给首页里的静态资源与前端模块入口打版本戳。

    * `/js/x.js`、`/css/x.css` 形式的 src/href 直接加 ?v=
    * `/*ASSET_VERSION*/null` 占位符替换成真实版本（前端据此动态 import 带戳的模块入口）

    这样每次服务重启（源码有改动 → mtime 变化）都会得到新的 URL，浏览器不可能再拿旧缓存。
    """
    stamp = f'"{version}"'
    return ASSET_RE.sub(
        lambda m: (f'{m.group("attr")}="{m.group("url")}?v={version}"'
                   if m.group("attr") else f'/*ASSET_VERSION*/{stamp}'),
        html,
    )


def _fmt_dur(value) -> str:
    try:
        secs = int(round(float(value)))
    except (TypeError, ValueError):
        return ""
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class _Server(ThreadingHTTPServer):
    """Windows 专用绑定策略。

    默认的 SO_REUSEADDR 在 Windows 上语义不同：它允许**第二个实例抢占同一端口**
    （两个服务同时监听、请求随机命中），端口冲突也就检测不到。
    所以 Windows 用 SO_EXCLUSIVEADDRUSE 独占端口；两者互斥，不能同时设置，
    父类的 server_bind() 只在 allow_reuse_address 为真时才会设 SO_REUSEADDR。
    """
    daemon_threads = True
    allow_reuse_address = not (os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"))
    _exclusive = os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE")

    def server_bind(self):
        if self._exclusive:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()


def serve(host: str = config.DEFAULT_HOST, port: int = config.DEFAULT_PORT,
          quiet: bool = True, open_browser: bool = True,
          folder: str = "", allowed_roots: Optional[list] = None) -> None:
    config.ensure_cache_dirs()
    # 先绑端口：失败就直接抛 OSError，让调用方（--port-tries）干净地换下一个端口，
    # 不会出现"横幅打印了但其实没启动"的误导输出。
    httpd = _Server((host, port), Handler)
    httpd.daemon_threads = True

    _load_settings()
    if allowed_roots:
        with _settings_lock:
            _settings["allowed_roots"] = [str(r) for r in allowed_roots]
        _save_settings()
    if folder:
        with _settings_lock:
            _settings["last_folder"] = folder
    cache.load()
    tools = config.find_tools()
    if tools.get("error"):
        config.log(f"[warn] {tools['error']}")
    Handler.quiet = quiet

    url = f"http://{host}:{port}/"
    banner = f"""
  ╭──────────────────────────────────────────────╮
  │   DJI Footage Viewer  v{config.APP_VERSION}                    │
  │   素材目录 : {(_settings.get('last_folder') or '(未指定，界面内选择)'):<32}│
  │   服务地址 : {url:<32}│
  │   静态版本 : {asset_version():<32}│
  │   缓存目录 : {str(config.CACHE_DIR):<32}│
  ╰──────────────────────────────────────────────╯
  按 Ctrl+C 停止服务
"""
    config.log(banner.strip())
    if open_browser:
        def _open():
            time.sleep(0.6)
            try:
                import webbrowser

                webbrowser.open(url)
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        config.log("\n[server] 收到中断，正在退出…")
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        cache.flush()
