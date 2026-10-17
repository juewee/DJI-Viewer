"""把真实扫描结果导出成前端单测用的 fixture。

    python tools/dump_fixtures.py "G:\\DCIM\\DJI_001"
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BASE = "http://127.0.0.1:8777"


def _get(endpoint: str):
    with urllib.request.urlopen(BASE + endpoint, timeout=180) as res:
        return json.loads(res.read().decode("utf-8"))


def _post(endpoint: str, payload: dict):
    req = urllib.request.Request(
        BASE + endpoint, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as res:
        return json.loads(res.read().decode("utf-8"))


def main(folder: str) -> int:
    import urllib.parse

    out = Path(__file__).resolve().parent / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    try:
        scan = _get(f"/_api/scan?folder={urllib.parse.quote(folder)}&recursive=1")
    except Exception as exc:
        print(f"无法连接 {BASE}：{exc}\n请先启动服务：python -m djiviewer --no-browser")
        return 1

    paths = scan.get("needs_probe") or []
    meta = _post("/_api/meta", {"paths": paths, "enqueue": True}).get("meta", {}) if paths else {}
    (out / "scan.json").write_text(
        json.dumps({"clips": scan["clips"], "summary": scan["summary"]}, ensure_ascii=False),
        encoding="utf-8")
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    print(f"fixture 已写入 {out}")
    print(f"  素材 {scan['clip_count']} 条，文件 {scan['file_count']} 个，"
          f"其中待探测 {len(paths)} 个、导出详情 {len(meta)} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else r"G:\DCIM\DJI_001"))
