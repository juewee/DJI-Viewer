"""静态核查前端资源：JS 引用的 DOM id/选择器是否都存在于 index.html。

    python tools/check_web.py

能在不打开浏览器的情况下抓出「选择器写错 / id 拼错」这类会让界面点不动的低级错误。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

ID_RE = re.compile(r"""\$\('#([A-Za-z0-9_-]+)'""")
SEL_RE = re.compile(r"""\$\$?\('([^']+)'""")
ATTR_SEL_RE = re.compile(r"""\$\$?\('([^']+)',\s*root""")
HTML_ID_RE = re.compile(r"""\sid="([^"]+)""")


def main() -> int:
    html_files = list(WEB.glob("*.html"))
    js_files = sorted(WEB.glob("js/*.js"))
    if not html_files or not js_files:
        print("找不到 web/index.html 或 web/js/*.js")
        return 2

    html = "\n".join(p.read_text(encoding="utf-8") for p in html_files)
    ids = set(HTML_ID_RE.findall(html))
    classes = set(re.findall(r"""class="([^"]+)""", html))
    class_set = set()
    for c in classes:
        class_set.update(c.split())

    problems = []
    checked_ids = 0
    checked_sels = 0

    # 运行时动态生成的元素/属性：已知且合理，不当作问题
    known_dynamic_ids = {"ex-report"}
    known_dynamic_attrs = {"data-id"}

    for js in js_files:
        src = js.read_text(encoding="utf-8")
        for m in ID_RE.finditer(src):
            checked_ids += 1
            name = m.group(1)
            if name not in ids and name not in known_dynamic_ids:
                problems.append(f"{js.name}: $('#{name}') —— HTML 里没有这个 id")

        for m in SEL_RE.finditer(src):
            sel = m.group(1)
            if "," in sel or " " in sel:
                continue
            if not sel.startswith((".", "#")):
                continue
            checked_sels += 1
            kind, name = sel[0], sel[1:]
            if kind == "#" and name not in ids and name not in known_dynamic_ids:
                problems.append(f"{js.name}: $('{sel}') —— HTML 里没有这个 id")
            if kind == "." and name not in class_set:
                # 允许运行时动态生成的类名
                if name not in src.replace(f"'{sel}'", ""):
                    problems.append(f"{js.name}: $('{sel}') —— HTML 与 JS 里都没出现这个类名")

    # HTML 内联脚本里的 id 也要能对上
    dup = [i for i in ids if html.count(f'id="{i}"') > 1]
    for d in dup:
        problems.append(f"index.html: id=\"{d}\" 重复出现")

    # CSS：必须有全局 [hidden] 兜底，否则 JS 里设 hidden=true 会被 display:flex 压掉
    css = (WEB / "css" / "style.css").read_text(encoding="utf-8")
    if not re.search(r"\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important", css):
        problems.append(
            "style.css 缺少全局 `[hidden] { display: none !important; }`——"
            "任何写了 display:flex/block 的元素，JS 设 hidden 都不会真正隐藏")

    js_all = "\n".join(p.read_text(encoding="utf-8") for p in js_files)
    # JS 里用到的 data-* 锚点是否在 HTML 中存在
    data_attrs = set(re.findall(r"""\[data-([a-z-]+)[\]=]""", "\n".join(
        p.read_text(encoding="utf-8") for p in js_files)))
    html_data = set(re.findall(r"""data-([a-z-]+)""", html))
    for d in sorted(data_attrs - html_data):
        if f"data-{d}" in known_dynamic_attrs:
            continue
        problems.append(f"JS 用到 [data-{d}]，HTML 里没有任何元素带该属性（可能由 JS 动态生成）")

    print(f"检查 {len(js_files)} 个 JS、{len(ids)} 个 id、{checked_ids} 处 $('#..')、"
          f"{checked_sels} 处选择器")
    if problems:
        print(f"\n发现 {len(problems)} 个可疑点：")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\n没有发现问题：所有 DOM 引用都能对上。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
