/**
 * _probe-chalk-drag.mjs —— 板书拖拽复现探针（2026-08-25 用户报「带按钮的图拖不动」）
 * 用法：node --env-file=.env server/_probe-chalk-drag.mjs [--keep]
 *
 * 建探针项目 → 落两条板书（一条带 nd:controls 按钮、一条纯文字）→ 真浏览器
 * （admin cookie）。语义（08-25 拍板）：只认「改板书」开关 —— 关=拖不动，
 * 开（chalk_edit op）=直接拖。两态都验。
 */
import { launchPerceptionBrowser } from './engine/mcp/tools/helpers/perception-page.js';
import { createProject, deleteProject } from './projects/store.js';
import { getSharedDir, ensureProjectWorkspace } from './projects/workspace.js';
import { readBoard } from './projects/board-store.js';
import { makeWriteOnBoardTool } from './engine/mcp/tools/write-on-board.js';
import { listUsers } from './auth/users-store.js';
import { mintToken, COOKIE_NAME, authEnabled } from './auth/session.js';

const keep = process.argv.includes('--keep');
const origin = String(process.env.NODESIGN_WEB_ORIGIN || '').trim().replace(/\/+$/, '');
const admin = listUsers().find(u => u.role === 'admin' && !u.disabled);
const proj = createProject({ name: '板书拖拽探针', kind: 'project', ownerId: admin.id });
await ensureProjectWorkspace(proj.id);
console.log('project:', proj.id);

const write = makeWriteOnBoardTool({ projectId: proj.id, sharedRoot: getSharedDir(proj.id), sessionId: null, ctx: { emit() {} } });
await write.handler({ text: '纯文字板书，用来对照', at: { x: 100, y: 100 } });
await write.handler({ text: '带按钮的选项板书\n\n```nd:controls\n- [A] 跟上去 -> 选A\n- [B] 留下 -> 选B\n- [继续] send\n```', at: { x: 100, y: 400 } });
const before = await readBoard(proj.id);
const ids = Object.keys(before.objects).filter(id => id.startsWith('notes/板书/'));
console.log('chalks:', ids.map(id => `${id.split('/').pop()} @(${before.objects[id].x},${before.objects[id].y})`));

let browser = null;
try {
  browser = await launchPerceptionBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  if (authEnabled()) await context.addCookies([{ name: COOKIE_NAME, value: mintToken(admin.id), url: origin }]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
  await page.goto(`${origin}/projects/${encodeURIComponent(proj.id)}/work`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-board-object]', { timeout: 25_000 });
  await new Promise(r => setTimeout(r, 1500));

  const dragOn = async (id, phase) => {
    const sel = `[data-board-object="${id.replace(/"/g, '\\"')}"]`;
    const el = page.locator(sel).first();
    const box = await el.boundingBox();
    if (!box) { console.log('✗ 找不到元素：', id); return; }
    const px = box.x + box.width / 2; const py = box.y + 10;
    const b = (await readBoard(proj.id)).objects[id];
    await page.mouse.move(px, py);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) { await page.mouse.move(px + i * 20, py + i * 8); await new Promise(r => setTimeout(r, 30)); }
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 1200));
    const a = (await readBoard(proj.id)).objects[id];
    const moved = a.x !== b.x || a.y !== b.y;
    console.log(`[${phase}] ${id.split('/').pop()}：(${b.x},${b.y}) → (${a.x},${a.y}) seat:${a.seat} ${moved ? '动了' : '没动'}`);
    return moved;
  };
  console.log('\n== 开关关：都该拖不动 ==');
  for (const id of ids) { const m = await dragOn(id, '关'); console.log(m ? '✗ 不该动' : '✓'); }
  // agent 开「改板书」→ 前端当场生效（走真 WS 太绕：这里直接刷新读 ui-config）
  const { makeEditBoardTool } = await import('./engine/mcp/tools/edit-board.js');
  await makeEditBoardTool({ projectId: proj.id, sharedRoot: getSharedDir(proj.id), ctx: { emit() {} } })
    .handler({ ops: [{ op: 'chalk_edit', on: true }] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-board-object]', { timeout: 25000 });
  await new Promise(r => setTimeout(r, 1500));
  console.log('\n== 开关开：都该直接拖动 ==');
  for (const id of ids) { const m = await dragOn(id, '开'); console.log(m ? '✓' : '✗ 该动'); }
} finally {
  try { await browser?.close(); } catch { /* */ }
  if (!keep) { deleteProject(proj.id); console.log('\ncleaned', proj.id); }
  else console.log('\nkept:', proj.id);
}
