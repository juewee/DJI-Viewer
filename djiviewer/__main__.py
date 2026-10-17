"""命令行入口：python -m djiviewer [选项]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 允许直接 `python djiviewer/__main__.py` 运行
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from djiviewer import config, server  # type: ignore
else:
    from . import config, server


def _fix_console_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="djiviewer",
        description="DJI Footage Viewer —— 大疆素材浏览/筛选/预览（本地网页版）",
    )
    ap.add_argument("-d", "--dir", default="", help="启动时打开的素材目录")
    ap.add_argument("-p", "--port", type=int, default=config.DEFAULT_PORT,
                    help=f"端口，默认 {config.DEFAULT_PORT}；被占用时自动往后试")
    ap.add_argument("--port-tries", type=int, default=12,
                    help="端口被占用时最多往后试多少个端口（默认 12；填 0 表示不重试）")
    ap.add_argument("--host", default=config.DEFAULT_HOST, help="监听地址，默认 127.0.0.1")
    ap.add_argument("--root", action="append", default=[],
                    help="限制可访问的根目录（可重复；默认允许本机全部路径）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--verbose", action="store_true", help="打印访问日志")
    ap.add_argument("--check", action="store_true", help="只做环境自检后退出")
    return ap


def _port_is_free(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main(argv=None) -> int:
    _fix_console_encoding()
    args = build_parser().parse_args(argv)

    tools = config.find_tools()
    if args.check:
        print(f"{config.APP_NAME} v{config.APP_VERSION}")
        print(f"python      : {sys.version.split()[0]}  ({sys.executable})")
        print(f"ffmpeg      : {tools.get('ffmpeg') or '未找到'}")
        print(f"ffprobe     : {tools.get('ffprobe') or '未找到'}")
        print(f"ffmpeg 版本 : {tools.get('version') or '-'}")
        print(f"缓存目录    : {config.CACHE_DIR}")
        print(f"静态资源    : {config.STATIC_DIR} ({'存在' if config.STATIC_DIR.exists() else '缺失'})")
        print(f"默认端口    : {config.DEFAULT_PORT} "
              f"({'空闲' if _port_is_free(args.host, config.DEFAULT_PORT) else '被占用'})")
        if tools.get("error"):
            print(f"错误        : {tools['error']}")
            return 1
        return 0

    if tools.get("error"):
        print(f"[错误] {tools['error']}", file=sys.stderr)
        return 2

    # 端口被占用时自动往后找端口，避免出现"双击了但打不开"的情况
    tries = max(0, args.port_tries)
    last_exc = None
    for offset in range(0, tries + 1):
        port = args.port + offset
        try:
            server.serve(host=args.host, port=port, quiet=not args.verbose,
                         open_browser=not args.no_browser, folder=args.dir,
                         allowed_roots=args.root or None)
            return 0
        except OSError as exc:
            last_exc = exc
            if offset < tries:
                print(f"[提示] 端口 {port} 被占用，改用 {port + 1} …", flush=True)
                continue
            break
    print(f"[错误] 无法启动服务（{args.port}~{args.port + tries} 端口都不可用）: {last_exc}",
          file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
