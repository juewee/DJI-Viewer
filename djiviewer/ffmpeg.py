"""ffmpeg / ffprobe 调用封装：媒体探测、缩略图、照片尺寸、实时转码。"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Iterator, Optional

from . import config
from .parser import classify_resolution, codec_label, fps_label, is_hdr, parse_fraction

VIDEO_ARGS = [
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-select_streams", "v:0",
    "-analyzeduration", str(config.FFPROBE_ANALYZE_US),
    "-probesize", str(config.FFPROBE_PROBE_SIZE),
]


def _run(cmd: list, timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        **config.no_window_kwargs(),
    )


def _decode(data: bytes) -> str:
    if not data:
        return ""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def probe_json(path: str, kind: str = "video") -> dict:
    """调用 ffprobe 返回结构化信息。kind: video | audio | generic"""
    tools = config.find_tools()
    if not tools["ffprobe"]:
        raise RuntimeError(tools["error"] or "ffprobe 不可用")

    if kind == "audio":
        args = ["-print_format", "json", "-show_format", "-show_streams",
                "-select_streams", "a:0"]
    elif kind == "format_only":
        args = ["-print_format", "json", "-show_format",
                "-analyzeduration", "200000", "-probesize", "400000"]
    elif kind == "generic":
        args = ["-print_format", "json", "-show_format", "-show_streams",
                "-analyzeduration", str(config.FFPROBE_ANALYZE_US),
                "-probesize", str(config.FFPROBE_PROBE_SIZE)]
    else:
        args = VIDEO_ARGS

    cmd = [tools["ffprobe"], "-v", "error"] + args + [path]
    proc = _run(cmd, config.FFPROBE_TIMEOUT)
    out = _decode(proc.stdout)
    if not out.strip():
        raise RuntimeError(_decode(proc.stderr).strip() or "ffprobe 无输出")
    return json.loads(out)


def analyze_video(path: str) -> dict:
    """把 ffprobe 原始输出整理成 UI 需要的扁平字段。

    只调一次 ffprobe（读全部流），音频/内嵌封面由结果里推导，避免大文件重复扫描。
    """
    data = probe_json(path, "generic")
    all_streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video_streams = [s for s in all_streams
                     if s.get("codec_type") == "video"
                     and (s.get("disposition") or {}).get("attached_pic") != 1]
    if not video_streams:
        return {"ok": False, "error": "没有视频流（可能是 0 字节或损坏文件）"}

    streams = video_streams
    v = streams[0]
    width = v.get("width") or 0
    height = v.get("height") or 0
    res = classify_resolution(width, height)
    fps = parse_fraction(v.get("avg_frame_rate")) or parse_fraction(v.get("r_frame_rate"))

    duration = None
    for cand in (v.get("duration"), fmt.get("duration")):
        try:
            if cand is not None:
                duration = round(float(cand), 3)
                break
        except (TypeError, ValueError):
            continue
    if duration is None and v.get("nb_frames") and fps:
        try:
            duration = round(int(v["nb_frames"]) / fps, 3)
        except (TypeError, ValueError, ZeroDivisionError):
            duration = None

    def _int(val):
        try:
            return int(float(val))
        except (TypeError, ValueError):
            return None

    bit_rate = _int(v.get("bit_rate")) or _int(fmt.get("bit_rate"))

    # 音频 / 内嵌封面（DJI 会在 MP4 尾部附一张 1280x720 MJPEG 缩略图）
    audio_streams = [s for s in all_streams if s.get("codec_type") == "audio"]
    has_audio = bool(audio_streams)
    has_embedded_thumb = any(
        (s.get("disposition") or {}).get("attached_pic") == 1 for s in all_streams
    )

    tags = fmt.get("tags") or {}
    return {
        "ok": True,
        "width": width,
        "height": height,
        "resolution": res["label"],
        "tier": res["tier"],
        "aspect": res["aspect"],
        "megapixels": res.get("mp"),
        "fps": fps,
        "fps_label": fps_label(fps),
        "codec": v.get("codec_name"),
        "codec_label": codec_label(v.get("codec_name")),
        "profile": v.get("profile"),
        "pix_fmt": v.get("pix_fmt"),
        "bit_depth": _bit_depth(v.get("pix_fmt")),
        "hdr": is_hdr(v),
        "color_transfer": v.get("color_transfer"),
        "color_primaries": v.get("color_primaries"),
        "duration": duration,
        "bit_rate": bit_rate,
        "size": _int(fmt.get("size")),
        "nb_frames": _int(v.get("nb_frames")),
        "has_audio": has_audio,
        "has_embedded_thumb": has_embedded_thumb,
        "encoder": tags.get("encoder"),
        "creation_time": tags.get("creation_time"),
        "timecode": tags.get("timecode"),
    }


def _bit_depth(pix_fmt: Optional[str]) -> Optional[int]:
    if not pix_fmt:
        return None
    for token in ("10", "12", "16"):
        if token in pix_fmt:
            return int(token)
    if "8" in pix_fmt or pix_fmt.startswith(("yuv", "rgb")):
        return 8
    return None


def jpeg_dimensions(path: str) -> Optional[tuple]:
    """纯 Python 读 JPEG 尺寸，避免为一张照片起 ffprobe。"""
    try:
        with open(path, "rb") as fh:
            data = fh.read(256 * 1024)
    except OSError:
        return None
    if not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker == 0xDA:  # SOS，后面是压缩数据
            return None
        seg_len = int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(data[i + 5:i + 7], "big")
            width = int.from_bytes(data[i + 7:i + 9], "big")
            return width, height
        i += 2 + seg_len
    return None


def analyze_photo(path: str) -> dict:
    dims = jpeg_dimensions(path)
    if dims:
        res = classify_resolution(*dims)
        return {
            "ok": True,
            "width": dims[0],
            "height": dims[1],
            "resolution": res["label"],
            "tier": res["tier"],
            "aspect": res["aspect"],
            "megapixels": res["mp"],
            "codec": "jpeg",
            "codec_label": "JPEG",
        }
    return {"ok": False, "error": "无法读取照片尺寸"}


# ------------------------------------------------------------------ 缩略图
def quick_thumb(src: str, dest: str, ts: float = 1.0,
                width: int = config.THUMB_WIDTH) -> bool:
    """只为"尽快出图"服务的快速抓帧。

    实测：单帧抓取用**软件解码更快**——硬解初始化开销比解一帧本身还大
    （4K HEVC 779ms vs 948ms，720p LRF 263ms vs 648ms）。
    所以这里只用软件解码，也不做多轮重试：抓不出来就放弃，绝不拖累整个出图阶段。
    """
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return False
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-threads", "1", "-ss", f"{max(0.0, ts):.2f}", "-i", src,
        "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
        "-vf", f"scale={width}:-2", "-q:v", str(config.THUMB_QUALITY),
        dest,
    ]
    try:
        proc = _run(cmd, 25)
    except Exception:
        return False
    return proc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 0


def make_thumbnail(src: str, dest: str, ts: float = 1.0, width: int = config.THUMB_WIDTH) -> bool:
    """抽取一帧生成 JPEG 缩略图；成功返回 True。"""
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return False
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-ss", f"{max(0.0, ts):.3f}",
        "-i", src,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-an", "-sn", "-dn",
        "-vf", f"scale={width}:-2:flags=lanczos",
        "-q:v", str(config.THUMB_QUALITY),
        dest,
    ]
    try:
        proc = _run(cmd, config.FFMPEG_TIMEOUT)
    except Exception:
        return False
    return proc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 0


def extract_embedded_thumb(src: str, dest: str) -> bool:
    """取 MP4 内嵌封面（DJI 通常附一张 1280x720 MJPEG），速度极快。"""
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return False
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-i", src, "-map", "0:v:1", "-frames:v", "1",
        "-vf", f"scale={config.THUMB_WIDTH}:-2:flags=lanczos",
        "-q:v", str(config.THUMB_QUALITY), dest,
    ]
    try:
        proc = _run(cmd, config.FFMPEG_TIMEOUT)
    except Exception:
        return False
    return proc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 0


def make_thumbnail_hw(src: str, dest: str, ts: float = 1.0,
                      width: int = config.THUMB_WIDTH) -> bool:
    """硬解抽取（HEVC 10bit 4K 软解很慢，d3d11va 可提速数倍）。"""
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return False
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    for hw in ("d3d11va", "dxva2", "cuda", None):
        cmd = [tools["ffmpeg"], "-hide_banner", "-nostdin", "-y", "-v", "error"]
        if hw:
            cmd += ["-hwaccel", hw]
        cmd += [
            "-ss", f"{max(0.0, ts):.3f}", "-i", src,
            "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
            "-vf", f"scale={width}:-2:flags=lanczos",
            "-q:v", str(config.THUMB_QUALITY), dest,
        ]
        try:
            proc = _run(cmd, config.FFMPEG_TIMEOUT)
        except Exception:
            continue
        if proc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 0:
            return True
    return False


def grab_frames(src: str, ts: float, width: int = config.THUMB_WIDTH) -> Optional[bytes]:
    """抓取指定时间点的单帧，返回 JPEG 字节（用于时间轴预览 / 封面挑帧）。"""
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return None
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-v", "error",
        "-ss", f"{max(0.0, ts):.3f}", "-i", src,
        "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
        "-vf", f"scale={width}:-2:flags=lanczos",
        "-q:v", str(config.THUMB_QUALITY),
        "-f", "mjpeg", "-",
    ]
    try:
        proc = _run(cmd, config.FFMPEG_TIMEOUT)
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return proc.stdout


def transcode_stream(src: str) -> Iterator[bytes]:
    """把源文件实时转成浏览器友好的 fMP4(H.264 720p)，用于浏览器无法解码的 HEVC 8K 素材。"""
    tools = config.find_tools()
    if not tools["ffmpeg"]:
        return
    cmd = [
        tools["ffmpeg"], "-hide_banner", "-nostdin", "-v", "error",
        "-i", src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-vf", "scale='min(1920,iw)':-2",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        **config.no_window_kwargs(),
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk
    finally:
        try:
            proc.kill()
        except Exception:
            pass
