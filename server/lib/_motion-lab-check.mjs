/**
 * 时间维度感知的真跑校验（2026-08-19，iss_mszv782a_toab）。
 *
 * 为什么必须真跑：screencast 帧时间戳对不对、采样器在真 rAF 里跑不跑、
 * 音频钩子逮不逮得住 play()、ffmpeg 合不合得出片 —— 纯函数一样都测不到。
 *
 * 判据本身要先验一遍：这页动画是**手工构造的对照组**，每个待测判断都有
 * 已知真值 —— easeOutBack 过冲 ≈9.7%、t=800ms 处一次单帧瞬移、t≈500ms
 * 一个 130ms 忙等（掉帧）、t=300ms 一次 play() 尝试。工具量出来的数字
 * 必须跟构造值对上，对不上就是工具错了。
 *
 * 跑法：node server/lib/_motion-lab-check.mjs
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileUrl } from './file-url.js';

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-motion-check-'));
// ⛔ 先把库指走再 import 任何 server 模块：后面穿工具本体那两节的 import 链
// 会带进 engine/runs/store.js，不指走就是打开**生产库**（测试写生产库旧案）。
process.env.DB_PATH = path.join(TMP, 'check.db');
process.env.PROJECTS_DATA_DIR = process.env.PROJECTS_DATA_DIR || TMP;
const {
  recordMotion, pickNearestFrames, composeSheet, encodeWebm, seriesReport, frameHealth,
} = await import('../engine/mcp/tools/helpers/motion-lab.js');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`); return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 对照组页面：一切时序已知 ─────────────────────────────────────
const PAGE = path.join(TMP, 'anim.html');
await fs.writeFile(PAGE, `<!doctype html><meta charset="utf-8"><title>c</title>
<body style="margin:0;background:#fff">
<div id="box" style="position:absolute;left:0;top:200px;width:80px;height:80px;background:#e4572e"></div>
<button id="btn" style="position:absolute;left:10px;top:10px">go</button>
<script>
  const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  let burned = false;
  window.__go = () => {
    const t0 = performance.now();
    const box = document.getElementById('box');
    try { new Audio().play().catch(() => {}); setTimeout(() => {}, 0); } catch (e) {}
    let audioDone = false;
    const step = () => {
      const t = performance.now() - t0;
      if (!audioDone && t >= 300) { audioDone = true; try { new Audio().play().catch(() => {}); } catch (e) {} }
      if (!burned && t >= 500) { burned = true; const s = performance.now(); while (performance.now() - s < 130) {} }
      let x;
      if (t <= 600) x = 300 * easeOutBack(t / 600);
      else if (t >= 800 && t < 900) x = 100;      // ← 单帧瞬移（硬切）
      else x = 300;
      box.style.left = x + 'px';
      if (t < 1600) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  document.getElementById('btn').addEventListener('click', window.__go);
</script>
</body>`, 'utf8');

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(fileUrl(PAGE));

// ── 1. 完整录制：trigger + 表达式 + screencast ─────────────────────
console.log('1. recordMotion（trigger + 表达式 + screencast）');
const rec = await recordMotion(page, {
  durationMs: 1500,
  trigger: 'window.__go()',
  expressions: { x: "document.getElementById('box').getBoundingClientRect().left" },
  wantShots: true, shotMaxW: 800, shotMaxH: 500,
});
ok('screencast 有帧', rec.shots.length >= 8, `${rec.shots.length} 帧`);
ok('采样行数够', rec.rows.length >= 40, `${rec.rows.length} 行`);
ok('表达式无报错', !rec.errs.x, rec.errs.x || '');
ok('trigger 无报错', !rec.triggerNote, rec.triggerNote || '');

// ── 2. 曲线判读对上构造值 ─────────────────────────────────────────
console.log('2. seriesReport 对照已知真值');
const rep = seriesReport(rec.rows.map((r) => ({ t: r.t, v: r.x })));
ok('终值 ≈300', rep.ok && Math.abs(rep.final - 300) < 8, `final=${rep.final?.toFixed(1)}`);
ok('过冲落在 5~14%（构造值 9.7%）', rep.overshootPct > 5 && rep.overshootPct < 14, `${rep.overshootPct?.toFixed(1)}%`);
ok('逮到硬切且时刻在 760~980ms', rep.cuts.some((t) => t > 760 && t < 980), `cuts=[${rep.cuts}]`);

// ── 3. 帧健康逮到 130ms 忙等 ──────────────────────────────────────
console.log('3. frameHealth 对照已知卡顿');
const fh = frameHealth(rec.rafTs);
ok('最长帧 ≥110ms（构造 130ms 忙等）', fh.ok && fh.worst >= 110, `worst=${fh.worst?.toFixed(0)}ms`);

// ── 4. 音频钩子 ───────────────────────────────────────────────────
console.log('4. 音频事件钩子');
ok('逮到 play() 尝试', rec.audio.length >= 1, `${rec.audio.length} 条`);
const nearTrigger = rec.audio.some((a) => a.t > -50 && a.t < 150);
const at300 = rec.audio.some((a) => a.t > 250 && a.t < 450);
ok('时刻对得上（t≈0 和 t≈300 各一次）', nearTrigger && at300,
  rec.audio.map((a) => `${Math.round(a.t)}ms`).join(','));

// ── 5. 胶片条：取帧 + 拼图 + 画面真的在动 ─────────────────────────
console.log('5. 胶片条');
const wanted = [0, 150, 300, 600, 1200];
const picked = pickNearestFrames(rec.shots, wanted);
ok('每个时刻都有帧', picked.every(Boolean));
// last-≤-want 语义：绝不取未来帧；动画期间（前四个时刻）帧密，落后 ≤160ms
// （含构造的 130ms 忙等）；t=1200 落在动画停稳后的无重绘区，取到的必须是
// 停稳后（>900ms，瞬移已跳回）的最后一帧 —— 那就是屏幕在 1200ms 的真实画面。
ok('不取未来帧', picked.every((p) => p.actual <= p.want + 30),
  picked.map((p) => `${p.want}→${Math.round(p.actual)}`).join(','));
ok('动画期间取帧落后 ≤160ms', picked.slice(0, 4).every((p) => p.want - p.actual <= 160),
  picked.slice(0, 4).map((p) => `${p.want}→${Math.round(p.actual)}`).join(','));
ok('停稳区取的是停稳后的帧', picked[4].actual > 900, `1200→${Math.round(picked[4].actual)}`);
const sheet = await composeSheet(picked, {});
const { default: sharp } = await import('sharp');
const meta = await sharp(sheet.buf).metadata();
ok('拼图尺寸 = 布局值', meta.width === sheet.layout.sheetW && meta.height === sheet.layout.sheetH,
  `${meta.width}×${meta.height}`);
// 第 1 格（t=0，箱子在左）和第 4 格（t=600，箱子在 300px）画面必须不同
const cell = async (i) => {
  const col = i % sheet.layout.cols; const row = Math.floor(i / sheet.layout.cols);
  return sharp(sheet.buf).extract({
    left: sheet.layout.gap + col * (sheet.layout.cellW + sheet.layout.gap),
    top: sheet.layout.gap + row * (sheet.layout.cellH + sheet.layout.gap) + 30,  // 跳过标签条
    width: sheet.layout.cellW, height: sheet.layout.cellH - 30,
  }).raw().toBuffer();
};
const [c0, c3] = await Promise.all([cell(0), cell(3)]);
let diff = 0;
for (let i = 0; i < c0.length; i += 97) diff += Math.abs(c0[i] - c3[i]);
ok('t=0 与 t=600 两格画面不同（箱子真的动了）', diff / (c0.length / 97) > 2, `平均差 ${(diff / (c0.length / 97)).toFixed(1)}`);

// ── 6. 真实点击通道（click 而非 trigger）──────────────────────────
console.log('6. click 通道');
await page.reload();
const rec2 = await recordMotion(page, {
  durationMs: 700, click: '#btn',
  expressions: { x: "document.getElementById('box').getBoundingClientRect().left" },
  wantShots: false,
});
const rep2 = seriesReport(rec2.rows.map((r) => ({ t: r.t, v: r.x })));
ok('真点击触发了动画', rep2.ok && rep2.max > 250, `max=${rep2.max?.toFixed(0)}`);
ok('纯数值通道无 screencast', rec2.shots.length === 0);

// ── 7. webm 合成 ─────────────────────────────────────────────────
console.log('7. encodeWebm');
const outWebm = path.join(TMP, 'out.webm');
const enc = await encodeWebm(rec.shots, outWebm);
ok('webm 落盘且非空', enc.bytes > 5000, `${(enc.bytes / 1024).toFixed(0)}KB`);

await browser.close();

// ── 8/9. 穿工具本体（handler 直调；无 projectId → file:// 退化通道，wiring 为主）──
console.log('8. screenshot_canvas 胶片条（工具本体）');
const WS = path.join(TMP, 'ws');
await fs.mkdir(path.join(WS, 'tasks/demo'), { recursive: true });
await fs.copyFile(PAGE, path.join(WS, 'tasks/demo/canvas.html'));

const { makeScreenshotCanvasTool } = await import('../engine/mcp/tools/screenshot.js');
const shotTool = makeScreenshotCanvasTool({ workspaceRoot: WS, projectId: null, sessionId: null, ctx: null });
const r8 = await shotTool.handler({
  path: 'tasks/demo/canvas.html',
  frames: [0, 150, 300, 600, 1200],
  trigger: 'window.__go()',
  saveVideo: true,
});
const cap8 = r8.content?.[0]?.text || '';
ok('胶片条不报错', !r8.isError, cap8.slice(0, 200));
ok('返回带图', r8.content?.some((c) => c.type === 'image'));
ok('caption 有取帧表', /t=600ms/.test(cap8));
ok('caption 有帧健康', /frame health/.test(cap8));
ok('caption 有音频事件', /audio events/.test(cap8));
const webmMatch = cap8.match(/video saved: (\S+\.webm)/);
ok('webm 真落在 exports/motion/', !!webmMatch
  && (await fs.stat(path.join(WS, webmMatch[1])).then((s) => s.size > 1000).catch(() => false)),
webmMatch?.[1] || 'caption 里没有 video saved');

console.log('9. trace_motion（工具本体）');
const { makeTraceMotionTool } = await import('../engine/mcp/tools/trace-motion.js');
const traceTool = makeTraceMotionTool({ workspaceRoot: WS, projectId: null, sessionId: null });
const r9 = await traceTool.handler({
  path: 'tasks/demo/canvas.html',
  expressions: { x: "document.getElementById('box').getBoundingClientRect().left" },
  trigger: 'window.__go()',
  durationMs: 1500,
});
const cap9 = r9.content?.[0]?.text || '';
ok('trace 不报错', !r9.isError, cap9.slice(0, 200));
ok('量出过冲', /overshoot [5-9]|overshoot 1[0-4]/.test(cap9), (cap9.match(/overshoot [\d.]+%/) || [])[0]);
ok('标出硬切', /HARD CUT at 8\d\d|HARD CUT at 9[0-5]\d/.test(cap9), (cap9.match(/HARD CUT[^\n]*/) || [])[0]);
ok('带曲线图', r9.content?.some((c) => c.type === 'image'));

console.log(`\n${pass} 项通过${fails.length ? `，${fails.length} 项失败：\n  - ${fails.join('\n  - ')}` : '，全绿'}`);
console.log(`产物留在 ${TMP}（拼图/视频可人工过目）`);
await fs.writeFile(path.join(TMP, 'sheet.png'), sheet.buf);
process.exit(fails.length ? 1 : 0);
