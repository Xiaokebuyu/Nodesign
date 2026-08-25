/**
 * _probe-board-perf.mjs —— 板书性能探针（2026-08-25，范式重做验收 + 「文字太多卡」的量具）
 *
 * 用法：node --env-file=.env server/_probe-board-perf.mjs [条数=200] [--keep]
 *
 * 做什么：建一个探针项目（挂 admin 当 owner）→ 落 N 条 md 板书（带表格/加粗，
 * 贴近真 RP 版面）→ 用 look_at_board 同一条通路开真画布页 → 量三样：
 *   1. 首屏：DOMContentLoaded → data-eye-ready 的耗时
 *   2. 静置 3s 的帧时序（rAF 采样：均值 / p95 / 最大）
 *   3. 连续滚轮平移 3s 的帧时序（拖拽/平移是重渲染路径：入座 memo 依赖 layout）
 * 完了删项目（--keep 保留）。
 */
import { launchPerceptionBrowser } from './engine/mcp/tools/helpers/perception-page.js';
import { createProject, deleteProject } from './projects/store.js';
import { getSharedDir, ensureProjectWorkspace } from './projects/workspace.js';
import { patchBoard } from './projects/board-store.js';
import { renderChalk, chalkFileName, writeChalkFile } from './lib/chalk.js';
import { listUsers } from './auth/users-store.js';
import { mintToken, COOKIE_NAME, authEnabled } from './auth/session.js';

const N = Number(process.argv[2]) || 200;
const keep = process.argv.includes('--keep');
const origin = String(process.env.NODESIGN_WEB_ORIGIN || '').trim().replace(/\/+$/, '');
if (!origin) { console.error('需要 NODESIGN_WEB_ORIGIN（跑的时候 --env-file=.env）'); process.exit(1); }

const admin = listUsers().find(u => u.role === 'admin' && !u.disabled);
if (!admin) { console.error('找不到 admin 用户'); process.exit(1); }

const proj = createProject({ name: `板书性能探针-${N}`, kind: 'project', ownerId: admin.id });
console.log('project:', proj.id, 'owner:', admin.id);
await ensureProjectWorkspace(proj.id);
const root = getSharedDir(proj.id);

const BODY = (i) => `### 第${i}章：试炼\n\n他把**「钥匙」**放回石案上，火光一颤。\n\n| 检定 | DC | 骰 | 结果 |\n| --- | --- | --- | --- |\n| 潜行 | 13 | 9 | 失败 |\n| 察觉 | 12 | 17 | 成功 |\n\n- 线索：北墙的划痕是新的\n- 代价：老货郎被人看见了`;

console.time('seed');
const objects = {};
const cols = 8;
for (let i = 0; i < N; i += 1) {
  const body = BODY(i);
  const name = chalkFileName(body, new Date(Date.now() + i * 1000));
  // eslint-disable-next-line no-await-in-loop
  const rel = await writeChalkFile(root, name, renderChalk({ body, by: 'agent', tag: '章节' }));
  objects[rel] = { x: (i % cols) * 480, y: Math.floor(i / cols) * 380, z: 1, w: 432, h: 320, by: 'agent', seat: 'auto', tag: '章节' };
}
await patchBoard(proj.id, { objects });
console.timeEnd('seed');

const url = `${origin}/projects/${encodeURIComponent(proj.id)}/work?eye=1`;
let browser = null;
try {
  browser = await launchPerceptionBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  if (authEnabled()) await context.addCookies([{ name: COOKIE_NAME, value: mintToken(admin.id), url: origin }]);
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const tDcl = Date.now();
  await page.waitForSelector('html[data-eye-ready="1"]', { timeout: 30_000 });
  const tReady = Date.now();
  console.log(`首屏：goto→DCL ${tDcl - t0}ms，DCL→eye-ready ${tReady - tDcl}ms`);

  const sample = (ms) => page.evaluate((dur) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const t1 = last + dur;
    function tick(now) {
      frames.push(now - last); last = now;
      if (now < t1) requestAnimationFrame(tick); else resolve(frames.slice(1));
    }
    requestAnimationFrame(tick);
  }), ms);
  const stats = (fr) => {
    const s = [...fr].sort((a, b) => a - b);
    const avg = fr.reduce((n, v) => n + v, 0) / fr.length;
    return `均值 ${avg.toFixed(1)}ms / p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)}ms / 最大 ${s[s.length - 1].toFixed(1)}ms / ${fr.length} 帧`;
  };

  console.log('静置 3s：', stats(await sample(3000)));

  // 连续滚轮平移（同 inspect 通道的手法：mouse.wheel 会走画布的相机路径）
  await page.mouse.move(700, 450);
  const panPromise = (async () => {
    for (let i = 0; i < 30; i += 1) {
      await page.mouse.wheel(0, 240);
      await new Promise(r => setTimeout(r, 90));
    }
  })();
  const panFrames = await sample(2800);
  await panPromise;
  console.log('滚轮平移 3s：', stats(panFrames));

  // 顺手：一次 setLayout 级联的成本（模拟拖拽帧）—— 用 CDP 看 DOM 节点数当规模注脚
  const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
  console.log('DOM 节点数：', nodes);
} finally {
  try { await browser?.close(); } catch { /* noop */ }
  if (!keep) { deleteProject(proj.id); console.log('cleaned', proj.id); }
  else console.log('kept:', proj.id, url);
}
