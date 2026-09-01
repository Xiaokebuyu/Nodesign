#!/usr/bin/env node
/**
 * 叠纸的真渲验收（2026-09-01）。
 *
 * ## 为什么这一条非要真跑
 *
 * 这一批加的东西里，**藏页是唯一单测照不出来的**：单测看的是「物件清单里还剩几件」，
 * 而用户看的是 DOM 里还剩几个节点。中间隔着入座、渲染分派、命中区三层，任何一层
 * 把过滤漏掉，清单是对的而屏幕是错的。08-13 那天三个 bug（工具栏落点被父组件抹掉 /
 * node 组被过滤 / 迟到的组把工具栏挤偏）`vite build` 和 267 个单测一个都没照出来，
 * 就是这个形状。
 *
 * 走检查通道（scripts/inspect.mjs）：整站拦下来喂 fixtures 里那块板，服务端自带的
 * chromium 真渲染一遍。fixture 里 `s1`/`s2` 两页**占同一块地**，各有一件认领了页的墨。
 *
 * 五条判据：
 *   ① 起手只画得出最上面那一页的墨（藏页真的发生在 DOM 上）
 *   ② agent 的 show 那条路（ui.show_sheet → 窗口事件）翻得动页
 *   ③ 翻页那一小段里**两页都在**（旧页要留着滑出去，藏了就是硬切）
 *   ④ 滑完只剩新页
 *   ⑤ 翻页器读数对、目录列得出所有的摞和页
 *
 * 用法：node web/scripts/stack-probe.mjs
 *      退出码非 0 = 有判据没过。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROBE = `(async () => {
  const q = (s) => document.querySelector(s);
  const has = (id) => !!document.querySelector('[data-board-object="' + id + '"]');
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  out.start = { A: has('text:stackA'), B: has('text:stackB') };
  window.dispatchEvent(new CustomEvent('nd:show-sheet', { detail: { sheet: 's1' } }));
  await nap(120);
  out.during = { A: has('text:stackA'), B: has('text:stackB') };
  await nap(800);
  out.after = { A: has('text:stackA'), B: has('text:stackB') };
  out.pager = q('[data-stack-pager="index"]')?.textContent || null;
  q('[data-stack-pager="index"]')?.click();
  await nap(300);
  out.index = [...document.querySelectorAll('[data-board-index="page"]')].map((b) => b.textContent.trim());
  // 册（2026-09-01）：版式画得出来吗、拖得动吗
  out.guides = [...document.querySelectorAll('[data-slot-guide]')].map((e) => e.getAttribute('data-slot-guide'));
  const g = document.querySelector('[data-slot-guide="main"]');
  const h = document.querySelector('[data-slot-handle="main:y"]');
  if (g && h) {
    out.slotH0 = g.style.height;
    const r = h.getBoundingClientRect();
    // 先问「真指针点那儿会打到谁」：直接往元素上派事件绕过了命中测试，
    // 第一版判据就栽在这上面 —— 把命中带改成 pointerEvents:none（等于整个不可改）
    // 之后测试照样绿。elementFromPoint 走浏览器真正那套命中，z 序也算数。
    // ⚠️ 这段注释在模板串里，别写反引号（写了整个文件当场炸，这仓库栽过两次）。
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.hitHandle = hit?.getAttribute?.('data-slot-handle') || null;
    const opt = (x, y) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y });
    h.dispatchEvent(new PointerEvent('pointerdown', opt(r.x + 2, r.y + 2)));
    await nap(60);
    h.dispatchEvent(new PointerEvent('pointermove', opt(r.x + 2, r.y + 2 + 150)));
    await nap(60);
    out.slotH1 = document.querySelector('[data-slot-guide="main"]').style.height;
    h.dispatchEvent(new PointerEvent('pointerup', opt(r.x + 2, r.y + 2 + 150)));
    await nap(150);
  }
  return JSON.stringify(out);
})()`;

const raw = execFileSync('node', [
  path.join(HERE, 'inspect.mjs'), '/projects/p_demo/work',
  `--probe=${PROBE}`, '--viewport=1440x900',
], { cwd: path.join(HERE, '..'), encoding: 'utf8', timeout: 240000 });
const res = JSON.parse(raw.slice(raw.indexOf('{')));
const p = JSON.parse(res.probe);

const checks = [
  ['页面零报错', res.errors.length === 0, res.errors],
  ['① 起手只画最上面那一页', p.start.A === false && p.start.B === true, p.start],
  ['② show 翻得动页（滑完 s1 露出来）', p.after.A === true, p.after],
  ['③ 过渡期间两页都在（旧页留着滑出去）', p.during.A && p.during.B, p.during],
  ['④ 滑完旧页走了', p.after.B === false, p.after],
  ['⑤ 翻页器读数对', /1\/2$/.test(p.pager || ''), p.pager],
  ['⑥ 目录列得出叠起来那两页', p.index.some((r) => r.includes('叠·第一页')) && p.index.some((r) => r.includes('叠·第二页')), p.index],
  // 册：版式长在摞上，两页都不带自己的 slots，所以画出来的是继承来的那一份
  ['⑦ 摞的版式画得出来（继承，两页都没自己声明）', p.guides.includes('main') && p.guides.includes('aside'), p.guides],
  ['⑧ 命中带真的接得到指针（不是只有 handler 挂着）', !!p.hitHandle, p.hitHandle],
  ['⑨ 拖得动（拖完高度真变了）', !!p.slotH1 && p.slotH1 !== p.slotH0, [p.slotH0, p.slotH1]],
];
let bad = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ← ${JSON.stringify(detail)}`}`);
  if (!ok) bad += 1;
}
console.log(bad ? `\n${bad} 条没过` : '\n全过');
process.exit(bad ? 1 : 0);
