/**
 * server/engine/runs/board-tasklist.js —— 把 agent 的步骤清单镜像成板书（2026-08-23）
 *
 * 用户定的文化：板书是基础设施。agent 开工时用 TodoWrite 列的步骤不该只活在侧栏的计划
 * 面板里 —— 它是这一轮的骨架，该写在画布上、每一步产出的东西连到对应步骤。
 * 这件事**由 harness 做，不靠 agent 记得**：
 *   - run.todo.updated → 一条板书 `notes/板书/<stamp>-步骤.md`（一轮一条、原地更新），
 *     Markdown 任务列表：✓ 已做 / → 正在（加粗）/ 待做；落定不走 staging
 *   - run.file_changed（有"正在"的步骤时）→ 这条板书到那件产物的 annotates 线，label「第 N 步」，
 *     by:'auto'（不算进主角焦点分；同一轮同一件只连一次）
 *   - run.done/cancelled/error → 忘掉这一轮的状态（板书留着，它是过程记录）
 * 挂在 project bus 上（broker.getProjectBus 建 bus 时调一次），与 live-turn 折叠器同级。
 * 失败一律吞掉只 warn：镜像挂了不能影响 run。
 */
import path from 'node:path';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import { textBox, findSpot } from '../../lib/sketch-layout.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { renderChalk, writeChalkFile, CHALK_DIR } from '../../lib/chalk.js';

const byRun = new Map();   // runId → { projectId, rel, fileName, items, linked:Set, session }
const MAX_LINKS_PER_RUN = 24;

function renderList(items) {
  const lines = ['### 这一轮的步骤', ''];
  items.forEach((it, i) => {
    const text = String(it.content || it.activeForm || '').trim() || `步骤 ${i + 1}`;
    if (it.status === 'completed') lines.push(`- [x] ${text}`);
    else if (it.status === 'in_progress') lines.push(`- [ ] **→ ${it.activeForm || text}**`);
    else lines.push(`- [ ] ${text}`);
  });
  return lines.join('\n');
}

/** 工作区相对路径 → 画布 id（产物卡的地址）：精确 > deck: > 站点/word 根 > 原样 */
export function canvasIdForRel(board, rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r) return null;
  const objs = board.objects || {};
  if (objs[r]) return r;
  const norm = normalizeCanvasId(r);
  if (norm && objs[norm]) return norm;
  for (const id of Object.keys(objs)) {
    const m = /^(site|docx):(.+)$/.exec(id);
    if (!m) continue;
    const root = m[2];
    if (r === root || r.startsWith(`${root}/`)) return id;
  }
  // 还没上墙：按形态猜（seated 之后线自然画出来）
  return norm || r;
}

async function upsert(st, items) {
  st.items = items;
  const body = renderList(items);
  const content = renderChalk({ body, by: 'agent', tag: st.tag, sessionId: st.session || null });
  const sharedRoot = getSharedDir(st.projectId);
  if (!st.fileName) st.fileName = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-步骤.md`;
  st.rel = await writeChalkFile(sharedRoot, st.fileName, content, { overwrite: !!st.rel });
  st.fileName = st.rel.split('/').pop();   // 首写可能被加了防撞序号，之后原地覆盖同一个文件
  const board = await readBoard(st.projectId);
  const box = textBox(body, 'md', { md: true, wUnits: 14 });
  const prev = board.objects?.[st.rel];
  if (prev && Number.isFinite(prev.x)) {
    // 已有座位：只改高（行数变了）不碰宽 —— 宽由前端量过真值，回写会跟它来回抖（fable P2）
    await patchBoard(st.projectId, { objects: { [st.rel]: { ...prev, h: box.h } } });
    return;
  }
  // 首次落位：用户视口的空地 > 内容底下（跟 write_on_board 同口径）
  const known = new Set(Object.keys(board.zones || {}));
  const obstacles = Object.entries(board.objects || {})
    .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === '')
    .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
  let bottom = 0; for (const o of obstacles) bottom = Math.max(bottom, o.y + o.h);
  for (const zz of Object.values(board.zones || {})) if (Number.isFinite(zz?.y)) bottom = Math.max(bottom, zz.y + 240);
  const vp = getViewpoint(st.projectId);
  const vpRect = (vp && !vp.layer && vp.camera) ? vp.camera : null;
  const spot = findSpot({ w: box.w + 24, h: box.h + 24, obstacles, contentBottom: bottom, viewport: vpRect });
  await patchBoard(st.projectId, { objects: { [st.rel]: { x: spot.x + 12, y: spot.y + 12, z: 1, w: box.w, h: box.h, by: 'agent', seat: 'auto', tag: st.tag } } });
}

export function attachBoardTasklist(bus, projectId) {
  const handle = async (evt) => {
    if (!evt?.runId) return;
    if (evt.type === 'run.todo.updated') {
      const items = Array.isArray(evt.todos) ? evt.todos.filter(t => t && typeof t === 'object') : [];
      if (!items.length) return;
      let st = byRun.get(evt.runId);
      if (!st) {
        st = { projectId, rel: null, fileName: null, items: [], linked: new Set(), session: evt.sessionId || null, tag: `步骤-${String(evt.runId).slice(-6)}` };
        byRun.set(evt.runId, st);
      }
      await upsert(st, items);
      bus.publish({ type: 'board.updated', sessionId: null, runId: evt.runId, summary: '步骤清单上板' });
      return;
    }
    if (evt.type === 'run.file_changed') {
      const st = byRun.get(evt.runId);
      if (!st?.rel || !evt.filePath) return;
      const idx = st.items.findIndex(t => t.status === 'in_progress');
      if (idx < 0) return;
      // 只连工作区内、非隐藏目录的真产物；每轮封顶（否则 /tmp、.nd、.claude 里的写入会灌一堆
      // 指向虚空的 auto 线，MAX_BINDINGS 一到用户自己的线都不收 —— fable 08-23 P2）
      const rel = String(evt.filePath).replace(/\\/g, '/');
      if (rel.startsWith('/') || rel.split('/').some(seg => seg === '..' || seg.startsWith('.') || seg === 'node_modules')) return;
      if (rel.startsWith(`${CHALK_DIR}/`) || rel.startsWith('notes/')) return;
      if (st.linked.size >= MAX_LINKS_PER_RUN) return;
      const board = await readBoard(st.projectId);
      const target = canvasIdForRel(board, evt.filePath);
      if (!target || target === st.rel || target.startsWith(`${CHALK_DIR}/`)) return;
      if (st.linked.has(target)) return;
      st.linked.add(target);
      const id = `b:auto:step:${String(evt.runId).slice(-6)}:${st.linked.size}`;
      await patchBoard(st.projectId, { bindings: { [id]: { type: 'annotates', from: st.rel, to: target, by: 'auto', label: `第 ${idx + 1} 步`, tag: st.tag } } });
      bus.publish({ type: 'board.updated', sessionId: null, runId: evt.runId, summary: `第 ${idx + 1} 步 → ${path.basename(target)}` });
      return;
    }
    if (evt.type === 'run.done' || evt.type === 'run.cancelled' || evt.type === 'run.error') {
      byRun.delete(evt.runId);
    }
  };
  bus.subscribe('*', (evt) => {
    handle(evt).catch(err => console.warn('[board-tasklist]', err?.message || err));
  });
}

export function _resetBoardTasklist() { byRun.clear(); }
