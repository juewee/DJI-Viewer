"""DJI 文件名解析与素材分类（分辨率 / HDR / 后缀语义 / 时长格式化）。

DJI 素材命名规则（Osmo / Mavic / Air / Mini 等通用）::

    DJI_20260927142658_0002_D.MP4
    │   │              │    │
    │   │              │    └─ 后缀：D=D-Log M 色彩, _001/01=分段序号
    │   │              └────── 媒体序号(4 位，与 .LRF 同名成对)
    │   └───────────────────── 拍摄时间 YYYYMMDDHHMMSS（文件名时间为准）
    └───────────────────────── 固定前缀

成对文件：DJI_xxx_0002_D.MP4（原始）+ DJI_xxx_0002_D.LRF（低码率代理，用于预览）。
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Optional

FILENAME_RE = re.compile(
    r"^(?P<prefix>DJI|DJI_?\d{4,6}|GOPR|DJIFlightRecord|MVI|VID|IMG)"
    r"[_-](?P<stamp>\d{14})"
    r"(?:[_-](?P<seq>\d{3,5}))?"
    r"(?:[_-](?P<suffix>[A-Za-z0-9]{1,3}))?$",
    re.IGNORECASE,
)

# 不严格匹配时（例如个别机型命名不同）退回宽松模式
LOOSE_STAMP_RE = re.compile(r"(?P<stamp>20\d{12})")

# 连拍 / 包围曝光的第 N 帧：在标准名字后面再挂 _001、_010 …
#    DJI_20261017144148_0065_D_010.JPG
#    └──────────── 连拍组基准名 ────────────┘└帧号┘
BURST_TAIL_RE = re.compile(r"^(?P<base>.+?)[_-](?P<idx>\d{3})$")
PHOTO_EXTS = {".jpg", ".jpeg", ".dng"}

COLOR_SUFFIX = {
    "D": "D-Log M",
    "N": "普通(Normal)",
    "S": "D-Log",
    "H": "HLG",
    "T": "真彩(TrueColor)",
    "W": "广色域",
}


def format_size(num: Optional[int]) -> str:
    if num is None:
        return "-"
    units = ["B", "KB", "MB", "GB", "TB"]
    val = float(num)
    for unit in units:
        if val < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(val)} {unit}"
            return f"{val:.1f} {unit}" if val < 100 else f"{val:.0f} {unit}"
        val /= 1024
    return f"{num} B"


def format_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "--:--"
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def parse_filename(path: Path) -> dict:
    """从文件名解析 DJI 元信息；无法解析时退回文件系统时间。"""
    stem = path.stem
    ext = path.suffix.lower()
    info = {
        "stamp": None,
        "shot_at": None,
        "seq": None,
        "suffix": None,
        "color": None,
        "parsed": False,
        "segment": None,   # 分段：suffix 为 _001/_002 时
        "burst_index": None,   # 连拍第几帧（照片才判断）
        "burst_base": None,    # 连拍组基准名（去掉尾部帧号）
    }

    # 照片：先剥掉尾部的 _001/_010 帧号，再按标准名字解析
    base_stem = stem
    if ext in PHOTO_EXTS:
        mb = BURST_TAIL_RE.match(stem)
        if mb and (FILENAME_RE.match(mb.group("base"))
                   or LOOSE_STAMP_RE.search(mb.group("base"))):
            info["burst_index"] = int(mb.group("idx"))
            info["burst_base"] = mb.group("base")
            base_stem = mb.group("base")

    m = FILENAME_RE.match(base_stem)
    if not m:
        m2 = LOOSE_STAMP_RE.search(base_stem)
        if m2:
            m = None
            stamp = m2.group("stamp")
            tail = base_stem[m2.end():].strip("_-")
            info.update(_from_stamp(stamp, tail))
    else:
        info.update(_from_stamp(m.group("stamp"), m.group("seq"), m.group("suffix")))
    # _from_stamp 会重置这几个键，这里补回去
    if info["burst_index"] is not None:
        info["burst_base"] = base_stem

    if not info["parsed"]:
        # 兜底：用修改时间
        try:
            ts = path.stat().st_mtime
            dt = datetime.fromtimestamp(ts)
            info["shot_at"] = dt.strftime("%Y-%m-%d %H:%M:%S")
            info["date"] = dt.strftime("%Y-%m-%d")
            info["time"] = dt.strftime("%H:%M:%S")
        except Exception:
            info["date"] = "未知日期"
            info["time"] = "--:--:--"
    return info


def _from_stamp(stamp: str, seq=None, suffix=None) -> dict:
    out = {"parsed": False}
    try:
        dt = datetime.strptime(stamp, "%Y%m%d%H%M%S")
    except ValueError:
        return out
    out["parsed"] = True
    out["stamp"] = stamp
    out["shot_at"] = dt.strftime("%Y-%m-%d %H:%M:%S")
    out["date"] = dt.strftime("%Y-%m-%d")
    out["time"] = dt.strftime("%H:%M:%S")
    out["seq"] = None
    out["suffix"] = None
    out["segment"] = None
    if seq:
        try:
            out["seq"] = int(seq)
        except ValueError:
            out["suffix"] = seq
    if suffix:
        s = suffix.upper()
        if s.isdigit():
            out["segment"] = int(s)
            out["seq"] = out["seq"]
        else:
            out["suffix"] = s
            out["color"] = COLOR_SUFFIX.get(s)
            # DJI 三字符后缀的最后一位常是色彩代号，例如 _001_D 已拆开，这里处理 "DX"
            if len(s) > 1 and s[-1] in COLOR_SUFFIX:
                out["color"] = COLOR_SUFFIX.get(s[-1])
    return out


# ---------------------------------------------------------------- 分辨率
RES_TIERS = [
    ("8K", 7680),
    ("5.2K", 5120),
    ("4K", 3840),
    ("2.7K", 2704),
    ("1080P", 1920),
    ("720P", 1280),
]


def classify_resolution(width: Optional[int], height: Optional[int]) -> dict:
    """根据宽高给出档位标签，短边优先判断更稳。"""
    if not width or not height:
        return {"label": "未知", "tier": -1, "short": 0, "long": 0, "aspect": None, "k": None}
    short, long_ = sorted((int(width), int(height)))
    label, tier = f"{short}P", 0
    for i, (name, w) in enumerate(RES_TIERS):
        if long_ >= w - 32:
            label, tier = name, len(RES_TIERS) - i
            break
    if tier == 0:  # 低于 720P
        label = f"{short}P"
    mp = width * height / 1_000_000
    import math

    g = math.gcd(int(width), int(height))
    aspect = f"{int(width)//g}:{int(height)//g}"
    standard = {"16:9", "4:3", "17:9", "3:2", "1:1", "9:16", "4:5", "21:9", "2:1"}
    if aspect not in standard:
        ratio = width / height
        aspect = f"{ratio:.2f}:1"
    return {
        "label": label,
        "tier": tier,
        "short": short,
        "long": long_,
        "aspect": aspect,
        "k": round(long_ / 1000, 1),
        "mp": round(mp, 1),
    }


HDR_TRANSFERS = {"arib-std-b67", "smpte2084", "smpte428", "bt2020-10", "bt2020-12"}
HDR_PRIMARIES = {"bt2020"}


def is_hdr(stream: dict) -> bool:
    transfer = (stream.get("color_transfer") or "").lower()
    primaries = (stream.get("color_primaries") or "").lower()
    pix = (stream.get("pix_fmt") or "").lower()
    profile = (stream.get("profile") or "").lower()
    if transfer in HDR_TRANSFERS and transfer not in ("bt709", "smpte170m"):
        return True
    if primaries in HDR_PRIMARIES:
        return True
    if "10" in pix and "main 10" in profile:
        return True
    return False


def fps_label(fps: Optional[float]) -> str:
    if not fps:
        return "-"
    common = [
        (23.976, "23.976"), (24.0, "24"), (25.0, "25"), (29.97, "29.97"),
        (30.0, "30"), (47.95, "47.95"), (48.0, "48"), (50.0, "50"),
        (59.94, "59.94"), (60.0, "60"), (100.0, "100"), (120.0, "120"),
    ]
    for val, label in common:
        if abs(fps - val) < 0.06:
            return label
    return f"{fps:.2f}".rstrip("0").rstrip(".")


CODEC_LABELS = {
    "hevc": "H.265",
    "h264": "H.264",
    "avc1": "H.264",
    "hvc1": "H.265",
    "av1": "AV1",
    "vp9": "VP9",
    "mjpeg": "MJPEG",
    "prores": "ProRes",
}


def codec_label(name: Optional[str]) -> str:
    if not name:
        return "-"
    return CODEC_LABELS.get(name.lower(), name.upper())


def parse_fraction(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            den_f = float(den)
            if den_f == 0:
                return None
            val = float(num) / den_f
        else:
            val = float(value)
    except (ValueError, ZeroDivisionError):
        return None
    if val <= 0 or val > 1000:
        return None
    return round(val, 3)
