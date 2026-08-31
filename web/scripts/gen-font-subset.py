#!/usr/bin/env python3
"""
重新切两级楷体字集（2026-08-29）。

背景：原来只有一份 52KB 子集，字表是 08-07 从登录墙扫的 330 个字。之后每写一页
新界面，就多一批字掉在子集外面 —— 掉出去的字逐字回退到系统宋体，一行里楷体宋体
混排。08-29 实测首页 144 个字、登录墙自己也已经有 28 个字在退化。

所以字表不能再手抄，得从源码扫：谁改了界面文案，重跑一次这个脚本就对上了。

用法（需要 python3-fonttools + python3-brotli，字体来自 apt 的 fonts-lxgw-wenkai）：
    python3 web/scripts/gen-font-subset.py            # 重切并写回 web/src/assets/fonts/
    python3 web/scripts/gen-font-subset.py --range    # 只打印首屏字集的 unicode-range

两份都从同一刀 LXGWWenKai-Regular/Bold.ttf 切，所以混排看不出来。
⚠️ 首屏那份（lxgw-nd-*.woff2）不重切 —— 它是 08-07 那批文件，只负责登录墙秒显；
   改它就要同步改 globals.css 里的 unicode-range，font-subset.lint.test.js 会拦。
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent   # web/scripts/ -> 仓库根
FONT_DIR = ROOT / 'web/src/assets/fonts'
SRC_FONTS = {
    'regular': '/usr/share/fonts/truetype/lxgw-wenkai/LXGWWenKai-Regular.ttf',
    'bold': '/usr/share/fonts/truetype/lxgw-wenkai/LXGWWenKai-Bold.ttf',
}
# 全角标点：源码里未必每个都出现过，但排版随时会用到
EXTRA = '　、。〈〉《》「」『』【】〔〕〖〗！（），．：；？［］｛｝…—～·¥％＋－／＜＞＝＠'


# 不上屏的源文件：测试、lint，以及渲染检查台（harness 不进 vite build，
# 它的假数据只在 chromium 截图里出现过，为它切字进生产字体是白白加重）
NOT_RENDERED = ('.test.', '.lint.')


def render_sources():
    """会被渲染的前端源文件（测试/lint/检查台里的中文不上屏，不算）"""
    for p in sorted((ROOT / 'web/src').rglob('*')):
        if p.suffix not in ('.js', '.jsx', '.css'):
            continue
        if any(m in p.name for m in NOT_RENDERED) or p.name == 'harness.jsx':
            continue
        yield p


def chars_in(paths):
    out = set()
    for p in paths:
        s = p.read_text(encoding='utf-8', errors='ignore')
        # 注释里的中文不渲染，白白撑大字体（08-03 那次就踩过）
        s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
        s = re.sub(r'//.*', '', s)
        out |= {ch for ch in s if ord(ch) >= 0x00a0}
    return out


def source_chars():
    return chars_in(render_sources())


# 首屏 = 登录墙那一屏上**真的会显出来的字**所在的文件。
#
# ⚠️ 这份名单试过两种更"聪明"的写法，都错了：
#   ① 只扫 AuthGate.jsx —— 真机一量，首屏 119 个字不在字集里（定格轮播的文案住在
#      各自的场景文件里）。
#   ② 顺着 import 闭包走 —— 一路走进 lib/i18n.js，把全站文案都算进来了，首屏字集
#      922 个汉字、322KB，比全站字集还大，两级就白分了。
# 所以这里就老实列文件。判据是「这些字会不会出现在没登录时看到的那一屏上」，
# 那是产品问题不是依赖图问题。改了登录墙记得重跑本脚本（lint 会拦住不一致）。
FIRST_GLOBS = [
    'web/src/components/AuthGate.jsx',
    'web/src/components/PaperBits.jsx',
    'web/src/components/ui/LanguageSwitcher.jsx',
    'web/src/components/login-wall/**/*.js',
    'web/src/components/login-wall/**/*.jsx',
]


def first_chars():
    """首屏 = 登录墙那一屏"""
    files = []
    for g in FIRST_GLOBS:
        files += [p for p in ROOT.glob(g)
                  if p.is_file() and '.test.' not in p.name and '.lint.' not in p.name]
    print(f'首屏文件：{len(files)} 个')
    return chars_in(sorted(set(files)))


def cmap_of(path):
    from fontTools.ttLib import TTFont
    return set(TTFont(str(path)).getBestCmap())


def as_ranges(codepoints):
    cps = sorted(codepoints)
    runs = []
    start = prev = cps[0]
    for c in cps[1:]:
        if c == prev + 1:
            prev = c
            continue
        runs.append((start, prev))
        start = prev = c
    runs.append((start, prev))
    return ','.join(f'U+{a:04x}' if a == b else f'U+{a:04x}-{b:04x}' for a, b in runs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--range', action='store_true', help='只打印首屏字集的 unicode-range')
    ap.add_argument('--report', action='store_true', help='给 lint 用：吐一份 JSON 现状')
    args = ap.parse_args()

    first = cmap_of(FONT_DIR / 'lxgw-nd-regular.woff2')
    if args.range:
        print(as_ranges(first))
        return 0
    if args.report:
        import json
        app = cmap_of(FONT_DIR / 'lxgw-nd-app-regular.woff2')
        app_bold = cmap_of(FONT_DIR / 'lxgw-nd-app-bold.woff2')
        first_bold = cmap_of(FONT_DIR / 'lxgw-nd-bold.woff2')
        need = source_chars()
        print(json.dumps({
            'firstRange': as_ranges(first),
            'firstCount': len(first),
            'appCount': len(app),
            # 缺字 = 界面上会出现、但两级字集都没有的字（这些字会掉到 Screen 那一刀去）
            'missing': sorted({c for c in need if ord(c) not in app}),
            'weightsMatch': sorted(app) == sorted(app_bold) and sorted(first) == sorted(first_bold),
        }, ensure_ascii=False))
        return 0

    base = {chr(c) for c in range(0x20, 0x7f)} | set(EXTRA)
    tiers = {
        # 首屏字集：只装登录墙那一屏，秒显用。⚠️ 它必须真的装全那一屏 —— 少一个字，
        # 那个字就得等 220KB 的全站字集下完（08-29 之前是等不到，直接宋体）。
        '': first_chars() | base,
        # 全站字集：web/src 里所有会上屏的字，兜住首屏之外的一切。
        'app-': source_chars() | base,
    }
    txt = FONT_DIR / '.subset-chars.txt'
    for prefix, chars in tiers.items():
        txt.write_text(''.join(sorted(chars)), encoding='utf-8')
        cjk = [c for c in chars if '一' <= c <= '鿿']
        print(f'{prefix or "首屏"}字表：{len(chars)} 个码位（汉字 {len(cjk)}）')
        for weight, src in SRC_FONTS.items():
            out = FONT_DIR / f'lxgw-nd-{prefix}{weight}.woff2'
            subprocess.run([
                sys.executable, '-m', 'fontTools.subset', src,
                f'--text-file={txt}', '--flavor=woff2', f'--output-file={out}',
                '--layout-features=', '--no-hinting', '--desubroutinize',
            ], check=True)
            print(f'  {out.name}  {out.stat().st_size // 1024}KB')
    txt.unlink()

    # unicode-range 是从文件的真实 cmap 生成的，所以字集一重切就得跟着改；
    # 手工同步必漏，直接写回 CSS（font-subset.lint.test.js 会核对两者一致）。
    css_path = ROOT / 'web/src/styles/globals.css'
    css = css_path.read_text(encoding='utf-8')
    rng = as_ranges(cmap_of(FONT_DIR / 'lxgw-nd-regular.woff2'))
    css2 = re.sub(r'(?<=\n  unicode-range: )[^;]+(?=;)', rng, css)
    if css2 != css:
        css_path.write_text(css2, encoding='utf-8')
        print(f'globals.css 的 unicode-range 已更新（{rng.count(",") + 1} 段）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
