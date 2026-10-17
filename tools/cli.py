"""命令行自检 / 体检工具。

用法::

    python tools/cli.py scan  "G:\\DCIM\\DJI_001"          # 扫描并统计
    python tools/cli.py probe "G:\\DCIM\\DJI_001" --limit 5 # 真正跑 ffprobe + 缩略图
    python tools/cli.py filter "G:\\DCIM\\DJI_001"         # 演示按分辨率/日期筛选
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from djiviewer import cache, config, scan  # noqa: E402


def cmd_scan(args) -> int:
    cache.load()
    t0 = time.time()
    res = scan.scan(args.folder, recursive=not args.no_recursive, force=args.force)
    print(f"目录      : {res['folder']}")
    print(f"扫描耗时  : {res['scan_ms']} ms（纯文件系统，无 ffprobe）")
    print(f"文件数    : {res['file_count']}   素材条目: {res['clip_count']}")
    s = res["summary"]
    print(f"总大小    : {s['total_size_label']}   总时长: {s['duration_label']}")
    print(f"日期数    : {s['date_count']}   视频: {s['videos']}  照片: {s['photos']}")
    print(f"含 LRF    : {s['with_proxy']}   仅 LRF: {s['orphan_proxy']}   空文件: {s['empty_files']}")
    print(f"待探测    : {len(res['needs_probe'])} 个文件")
    print("\n按日期:")
    for date, n in sorted(res["summary"]["dates"].items()):
        print(f"  {date}  {n:>4} 条")
    print("\n前 6 条(配对结果):")
    for c in res["clips"][:6]:
        print(f"  [{c['id']}] {c['name']:<34} {c['size_label']:>9} "
              f"LRF={'有' if c['has_proxy'] else '无'} {c['date']} {c['time']}")
    if res["summary"]["resolution"]:
        print("\n分辨率分布:", res["summary"]["resolution"])
    return 0


def cmd_probe(args) -> int:
    cache.load()
    res = scan.scan(args.folder, recursive=not args.no_recursive)
    paths = res["needs_probe"][:args.limit] if args.limit else res["needs_probe"]
    if not paths:
        print("没有需要探测的文件（全部命中缓存）")
    print(f"开始探测 {len(paths)} 个文件，并发 {config.PROBE_WORKERS} …")
    t0 = time.time()
    cache.enqueue(paths)
    last = -1
    while True:
        p = cache.progress()
        done = p["done"] + p["failed"]
        if done != last:
            print(f"  进度 {done}/{p['total']}  失败 {p['failed']}  队列 {p['pending']}")
            last = done
        if p["pending"] == 0 and p["active"] == 0:
            break
        time.sleep(0.3)
    cache.flush()
    print(f"完成，用时 {time.time()-t0:.1f}s")
    print("\n抽样结果:")
    shown = 0
    for path in paths:
        meta = cache.get_meta(path)
        if not meta:
            continue
        ok = "OK " if meta.get("ok") else "ERR"
        print(f"  {ok} {Path(path).name:<34} "
              f"{meta.get('resolution','-'):>6} {meta.get('fps_label','-'):>7} "
              f"{meta.get('codec_label','-'):>6} {meta.get('bit_depth','-')}bit "
              f"dur={meta.get('duration')} thumb={'有' if meta.get('thumb') else '无'}")
        if not meta.get("ok"):
            print(f"      └─ {meta.get('error')}")
        shown += 1
        if shown >= 15:
            break
    return 0


def cmd_filter(args) -> int:
    cache.load()
    res = scan.scan(args.folder, recursive=not args.no_recursive)
    clips = res["clips"]
    for c in clips:
        if c["detail"] is None:
            m = cache.get_meta(c["path"])
            if m:
                c["detail"] = scan._shrink(m)
    probed = [c for c in clips if c.get("detail") and c["detail"].get("ok")]
    print(f"共 {len(clips)} 条，已探测 {len(probed)} 条")
    by_res: dict = {}
    by_fps: dict = {}
    for c in probed:
        d = c["detail"]
        by_res.setdefault(d.get("resolution"), []).append(c)
        by_fps.setdefault(d.get("fps_label"), []).append(c)
    print("\n分辨率筛选:")
    for res_label, items in sorted(by_res.items(), key=lambda kv: -len(kv[1])):
        print(f"  {res_label:<6} {len(items):>4} 条  例: {items[0]['name']}")
    print("\n帧率筛选:")
    for fps, items in sorted(by_fps.items(), key=lambda kv: -len(kv[1])):
        print(f"  {fps:<8} {len(items):>4} 条")
    dates = sorted({c["date"] for c in clips})
    print(f"\n日期筛选: {dates[0]} … {dates[-1]} 共 {len(dates)} 天")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DJI Footage Viewer 自检工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name, fn in (("scan", cmd_scan), ("probe", cmd_probe), ("filter", cmd_filter)):
        p = sub.add_parser(name)
        p.add_argument("folder")
        p.add_argument("--no-recursive", action="store_true")
        p.add_argument("--force", action="store_true")
        if name == "probe":
            p.add_argument("--limit", type=int, default=5)
        p.set_defaults(func=fn)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
