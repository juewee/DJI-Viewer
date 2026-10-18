"""全局配置、常量与 ffmpeg 工具定位。

不依赖任何第三方库：整个项目只用 Python 标准库 + 外部 ffmpeg/ffprobe。
"""
from __future__ import annotations

import functools
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

APP_NAME = "DJI Footage Viewer"
APP_VERSION = "1.0.0"

# 静态资源版本戳：前端用它做 cache-busting，改了代码让浏览器必然重新拉取
ASSET_VERSION = "1.0.0"


def build_version() -> str:
    """按源码最新修改时间生成版本号——服务重启后必然变化。"""
    newest = 0.0
    for path in (STATIC_DIR.rglob("*") if STATIC_DIR.exists() else []):
        try:
            if path.is_file():
                newest = max(newest, path.stat().st_mtime)
        except OSError:
            continue
    if not newest:
        newest = time.time()
    return f"{APP_VERSION}.{int(newest)}"

# 项目根目录（djiviewer/），cache / 静态资源都相对于它
ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "web"
CACHE_DIR = ROOT / "cache"
THUMB_DIR = CACHE_DIR / "thumbs"
PROBE_CACHE_FILE = CACHE_DIR / "probe_cache.json"
SETTINGS_FILE = CACHE_DIR / "settings.json"
LOG_FILE = CACHE_DIR / "server.log"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8777

# ---- 色彩 LUT（D-Log M → Rec.709）--------------------------------------
# 把项目里的 .cube 复制到 cache/lut/active.cube，ffmpeg 就能用**相对路径**引用它，
# 避开 Windows 盘符冒号在 filtergraph 里的转义地狱。
LUT_DIR = CACHE_DIR / "lut"
LUT_NAME = "active.cube"
_LUT_MARKER = LUT_DIR / "source.txt"


def find_lut_source() -> "Optional[Path]":
    """在项目根目录、luts/、assets/luts/ 里找第一个 .cube。"""
    for base in (ROOT, ROOT / "luts", ROOT / "assets" / "luts", ROOT / "assets"):
        try:
            if not base.is_dir():
                continue
        except OSError:
            continue
        for f in sorted(base.glob("*.cube")):
            try:
                if f.is_file() and f.stat().st_size > 256:
                    return f
            except OSError:
                continue
    return None


def lut_rel() -> "Optional[str]":
    """返回给 ffmpeg 用的相对路径（相对 ROOT），没有 LUT 时返回 None。"""
    src = find_lut_source()
    if not src:
        return None
    dest = LUT_DIR / LUT_NAME
    try:
        sig = f"{src.name}|{src.stat().st_size}|{int(src.stat().st_mtime)}"
        old = _LUT_MARKER.read_text(encoding="utf-8").strip() if _LUT_MARKER.exists() else ""
        if old != sig or not dest.exists() or dest.stat().st_size != src.stat().st_size:
            LUT_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            _LUT_MARKER.write_text(sig, encoding="utf-8")
    except OSError as exc:
        log(f"[lut] 复制 LUT 失败: {exc}")
        return None
    return f"cache/lut/{LUT_NAME}"


def lut_info() -> dict:
    src = find_lut_source()
    rel = lut_rel()
    return {
        "available": bool(rel),
        "name": src.name if src else None,
        "rel": rel,
        "size": src.stat().st_size if src else 0,
    }

# ---- 文件类型 ----------------------------------------------------------
VIDEO_EXT = {".mp4", ".mov"}
PROXY_EXT = {".lrf"}
PHOTO_EXT = {".jpg", ".jpeg", ".dng"}
# DJI 相机自带的预览图：SCR = 1280x720，THM = 256x144，都是标准 JPEG。
# 直接拿它当缩略图，省掉 ffmpeg 解码抽帧（4K/8K HEVC 素材收益最明显）。
PREVIEW_EXT = {".scr", ".thm"}
MEDIA_EXT = VIDEO_EXT | PROXY_EXT | PHOTO_EXT | PREVIEW_EXT
# 扫描时忽略的目录
IGNORE_DIRS = {".djiviewer-cache", "__pycache__", "$RECYCLE.BIN", "System Volume Information"}

# ---- 探测 / 缩略图参数 --------------------------------------------------
# 并发越高越快，但会明显抢 CPU（实测 8 并发时整机 CPU 冲到 80%）。
# 默认按需分析，只需要很小的并发；用户切到"全部分析"时也是这个数，避免卡机。
PROBE_WORKERS = 3              # 后台并发线程数
FFPROBE_ANALYZE_US = 1_000_000  # 1s，足够读到 moov，又不会拖慢大文件
FFPROBE_PROBE_SIZE = 2_000_000
THUMB_WIDTH = 512
THUMB_QUALITY = 4              # ffmpeg -q:v 2..6，4 ≈ 高质量且体积小
FFMPEG_TIMEOUT = 120           # 单次 ffmpeg 调用上限(秒)
FFPROBE_TIMEOUT = 60


def _no_window_kwargs() -> dict:
    """Windows 下隐藏子进程控制台窗口。"""
    if os.name == "nt":
        return {"creationflags": 0x08000000}  # CREATE_NO_WINDOW
    return {}


def _test_tool(exe: str) -> bool:
    try:
        subprocess.run(
            [exe, "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=True,
            **_no_window_kwargs(),
        )
        return True
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def find_tools() -> dict:
    """定位 ffmpeg / ffprobe：环境变量 PATH 优先，其次常见安装位置。"""
    result = {"ffmpeg": None, "ffprobe": None, "version": None, "error": None}

    candidates = []
    env_dir = os.environ.get("FFMPEG_HOME") or os.environ.get("FFMPEG_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    # 项目内置
    candidates.append(ROOT / "bin")
    # PATH
    for name in ("ffmpeg", "ffprobe"):
        p = shutil.which(name)
        if p:
            candidates.append(Path(p).parent)
    # 常见位置
    for p in (
        r"C:\ffmpeg\bin",
        r"C:\Program Files\ffmpeg\bin",
        r"D:\tools\ffmpeg\bin",
        r"D:\losheep\tools\ffmpeg\bin",
    ):
        candidates.append(Path(p))

    seen = set()
    for d in candidates:
        try:
            key = str(d).lower()
        except Exception:
            continue
        if key in seen or not d or not d.exists():
            continue
        seen.add(key)
        for exe_name, slot in (("ffmpeg.exe", "ffmpeg"), ("ffmpeg", "ffmpeg"),
                               ("ffprobe.exe", "ffprobe"), ("ffprobe", "ffprobe")):
            if result[slot]:
                continue
            cand = d / exe_name
            if cand.exists() and cand.is_file() and _test_tool(str(cand)):
                result[slot] = str(cand)

    if result["ffmpeg"] is None or result["ffprobe"] is None:
        result["error"] = (
            "未找到可用的 ffmpeg/ffprobe。请把它们加入 PATH，"
            "或设置环境变量 FFMPEG_HOME 指向 bin 目录，"
            f"或把可执行文件放到 {ROOT / 'bin'}。"
        )
    else:
        try:
            out = subprocess.run(
                [result["ffmpeg"], "-version"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=20, text=True, encoding="utf-8", errors="replace",
                **_no_window_kwargs(),
            ).stdout
            first = (out or "").splitlines()[0] if out else ""
            result["version"] = first.strip()
        except Exception:
            pass
    return result


def ensure_cache_dirs() -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def no_window_kwargs() -> dict:
    return _no_window_kwargs()


def log(msg: str) -> None:
    try:
        ensure_cache_dirs()
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(msg.rstrip() + "\n")
    except Exception:
        pass
    try:
        print(msg, flush=True)
    except Exception:
        pass
