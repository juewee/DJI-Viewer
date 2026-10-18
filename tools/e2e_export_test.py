"""转存（导出）功能的端到端测试。

    python tools/e2e_export_test.py "G:\\DCIM\\DJI_001"

覆盖：干跑计划（排除 LRF / 按日期分组 / 空间检查）、真实拷贝的逐字节校验、
目录结构、时间戳保留、三种重名策略、清单 CSV、取消、目标校验、目录浏览接口。
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from djiviewer import config, server  # noqa: E402

PORT = 8793
BASE = f"http://127.0.0.1:{PORT}"
PASS, FAIL = [], []
WORK = Path(__file__).resolve().parent.parent / "cache" / "_e2e_export"


def check(name: str, ok: bool, detail: str = "") -> bool:
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")
    return ok


def post(endpoint: str, payload: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        BASE + endpoint, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def get_json(endpoint: str, **params) -> dict:
    q = urllib.parse.urlencode(params)
    url = f"{BASE}{endpoint}" + (f"?{q}" if q else "")
    with urllib.request.urlopen(url, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))


def sha256(path: Path, limit: int = 0) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            if limit and fh.tell() > limit:
                break
    return h.hexdigest()


def make_sparse(path: Path, size: int) -> Path:
    """快速造一个大文件（稀疏文件，占位不占实际空间），用于计时/进度类测试。

    不去反复拷贝卡上十几 GB 的真实素材——既慢又会干扰磁盘缓存。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.truncate(size)
    return path


def _export_paths(clip: dict) -> "list[str]":
    """这条素材会被导出的原片路径（复用后端同一套规则）。"""
    out = []
    for key in ("video_path", "photo_path"):
        p = clip.get(key)
        if p and Path(p).suffix.lower() in {".mp4", ".mov", ".jpg", ".jpeg", ".dng", ".png"}:
            out.append(p)
    if not out and clip.get("path"):
        p = clip["path"]
        if Path(p).suffix.lower() in {".mp4", ".mov", ".jpg", ".jpeg", ".dng", ".png"}:
            out.append(p)
    return out


def wait_job(job: str, timeout: float = 300) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        snap = get_json("/_api/export/progress", job=job)["job"]
        if snap["status"] != "running":
            return snap
        time.sleep(0.3)
    return get_json("/_api/export/progress", job=job)["job"]


def ffprobe_size(path: str) -> str:
    """读视频分辨率，用于校验"全分辨率烘焙"没有偷偷缩放。"""
    try:
        tools = config.find_tools()
        proc = subprocess.run(
            [tools["ffprobe"], "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
            capture_output=True, timeout=60, **config.no_window_kwargs())
        return (proc.stdout or b"").decode("utf-8", "replace").strip()
    except Exception as exc:
        return f"error:{exc}"


def main(folder: str) -> int:
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)
    src = Path(folder)
    mp4s = sorted(src.glob("*.MP4"))
    lrfs = sorted(src.glob("*.LRF"))
    jpgs = sorted(src.glob("*.JPG"))
    if not mp4s:
        print(f"目录里没有 MP4：{folder}")
        return 2
    small = sorted(mp4s, key=lambda p: p.stat().st_size)[:4]
    files = [str(p) for p in small] + [str(p) for p in lrfs[:2]] + [str(p) for p in jpgs[:1]]

    thread = threading.Thread(
        target=server.serve,
        kwargs={"host": "127.0.0.1", "port": PORT, "quiet": True,
                "open_browser": False, "folder": folder},
        daemon=True)
    thread.start()
    for _ in range(60):
        try:
            get_json("/_api/ping")
            break
        except Exception:
            time.sleep(0.25)
    else:
        print("服务启动失败")
        return 2

    print("\n== 1. 干跑计划 ==")
    dest1 = str(WORK / "out1")
    plan = post("/_api/export", {"paths": files, "dest": dest1, "dryRun": True})
    check("POST /_api/export (dryRun) 返回计划", plan.get("ok") and plan["count"] > 0,
          f"{plan['count']} 个文件 / {plan['total_size_label']}")
    check("LRF 被排除", plan["skipped_proxy"] == 2, f"忽略 {plan['skipped_proxy']} 个")
    expect = len(small) + len(jpgs[:1])
    check("只有原片进入计划", plan["count"] == expect, f"{plan['count']} == {expect}")
    check("计划里没有 .LRF", all(not it["src"].lower().endswith(".lrf") for it in plan["items"]))
    check("目标按日期分目录", all(str(Path(it["dst"]).parent).startswith(dest1) for it in plan["items"]))
    check("日期数正确", plan["date_count"] >= 1, f"{plan['date_count']} 天 {sorted(plan['dates'])}")
    check("目标可用空间已读取", bool(plan["free_label"]), str(plan["free_label"]))
    check("空间足够判断", plan["enough_space"] is True)
    check("目标不存在但可用", plan["dest_ok"] is True and plan["dest_exists"] is False)
    check("干跑不写任何文件", not Path(dest1).exists())

    print("\n== 1.5 色彩还原导出计划（LUT） ==")
    info = get_json("/_api/info")
    if (info.get("lut") or {}).get("available"):
        dest_lut = str(WORK / "out_lut")
        plan_lut = post("/_api/export", {"paths": files, "dest": dest_lut,
                                         "dryRun": True, "lut": True})
        check("LUT 导出计划标记 lut", plan_lut.get("lut") is True,
              str(plan_lut.get("lut_name"))[:40])
        videos = [it for it in plan_lut["items"] if it["kind"] == "video"]
        photos = [it for it in plan_lut["items"] if it["kind"] == "photo"]
        check("视频都被标记为需要转码",
              videos and all(it["transcode"] for it in videos),
              f"{len(videos)} 个视频")
        check("照片不套 LUT（直接拷贝）",
              all(not it["transcode"] for it in photos), f"{len(photos)} 张照片")
        check("计划里提示了要重新编码",
              any("重新编码" in w for w in plan_lut["warnings"]),
              (plan_lut["warnings"] or [""])[0][:36])
        check("LUT 干跑也不写文件", not Path(dest_lut).exists())

        # 真跑一个最小的视频，确认"套到原片"这条链路真的通
        smallest = min(mp4s, key=lambda p: p.stat().st_size)
        job = post("/_api/export", {"paths": [str(smallest)], "dest": dest_lut,
                                    "byDate": False, "lut": True})["job"]
        st = wait_job(job, timeout=420)
        out_lut = Path(dest_lut) / smallest.name
        check("LUT 导出真跑成功", st["done"] == 1 and st["failed"] == 0,
              f"done={st['done']} failed={st['failed']}")
        check("产出了套过 LUT 的 MP4",
              out_lut.exists() and out_lut.read_bytes()[4:8] == b"ftyp",
              f"{out_lut.stat().st_size if out_lut.exists() else 0} 字节")
        check("输出与源文件不同（确实重新编码了）",
              out_lut.exists() and out_lut.read_bytes() != smallest.read_bytes(),
              f"源 {smallest.stat().st_size} → 出 {out_lut.stat().st_size if out_lut.exists() else 0}")
        check("分辨率保持原样（全分辨率烘焙）",
              out_lut.exists() and ffprobe_size(str(out_lut)) == ffprobe_size(str(smallest)),
              f"{ffprobe_size(str(smallest))} → {ffprobe_size(str(out_lut)) if out_lut.exists() else '?'}")
        # 进度：转码后体积和源文件对不上，百分比必须按文件算，否则永远停在 30~40%
        check("转码任务标记为 mode=transcode", st.get("mode") == "transcode", str(st.get("mode")))
        check("转码任务完成后进度是 100%", st.get("progress") == 100.0,
              f"progress={st.get('progress')} bytes={st.get('bytes_written')}")
        # 对照：普通拷贝任务仍然按字节算，也应该是 100%
        copy_job = post("/_api/export", {"paths": [str(smallest)], "dest": str(WORK / "out_copy"),
                                         "byDate": False})["job"]
        st_copy = wait_job(copy_job, timeout=180)
        check("拷贝任务 mode=copy 且进度 100%",
              st_copy.get("mode") == "copy" and st_copy.get("progress") == 100.0,
              f"mode={st_copy.get('mode')} progress={st_copy.get('progress')}")
    else:
        check("LUT 导出计划标记 lut", True, "项目里没有 .cube，跳过")

    print("\n== 2. 真实导出 + 逐字节校验 ==")
    res = post("/_api/export", {"paths": files, "dest": dest1, "byDate": True, "manifest": True})
    check("导出任务已启动", res.get("ok") and res.get("job"), str(res.get("job")))
    snap = wait_job(res["job"])
    check("任务完成", snap["status"] == "done", f"状态={snap['status']} 失败={snap['failed']}")
    check("文件数一致", snap["done"] == expect, f"{snap['done']}/{snap['total']}")
    check("字节数一致", snap["bytes_done"] == plan["total_size"],
          f"{snap['bytes_done']} vs {plan['total_size']}")

    ok_bytes = True
    for it in plan["items"]:
        d = Path(it["dst"])
        if not d.exists():
            check(f"目标文件存在 {d.name}", False)
            ok_bytes = False
            continue
        if d.stat().st_size != it["size"] or sha256(d) != sha256(Path(it["src"])):
            check(f"内容一致 {d.name}", False, "大小或哈希不符")
            ok_bytes = False
    check("所有导出文件与原文件逐字节一致", ok_bytes, f"{len(plan['items'])} 个文件")

    print("\n== 3. 结构与元数据 ==")
    dates = {it["date"] for it in plan["items"]}
    check("按日期创建了子目录", all((Path(dest1) / d).is_dir() for d in dates), str(sorted(dates)))
    sample_src = Path(plan["items"][0]["src"])
    sample_dst = Path(plan["items"][0]["dst"])
    check("保留修改时间", abs(sample_dst.stat().st_mtime - sample_src.stat().st_mtime) < 2,
          f"{sample_dst.stat().st_mtime:.0f} vs {sample_src.stat().st_mtime:.0f}")
    manifest = Path(dest1) / "_export_manifest.csv"
    check("清单 CSV 已生成", manifest.exists())
    if manifest.exists():
        text = manifest.read_text(encoding="utf-8-sig")
        rows = [r for r in csv.reader(io.StringIO(text)) if r]
        check("清单行数 = 文件数 + 表头", len(rows) == expect + 1, f"{len(rows)} 行")
        check("清单含源/目标列", rows[0][1] == "源文件" and rows[0][2] == "目标文件")
        check("清单里的源文件都不是 LRF", all(not r[1].lower().endswith(".lrf") for r in rows[1:]))

    print("\n== 4. 重名策略 ==")
    plan2 = post("/_api/export", {"paths": files, "dest": dest1, "dryRun": True})
    check("重复导出时检测到重名", plan2["clash_count"] == expect, f"{plan2['clash_count']} 个冲突")

    dest_skip = str(WORK / "out_skip")
    post("/_api/export", {"paths": files, "dest": dest_skip, "byDate": True, "manifest": False})
    snap_skip0 = wait_job(post("/_api/export", {
        "paths": files, "dest": dest_skip, "byDate": True, "manifest": False})["job"])
    check("首次导出完成", snap_skip0["done"] == expect)
    mtime_before = (Path(dest_skip) / plan["items"][0]["date"] / Path(plan["items"][0]["src"]).name).stat().st_mtime
    snap_skip1 = wait_job(post("/_api/export", {
        "paths": files, "dest": dest_skip, "byDate": True, "manifest": False,
        "conflict": "skip"})["job"])
    mtime_after = (Path(dest_skip) / plan["items"][0]["date"] / Path(plan["items"][0]["src"]).name).stat().st_mtime
    check("skip 策略：不重复拷贝", snap_skip1["done"] == expect and abs(mtime_before - mtime_after) < 0.001,
          f"完成 {snap_skip1['done']}")

    dest_ren = str(WORK / "out_rename")
    post("/_api/export", {"paths": files, "dest": dest_ren, "byDate": True, "manifest": False})
    wait_job(post("/_api/export", {
        "paths": files, "dest": dest_ren, "byDate": True, "manifest": False})["job"])
    snap_ren = wait_job(post("/_api/export", {
        "paths": files, "dest": dest_ren, "byDate": True, "manifest": False,
        "conflict": "rename"})["job"])
    renamed = list(Path(dest_ren).rglob("*(2).*"))
    check("rename 策略：生成 (2) 副本", snap_ren["done"] == expect and len(renamed) == expect,
          f"{len(renamed)} 个副本")

    print("\n== 5. 目标校验与错误处理 ==")
    try:
        post("/_api/export", {"paths": files, "dest": ""})
        check("空目标被拒绝", False, "竟然成功了")
    except urllib.error.HTTPError as exc:
        check("空目标被拒绝", exc.code == 400, f"HTTP {exc.code}")
    try:
        post("/_api/export", {"paths": [], "dest": dest1})
        check("空文件列表被拒绝", False, "竟然成功了")
    except urllib.error.HTTPError as exc:
        check("空文件列表被拒绝", exc.code == 400, f"HTTP {exc.code}")
    ghost = str(WORK / "ghost.MP4")
    plan3 = post("/_api/export", {"paths": [ghost, str(small[0])], "dest": str(WORK / "out3"), "dryRun": True})
    check("不存在的源文件被跳过并告警", plan3["missing"] == 1 and plan3["count"] == 1,
          f"missing={plan3['missing']} warnings={len(plan3['warnings'])}")
    try:
        get_json("/_api/export/progress", job="nope")
        check("未知任务返回 404", False, "竟然成功了")
    except urllib.error.HTTPError as exc:
        check("未知任务返回 404", exc.code == 404, f"HTTP {exc.code}")

    print("\n== 6. 取消 ==")
    cancel_dest = str(WORK / "out_cancel")
    # 用稀疏文件（64/256/512MB）保证拷贝过程持续足够长，能真正测到"拷贝途中取消"
    synth = [
        make_sparse(WORK / "src" / "DJI_20261005120000_9001_D.MP4", 64 * 1024 ** 2),
        make_sparse(WORK / "src" / "DJI_20261005120100_9002_D.MP4", 256 * 1024 ** 2),
        make_sparse(WORK / "src" / "DJI_20261005120200_9003_D.MP4", 512 * 1024 ** 2),
    ]
    big = [str(p) for p in synth]
    plan_c = post("/_api/export", {"paths": big, "dest": cancel_dest, "dryRun": True})
    expect_c = {it["dst"]: it["size"] for it in plan_c["items"]}
    res_c = post("/_api/export", {"paths": big, "dest": cancel_dest,
                                 "byDate": True, "manifest": False})
    time.sleep(0.3)
    post("/_api/export/cancel", {"job": res_c["job"]})
    t0 = time.time()
    snap_c = wait_job(res_c["job"], timeout=30)
    took = time.time() - t0
    check("取消后任务停止", snap_c["status"] == "cancelled",
          f"状态={snap_c['status']} 完成 {snap_c['done']}/{snap_c['total']}")
    check("取消能快速生效（<5s）", took < 5, f"{took:.1f}s")
    leftovers = [p for p, want in expect_c.items()
                 if Path(p).exists() and Path(p).stat().st_size != want]
    check("取消不留下半截文件", not leftovers, f"{len(leftovers)} 个残缺")
    check("取消时确实没拷完", snap_c["done"] < snap_c["total"],
          f"{snap_c['done']}/{snap_c['total']}")

    print("\n== 7. 目录浏览接口 ==")
    br = get_json("/_api/browse", path=str(WORK))
    check("列目录成功", br["ok"] and br["path"] == str(WORK), f"{br['dir_count']} 个子目录")
    check("返回可用空间", bool(br["free_label"]), str(br["free_label"]))
    check("返回磁盘根", len(br.get("roots") or []) > 0, str([r["name"] for r in br["roots"]])[:40])
    check("可写标记", br["writable"] is True)
    br2 = get_json("/_api/browse", path=str(Path(dest1) / plan["items"][0]["date"]))
    check("子目录可见文件数", br2["file_count"] > 0, f"{br2['file_count']} 个文件")
    try:
        get_json("/_api/browse", path=str(WORK / "不存在"))
        check("不存在的目录报错", False, "竟然成功了")
    except urllib.error.HTTPError as exc:
        check("不存在的目录报错", exc.code == 404, f"HTTP {exc.code}")
    sug = get_json("/_api/suggest_dest", folder=folder)
    check("建议目标目录", sug["ok"] and len(sug["candidates"]) > 0,
          str([c["path"] for c in sug["candidates"]][:2]))

    print("\n== 8. 进度信息（速度 / 剩余时间 / 已写字节） ==")
    speed_dest = str(WORK / "out_speed")
    speed_files = [str(make_sparse(WORK / "src" / f"DJI_2026100513000{i}_901{i}_D.MP4",
                                   384 * 1024 ** 2)) for i in range(3)]
    res_s = post("/_api/export", {"paths": speed_files, "dest": speed_dest,
                                  "byDate": False, "manifest": False})
    seen = None
    for _ in range(80):
        snap_s = get_json("/_api/export/progress", job=res_s["job"])["job"]
        if snap_s["status"] == "running" and snap_s.get("bytes_written", 0) > 0:
            seen = snap_s
            break
        if snap_s["status"] != "running":
            break
        time.sleep(0.05)
    if seen:
        check("进度含已写字节", seen["bytes_written"] > 0,
              f"{seen['bytes_written']} / {seen['bytes_total']}")
        check("进度含百分比", 0 < seen["progress"] <= 100, f"{seen['progress']}%")
        check("含实时速度", seen["speed"] > 0 and seen["speed_label"].endswith("/s"),
              f"{seen['speed_label']}")
        check("含剩余时间估算", seen["eta"] is not None and seen["eta_label"],
              f"剩余 {seen['eta_label']}")
        check("运行中就有字节进度（不必等文件拷完）",
              seen["bytes_written"] > seen["bytes_done"],
              f"已写 {seen['bytes_written']} > 已完成 {seen['bytes_done']}")
    else:
        check("进度含已写字节", False, "没抓到运行中的快照（文件太小或已结束）")
    final_s = wait_job(res_s["job"])
    check("结束后进度为 100%", final_s["progress"] >= 99.9, f"{final_s['progress']}%")
    check("结束后字节数吻合", final_s["bytes_written"] == final_s["bytes_total"],
          f"{final_s['bytes_written']} / {final_s['bytes_total']}")
    check("结束后速度归零或保留统计", final_s["speed"] >= 0, final_s["speed_label"])

    print("\n== 9. 失败明细与报告 ==")
    fail_dest = str(WORK / "out_fail")
    # 制造一个运行期失败：目标位置已有同名「目录」，写入必然失败
    conflict_dir = Path(fail_dest) / Path(str(small[0])).name
    conflict_dir.mkdir(parents=True, exist_ok=True)
    res_f = post("/_api/export", {"paths": [str(small[0])], "dest": fail_dest,
                                  "byDate": False, "manifest": False, "conflict": "overwrite"})
    snap_f = wait_job(res_f["job"])
    check("运行期失败被记录", snap_f["failed"] >= 1 and snap_f["failure_count"] >= 1,
          f"失败 {snap_f['failed']} 个")
    check("失败明细含原因", bool(snap_f["failures"]) and bool(snap_f["failures"][0]["error"]),
          str(snap_f["failures"][0]["error"])[:46] if snap_f["failures"] else "无")
    check("失败明细含源文件路径",
          bool(snap_f["failures"]) and snap_f["failures"][0]["src"].endswith(Path(str(small[0])).name))
    try:
        with urllib.request.urlopen(f"{BASE}/_api/export/report?job={res_f['job']}", timeout=30) as res:
            report = res.read().decode("utf-8-sig")
            disp = res.headers.get("Content-Disposition", "")
        rows = [r for r in csv.reader(io.StringIO(report)) if r]
        check("失败报告可下载", len(rows) == 2, f"{len(rows)} 行（表头 + 1 条失败）")
        check("报告表头正确", rows[0][0] == "结果" and rows[0][3] == "错误原因", str(rows[0]))
        check("报告记录失败原因", rows[1][0] == "失败" and bool(rows[1][3]), rows[1][3][:40])
        check("报告带下载头", "attachment" in disp, disp[:44])
    except urllib.error.HTTPError as exc:
        check("失败报告可下载", False, f"HTTP {exc.code}")
    try:
        urllib.request.urlopen(f"{BASE}/_api/export/report?job=nope", timeout=20)
        check("未知任务的报告返回 404", False, "竟然成功了")
    except urllib.error.HTTPError as exc:
        check("未知任务的报告返回 404", exc.code == 404, f"HTTP {exc.code}")
    # 全部成功的任务，报告也应可用（只有表头 + 一行说明）
    try:
        with urllib.request.urlopen(f"{BASE}/_api/export/report?job={res_s['job']}", timeout=30) as res:
            ok_rows = [r for r in csv.reader(io.StringIO(res.read().decode("utf-8-sig"))) if r]
        check("无失败时报告仍可下载", len(ok_rows) == 2 and "无失败" in ok_rows[1][0], str(ok_rows[1][:2]))
    except urllib.error.HTTPError as exc:
        check("无失败时报告仍可下载", False, f"HTTP {exc.code}")

    print("\n== 10. 导出目录历史 ==")
    sug2 = get_json("/_api/suggest_dest", folder=folder)
    hist = sug2.get("history") or []
    check("历史记录已累积", len(hist) >= 2, f"{len(hist)} 条: {[Path(h).name for h in hist]}")
    # 第 9 组也导出过一次（out_fail），所以最新的应该是它
    check("最近一次排在最前", os.path.normcase(hist[0]) == os.path.normcase(fail_dest),
          Path(hist[0]).name)
    check("历史去重", len({os.path.normcase(h) for h in hist}) == len(hist))
    check("历史不超过 8 条", len(hist) <= 8)

    print("\n== 11. 相机自带预览图 SCR / THM ==")
    # 造一个"只有预览图"的目录：用真实 JPEG 冒充 SCR / THM（内容对不对不重要，格式对就行）
    prev_dir = WORK / "src_preview"
    prev_dir.mkdir(parents=True, exist_ok=True)
    sample_jpg = jpgs[0] if jpgs else None
    for stem in ("DJI_20261005140000_9101_D", "DJI_20261005140100_9102_D"):
        for ext in (".SCR", ".THM"):
            target = prev_dir / f"{stem}{ext}"
            if sample_jpg:
                shutil.copyfile(sample_jpg, target)
            else:
                make_sparse(target, 4096)
    scan_p = get_json("/_api/scan", folder=str(prev_dir), recursive=1)
    check("仅预览目录也能扫描出素材", scan_p["clip_count"] == 2, f"{scan_p['clip_count']} 条")
    check("预览图不需要 ffprobe", len(scan_p["needs_probe"]) == 0,
          f"{len(scan_p['needs_probe'])} 个待探测")
    p0 = scan_p["clips"][0]
    check("识别为仅预览条目", p0["is_scrub"] is True, f"is_scrub={p0['is_scrub']}")
    check("记录 SCR / THM 路径", bool(p0.get("scr_path")) and bool(p0.get("thm_path")),
          f"scr={bool(p0.get('scr_path'))} thm={bool(p0.get('thm_path'))}")
    check("缩略图非空（直接用预览图）", bool(p0["thumb"]), str(p0["thumb"]))
    # 现在扫描阶段就把 SCR 复制成缓存里的缩略图；旧的直接引用 SCR 原名也算对
    cache_dir = Path((get_json("/_api/info").get("cache_dir") or "").replace("/", os.sep))
    thumb_file = cache_dir / "thumbs" / (p0["thumb"] or "")
    check("缩略图画质来自 SCR（与 SCR 同体积或为 SCR 原名）",
          (p0["thumb"] or "").lower().endswith(".scr")
          or (thumb_file.exists()
              and thumb_file.stat().st_size == Path(p0["scr_path"]).stat().st_size),
          f"{thumb_file.name} {thumb_file.stat().st_size if thumb_file.exists() else 0} 字节")
    check("从文件名解析出拍摄时间", p0["date"] == "2026-10-05" and p0["time"] == "14:00:00",
          f"{p0['date']} {p0['time']}")
    check("标记没有可播放视频", p0["has_video"] is False and p0["has_proxy"] is False)
    check("文件列表区分预览类型", [f["kind"] for f in p0["files"]] == ["preview", "preview"],
          str([f["kind"] for f in p0["files"]]))
    thumb_url = (f"{BASE}/_thumb/{urllib.parse.quote(p0['thumb'])}"
                 f"?path={urllib.parse.quote(p0['path'])}")
    with urllib.request.urlopen(thumb_url, timeout=30) as res:
        tdata = res.read()
        ttype = res.headers.get("Content-Type")
    check("缩略图接口能直出 SCR", tdata[:2] == b"\xff\xd8" and "jpeg" in (ttype or ""),
          f"{len(tdata)} 字节 {ttype}")
    photo_url = f"{BASE}/_photo/" + "/".join(
        urllib.parse.quote(x) for x in p0["scr_path"].split("\\"))
    with urllib.request.urlopen(photo_url, timeout=30) as res:
        pdata = res.read()
    check("SCR 可作为图片直接预览", pdata[:2] == b"\xff\xd8" and len(pdata) > 1000,
          f"{len(pdata)} 字节")
    # 有视频时：SCR/THM 只是附带文件，导出清单里不应出现
    full_scan = get_json("/_api/scan", folder=folder, recursive=1)
    with_prev = [c for c in full_scan["clips"] if c.get("scr_path") or c.get("thm_path")]
    if with_prev:
        c0 = with_prev[0]
        check("有视频时 SCR/THM 只作附带文件",
              any(f["kind"] == "preview" for f in c0["files"]) and c0["has_video"],
              str([(f["kind"], Path(f["name"]).suffix) for f in c0["files"]]))
        check("导出清单不含 SCR/THM",
              all(not f.lower().endswith((".scr", ".thm")) for f in _export_paths(c0)),
              str([Path(f).name for f in _export_paths(c0)]))
    else:
        check("当前素材目录里没有 SCR/THM（跳过附带检查）", True, "仅预览目录已单独验证")

    print("\n== 12. 扫描即出图 + 分析队列由近到远 ==")
    fresh = WORK / "src_instant"
    fresh.mkdir(parents=True, exist_ok=True)
    for i, stamp in enumerate(("20260101120000", "20260601120000", "20261005120000")):
        stem = f"DJI_{stamp}_92{i:02d}_D"
        for ext in (".MP4", ".SCR", ".THM"):
            target = fresh / f"{stem}{ext}"
            if ext == ".SCR" and jpgs:
                shutil.copyfile(jpgs[0], target)          # 真 JPEG 冒充 SCR
            elif ext == ".THM" and jpgs:
                shutil.copyfile(jpgs[0], target)
            else:
                make_sparse(target, 2048)
    scan_i = get_json("/_api/scan", folder=str(fresh), recursive=1)
    check("返回立即缓存的缩略图数量", "instant_thumbs" in scan_i,
          f"instant_thumbs={scan_i.get('instant_thumbs')}")
    ready = sum(1 for c in scan_i["clips"] if c["thumb"])
    check("扫描返回时缩略图已就绪", ready == scan_i["clip_count"],
          f"{ready}/{scan_i['clip_count']} 张（未等任何 ffprobe）")
    check("全新的 SCR 也立刻发布", scan_i.get("instant_thumbs", 0) >= 3,
          f"立即发布 {scan_i.get('instant_thumbs')} 张")
    check("标注了分析顺序", scan_i.get("probe_order") == "date-desc", str(scan_i.get("probe_order")))
    check("每张缩略图都能取到", all(
        urllib.request.urlopen(
            f"{BASE}/_thumb/{urllib.parse.quote(c['thumb'])}"
            f"?path={urllib.parse.quote(c['path'])}", timeout=20).status == 200
        for c in scan_i["clips"]), f"{scan_i['clip_count']} 张全部 HTTP 200")

    big_scan = get_json("/_api/scan", folder=folder, recursive=1)
    queue = big_scan["needs_probe"]
    if len(queue) >= 3:
        dates = []
        for p in queue[:60]:
            m = re.search(r"DJI_(\d{8})", Path(p).name)
            dates.append(m.group(1) if m else "00000000")
        check("分析队列按日期由近到远", dates == sorted(dates, reverse=True),
              f"队首 {dates[:3]} … 队尾 {dates[-3:]}")
    else:
        check("分析队列按日期由近到远", True, f"待探测仅 {len(queue)} 个（全部命中缓存）")

    print(f"\n{'=' * 62}\n通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：")
        for f in FAIL:
            print(f"  - {f}")
    shutil.rmtree(WORK, ignore_errors=True)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else r"G:\DCIM\DJI_001"
    raise SystemExit(main(folder))
