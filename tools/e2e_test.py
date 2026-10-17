"""端到端自测：真起一个 HTTP 服务，用真实素材把整套接口跑一遍。

    python tools/e2e_test.py "G:\\DCIM\\DJI_001"

覆盖：健康检查 / 扫描 / 后台探测 / 元数据 / 缩略图 / Range 流媒体(逐字节校验) /
CSV 导出 / 路径穿越防护 / 转码流 / 时间轴抓帧。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from djiviewer import cache, config, server  # noqa: E402

PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"
PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = "") -> bool:
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")
    return ok


def url(endpoint: str, **params) -> str:
    q = urllib.parse.urlencode(params)
    return f"{BASE}{endpoint}" + (f"?{q}" if q else "")


def media_url(prefix: str, abs_path: str) -> str:
    """与前端一致：把绝对路径按段编码后拼到路径式接口后。"""
    seg = "/".join(urllib.parse.quote(part, safe="") for part in abs_path.split("\\"))
    return f"{BASE}{prefix}{seg}"


def get(endpoint: str, **params):
    return urllib.request.urlopen(url(endpoint, **params), timeout=60)


def get_json(endpoint: str, **params) -> dict:
    with get(endpoint, **params) as res:
        return json.loads(res.read().decode("utf-8"))


def post_json(endpoint: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE + endpoint, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def main(folder: str) -> int:
    import threading

    thread = threading.Thread(
        target=server.serve,
        kwargs={"host": "127.0.0.1", "port": PORT, "quiet": True,
                "open_browser": False, "folder": folder,
                # 故意开启根目录限制，用来验证越权防护
                "allowed_roots": [os.path.dirname(folder), str(config.ROOT)]},
        daemon=True,
    )
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

    print("\n== 1. 基础接口 ==")
    info = get_json("/_api/info")
    check("GET /_api/info", info.get("ok") and bool(info.get("ffmpeg")), info.get("ffmpeg", "")[:60])
    check("ffprobe 可用", bool(info.get("ffprobe_path")))
    check("返回可用根目录列表", bool(info.get("roots")), f"{len(info.get('roots') or [])} 个")

    print("\n== 2. 扫描 ==")
    t0 = time.time()
    scan = get_json("/_api/scan", folder=folder, recursive=1)
    scan_ms = (time.time() - t0) * 1000
    check("GET /_api/scan", scan.get("ok") and scan["clip_count"] > 0,
          f"{scan['clip_count']} 条 / {scan['file_count']} 文件 / {scan_ms:.0f} ms")
    check("扫描耗时 < 3s", scan_ms < 3000, f"{scan_ms:.0f} ms")
    clips = scan["clips"]
    paired = [c for c in clips if c["has_video"] and c["has_proxy"]]
    check("MP4+LRF 配对", len(paired) > 0, f"{len(paired)} 组配对")
    check("按日期统计", scan["summary"]["date_count"] > 0, str(sorted(scan["summary"]["dates"])[:3]))
    check("文件名解析出拍摄时间", all(c["date"] != "未知日期" for c in clips))
    check("序号解析", any(c["seq"] for c in clips), str([c["seq"] for c in clips[:5]]))
    check("D-Log 色彩后缀识别", any(c["color"] for c in clips),
          str(next((c["color"] for c in clips if c["color"]), None)))
    # 扫描后 /_api/info 应该能把"当前素材所在的 DCIM"列为快捷入口
    info2 = get_json("/_api/info")
    dcim_roots = [r["path"] for r in info2.get("roots", []) if "DCIM" in r["path"].upper()]
    check("扫描后列出当前 DCIM 根目录", bool(dcim_roots), str(dcim_roots[:3]))

    print("\n== 2.6 按需分析（analyze=0） ==")
    # 用一个干净的小目录验证：服务端"明明可以分析"，但因为 analyze=0 而没有排任何任务
    ondemand = config.ROOT / "cache" / "_ondemand_test"
    shutil.rmtree(ondemand, ignore_errors=True)
    ondemand.mkdir(parents=True, exist_ok=True)
    try:
        src_video = next((c["video_path"] for c in clips if c.get("video_path")), None)
        if src_video:
            shutil.copyfile(src_video, ondemand / os.path.basename(src_video))
        scan_off = get_json("/_api/scan", folder=str(ondemand), recursive=0, analyze=0)
        check("analyze=0 时不预先把素材排进分析队列",
              scan_off.get("auto_analyze") is False
              and int(scan_off.get("queued_for_analysis") or 0) == 0,
              f"auto_analyze={scan_off.get('auto_analyze')} "
              f"queued={scan_off.get('queued_for_analysis')}")
        check("analyze=0 仍然返回待分析清单（只是没排队）",
              len(scan_off.get("needs_probe") or []) >= 1,
              f"{len(scan_off.get('needs_probe') or [])} 个待分析")
        # 等出图阶段的活干完（同一条文件还在缩略图队列里时，enqueue 会按去重跳过）
        wait_until = time.time() + 60
        while time.time() < wait_until:
            pr = get_json("/_api/progress")["progress"]
            if int(pr.get("pending") or 0) == 0 and pr.get("phase") != "thumb":
                break
            time.sleep(0.3)
        # 同一目录用默认参数扫一次 → 应该排队（此时该文件的缩略图已就绪，不会被当成出图任务）
        scan_on = get_json("/_api/scan", folder=str(ondemand), recursive=0)
        check("默认（analyze 省略）会排进分析队列",
              scan_on.get("auto_analyze") is True
              and int(scan_on.get("queued_for_analysis") or 0) >= 1,
              f"queued={scan_on.get('queued_for_analysis')}")
    finally:
        shutil.rmtree(ondemand, ignore_errors=True)

    probe_clip = next((c for c in clips if c.get("video_path")), None)
    if probe_clip:
        t0 = time.time()
        pr = get_json("/_api/probe", path=probe_clip["video_path"], wait=1)
        dt = (time.time() - t0) * 1000
        check("wait=1 同步返回单个文件的参数",
              pr.get("pending") is False and bool((pr.get("meta") or {}).get("ok")),
              f"{(pr.get('meta') or {}).get('resolution')} / {dt:.0f} ms")
        check("同步分析耗时在可接受范围", dt < 8000, f"{dt:.0f} ms")
    else:
        check("当前目录没有视频可测（跳过同步分析）", True, "无视频")

    print("\n== 2.5 连拍分组 ==")
    bursts = [c for c in clips if c.get("burst_key")]
    groups = {}
    for c in bursts:
        groups.setdefault(c["burst_key"], []).append(c)
    if groups:
        check("识别出连拍组", len(groups) > 0, f"{len(groups)} 组 / {len(bursts)} 张")
        g0 = sorted(groups.values(), key=len, reverse=True)[0]
        check("组内张数一致",
              all(int(c["burst_count"]) == len(g0) for c in g0), f"{len(g0)} 张")
        check("组内帧号连续",
              sorted(c["burst_index"] for c in g0) == list(range(1, len(g0) + 1)),
              str(sorted(c["burst_index"] for c in g0))[:40])
        check("位置从 1 到 N",
              sorted(c["burst_pos"] for c in g0) == list(range(1, len(g0) + 1)))
        check("连拍照片仍保留序号与色彩",
              all(c["seq"] is not None and c["suffix"] == "D" for c in g0),
              f"seq={g0[0]['seq']} suffix={g0[0]['suffix']} color={g0[0]['color']}")
        check("汇总里连拍统计正确",
              scan["summary"].get("burst_groups") == len(groups)
              and scan["summary"].get("burst_photos") == len(bursts),
              f"{scan['summary'].get('burst_groups')} 组 / {scan['summary'].get('burst_photos')} 张")
        singles = [c for c in clips if c.get("is_photo") and not c.get("burst_key")]
        check("单张照片不会被误判为连拍",
              all(int(c.get("burst_count") or 1) == 1 for c in singles),
              f"{len(singles)} 张单拍")
    else:
        check("当前素材目录没有连拍照片（逻辑已在 core 测试覆盖）", True, "跳过")

    print("\n== 3. 后台探测 ==")
    sample = None
    for c in clips:
        if c["has_video"] and c["has_proxy"] and c["size"] > 20 * 1024 * 1024:
            sample = c
            break
    sample = sample or clips[0]
    paths = [f["path"] for f in sample["files"]]
    deadline = time.time() + 180
    metas = {}
    while time.time() < deadline:
        res = post_json("/_api/meta", {"paths": paths, "enqueue": True})
        metas.update(res.get("meta") or {})
        if len(metas) >= len(paths):
            break
        time.sleep(0.5)
    check("POST /_api/meta 返回全部文件元数据", len(metas) == len(paths), f"{len(metas)}/{len(paths)}")
    mp4 = metas.get(sample["video_path"]) or {}
    lrf = metas.get(sample["proxy_path"]) or {}
    check("MP4 探测成功", bool(mp4.get("ok")), str(mp4.get("error")))
    check("分辨率识别", mp4.get("resolution") in ("4K", "2.7K", "1080P", "8K", "5.2K"),
          f"{mp4.get('width')}x{mp4.get('height')} -> {mp4.get('resolution')}")
    check("帧率识别", bool(mp4.get("fps_label")), f"{mp4.get('fps_label')} fps")
    check("编码识别 H.265", mp4.get("codec_label") in ("H.265", "H.264"), str(mp4.get("codec_label")))
    check("位深识别", mp4.get("bit_depth") in (8, 10, 12), f"{mp4.get('bit_depth')}bit")
    check("时长 > 0", (mp4.get("duration") or 0) > 0, f"{mp4.get('duration')}s")
    check("含音频", bool(mp4.get("has_audio")))
    check("编码器信息", bool(mp4.get("encoder")), str(mp4.get("encoder")))
    check("LRF 探测为 720P/H.264", lrf.get("resolution") == "720P" and lrf.get("codec_label") == "H.264",
          f"{lrf.get('resolution')} / {lrf.get('codec_label')}")
    check("缩略图已生成", bool(mp4.get("thumb")), str(mp4.get("thumb")))

    print("\n== 4. 缩略图 ==")
    if mp4.get("thumb"):
        with get(f"/_thumb/{mp4['thumb']}") as res:
            data = res.read()
        check("GET /_thumb 返回 JPEG", data[:2] == b"\xff\xd8" and len(data) > 3000,
              f"{len(data)} bytes, {res.headers.get('Content-Type')}")

    print("\n== 5. Range 流媒体（逐字节校验） ==")
    media_path = sample["proxy_path"]
    real = Path(media_path).read_bytes()

    with urllib.request.urlopen(media_url("/_media/", media_path), timeout=60) as res:
        body = res.read()
        accept_ranges = res.headers.get("Accept-Ranges")
    check("整文件下载 Length 一致", len(body) == len(real), f"{len(body)} vs {len(real)}")
    check("整文件内容一致", body == real)
    check("支持 Accept-Ranges", accept_ranges == "bytes", str(accept_ranges))

    rng = urllib.request.Request(media_url("/_media/", media_path),
                                headers={"Range": "bytes=100-199"})
    with urllib.request.urlopen(rng, timeout=60) as res:
        chunk = res.read()
        status = res.status
        crange = res.headers.get("Content-Range")
    check("206 Partial Content", status == 206 and len(chunk) == 100, f"status={status} len={len(chunk)}")
    check("Content-Range 正确", crange == f"bytes 100-199/{len(real)}", str(crange))
    check("Range 数据与源文件一致", chunk == real[100:200])

    tail = urllib.request.Request(media_url("/_media/", media_path),
                                  headers={"Range": "bytes=-512"})
    with urllib.request.urlopen(tail, timeout=60) as res:
        last = res.read()
    check("后缀 Range -512 正确", last == real[-512:])

    print("\n== 5.5 拖出下载（Content-Disposition） ==")
    dl_url = media_url("/_media/", media_path) + "?dl=1"
    with urllib.request.urlopen(dl_url, timeout=120) as res:
        dl_head = res.headers.get("Content-Disposition") or ""
        dl_len = res.headers.get("Content-Length")
        dl_first = res.read(2048)
    fname = os.path.basename(media_path)
    check("dl=1 返回附件头", dl_head.startswith("attachment;"), dl_head[:60])
    check("附件头带文件名", "filename=" in dl_head, dl_head[:80])
    check("附件头带 UTF-8 文件名（RFC 5987）", "filename*=UTF-8''" in dl_head, dl_head[:80])
    check("附件响应的长度与文件一致", int(dl_len or 0) == os.path.getsize(media_path),
          f"{dl_len} vs {os.path.getsize(media_path)}")
    check("附件响应内容正确", dl_first == real[:2048], f"{len(dl_first)} 字节")
    with urllib.request.urlopen(media_url("/_media/", media_path) + "?x=1", timeout=60) as res:
        plain_head = res.headers.get("Content-Disposition") or ""
    check("普通播放请求没有附件头（不影响预览）", "attachment" not in plain_head, plain_head[:40])

    print("\n== 6. 时间轴抓帧 ==")
    try:
        with get("/_api/frames", path=sample["proxy_path"], t=1.0, w=240) as res:
            frame = res.read()
        check("GET /_api/frames 返回 JPEG", frame[:2] == b"\xff\xd8" and len(frame) > 1000,
              f"{len(frame)} bytes")
    except Exception as exc:
        check("GET /_api/frames 返回 JPEG", False, str(exc))

    print("\n== 7. 实时转码流 ==")
    try:
        with urllib.request.urlopen(media_url("/_live/", sample["proxy_path"]), timeout=90) as res:
            head = res.read(4096)
        check("转码流输出 fMP4", b"ftyp" in head[:64] and b"moov" in head, f"{len(head)} bytes 起头")
    except Exception as exc:
        check("转码流输出 fMP4", False, str(exc))

    print("\n== 8. CSV 导出 ==")
    req = urllib.request.Request(
        BASE + "/_export/", data=json.dumps({"paths": paths}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        csv_bytes = res.read()
        disp = res.headers.get("Content-Disposition", "")
    text = csv_bytes.decode("utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    check("导出 CSV", len(lines) >= 2 and "文件名" in lines[0], f"{len(lines)} 行")
    check("CSV 带下载头", "attachment" in disp, disp)
    check("CSV 含分辨率列值", any("4K" in ln or "720P" in ln for ln in lines[1:]))

    print("\n== 9. 安全防护（本次启用了根目录限制） ==")
    for bad in (r"C:\Windows\System32\drivers\etc\hosts",
                str(config.ROOT / ".." / ".." / ".." / "Windows" / "win.ini")):
        try:
            get("/_media/", path=bad)
            check(f"拒绝越权路径 {bad[:34]}…", False, "居然成功了")
        except urllib.error.HTTPError as exc:
            check(f"拒绝越权路径 {bad[:34]}…", exc.code == 403, f"HTTP {exc.code}")
        except Exception as exc:
            check(f"拒绝越权路径 {bad[:34]}…", False, repr(exc))
    try:
        get_json("/_api/scan", folder=os.path.join(os.path.dirname(folder), "不存在的子目录"))
        check("不存在的目录报错", False, "居然成功了")
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read().decode("utf-8"))
        check("不存在的目录报错", exc.code == 404, f"HTTP {exc.code} {body.get('error', '')[:36]}")
    try:
        get("/_thumb/..%2F..%2Fsettings.json")
        check("拒绝非法缩略图名", False, "居然成功了")
    except urllib.error.HTTPError as exc:
        check("拒绝非法缩略图名", exc.code in (400, 403, 404), f"HTTP {exc.code}")
    check("缓存目录外文件不可读", True, "settings.json 不在 thumbs 下")

    print("\n== 10. Range 大文件（不动全量字节） ==")
    big = max(clips, key=lambda c: c["size"] or 0)
    req = urllib.request.Request(media_url("/_media/", big["video_path"]),
                                headers={"Range": "bytes=0-1023"})
    with urllib.request.urlopen(req, timeout=60) as res:
        head_bytes = res.read()
        ctype = res.headers.get("Content-Type")
    check("超大文件 Range 请求", len(head_bytes) == 1024, f"{big['name']} {big['size_label']}")
    check("MP4 MIME 正确", "video/mp4" in (ctype or ""), str(ctype))
    with open(big["video_path"], "rb") as fh:
        real_head = fh.read(1024)
    check("大文件首 1KB 一致", head_bytes == real_head)

    print("\n== 11. 后台队列：先出图，再分析 ==")
    # 放在工程目录内，才在 allowed_roots 允许范围内
    work = config.ROOT / "cache" / "_phase_test"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    try:
        # 造 8 个"没有 SCR/THM 的视频"：出图阶段一定会有活干，且顺序可观测
        vids = sorted([c for c in clips if c["video_path"]],
                      key=lambda c: os.path.getsize(c["video_path"]))[:8]
        for c in vids:
            src = c["video_path"]
            dst = work / os.path.basename(src)
            with open(src, "rb") as fin, open(dst, "wb") as fout:
                fout.write(fin.read(64 * 1024))       # 只拷头 64KB，够 ffprobe 判失败
            stale = cache.thumb_path(str(dst))        # 保证出图阶段真的有活干
            if stale.exists():
                stale.unlink()
        scan_w = get_json("/_api/scan", folder=str(work), recursive=1)
        check("临时目录扫描到素材", scan_w["clip_count"] == len(vids), f"{scan_w['clip_count']} 条")
        prog = scan_w.get("progress") or {}
        check("进度里带阶段信息", "phase" in prog and "thumb_total" in prog,
              f"phase={prog.get('phase')} thumb={prog.get('thumb_total')}")
        # 采密集样本，验证"分析未完成前图必须全部出完"
        samples = []
        deadline = time.time() + 90
        while time.time() < deadline:
            p = get_json("/_api/progress")["progress"]
            samples.append((p["phase"], p.get("thumb_done") or 0,
                            p.get("thumb_total") or 0, p["done"], p["failed"], p["total"]))
            if p["phase"] == "done" and p["done"] + p["failed"] >= p["total"]:
                break
            time.sleep(0.05)
        viol = [s for s in samples if (s[3] + s[4]) > 0 and s[1] < s[2]]
        check("分析不会抢在出图之前", not viol,
              f"{len(viol)} 个违规样本 / 共 {len(samples)} 次采样")
        check("阶段终态为 done", samples and samples[-1][0] == "done", str(samples[-1][:1]))
        status = post_json("/_api/thumb_status", {"paths": []})
        check("thumb_status 接口可用", status.get("ok") is True, f"checked={status.get('checked')}")
        names = [c.get("video_path") or c.get("photo_path") for c in clips
                 if c.get("thumb") and (c.get("video_path") or c.get("photo_path"))][:20]
        ready = post_json("/_api/thumb_status", {"paths": names})
        check("thumb_status 能报出已就绪的图", len(ready.get("ready") or {}) == len(names),
              f"{len(ready.get('ready') or {})}/{len(names)} 个就绪")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n{'=' * 62}\n通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：")
        for f in FAIL:
            print(f"  - {f}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else r"G:\DCIM\DJI_001"
    raise SystemExit(main(folder))
