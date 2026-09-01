/**
 * server/engine/runs/board-tasklist.js —— 把 agent 的步骤清单镜像成板书（2026-08-23）
 *
 * 用户定的文化：板书是基础设施。agent 开工时用 TodoWrite 列的步骤不该只活在侧栏的计划
 * 面板里 —— 它是这一轮的骨架，该写在画布上、每一步产出的东西连到对应步骤。
 * 这件事**由 harness 做，不靠 agent 记得**。
 *
 * ## 2026-08-30 改版：一个项目一张，可更新的版面组件
 *
 * 原来一轮（runId）一张便签，真板实证（proj_mtfz7n8p）：同一场会话两轮就两张
 * 几乎一样的「步骤」，服务端一重启在内存的台账也丢，下一轮又新建 —— 板上全是
 * 步骤便签的尸体。站主拍板改成**项目单例**：
 *   - run.todo.updated → 全项目共用一张 `notes/板书/<stamp>-步骤.md`（tag=步骤），
 *     内容原地重写；内存台账丢了就按 tag 从板上**认领旧的**，不再新建
 *   - 首次落位上暂存架（seat:'shelf'，机器的手只够得到架）；agent/用户挪过之后
 *     位置跨轮保留 —— 它就是一块可以被 edit_board move 经营的版面组件
 *   - run.file_changed（有"正在"的步骤时）→ 便签到那件产物的 annotates 线，
 *     label「第 N 步」，by:'auto'
 *   - run.done/cancelled/error → **拆掉这一轮拉出去的 auto 步骤线**（线说的是
 *     "正在其上工作"，工完线收；便签本身留着）
 * 并发的轮各自记账、渲染时拼在同一张上（峰值并发 4，罕见且下一次更新就纠正）。
 * 挂在 project bus 上；失败一律吞掉只 warn：镜像挂了不能影响 run。
 */
import path from 'node:path';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import { textBox } from '../../lib/sketch-layout.js';
import { resolveShelfOrigin, nextShelfSpot } from '../../lib/board-shelf.js';
import { renderChalk, writeChalkFile, CHALK_DIR } from '../../lib/chalk.js';

const TAG = '步骤';
const byProject = new Map();   // projectId → { rel, fileName, runs: Map(runId → {items, linked:Set, session}) }
const MAX_LINKS_PER_RUN = 24;

function renderItems(items) {
  const out = [];
  items.forEach((it, i) => {
    const text = String(it.content || it.activeForm || '').trim() || `步骤 ${i + 1}`;
    if (it.status === 'completed') out.push(`- [x] ${text}`);
    else if (it.status === 'in_progress') out.push(`- [ ] **→ ${it.activeForm || text}**`);
    else out.push(`- [ ] ${text}`);
  });
  return out;
}

function renderList(runs) {
  const lines = ['### 这一轮的步骤', ''];
  const active = [...runs.values()].filter(r => r.items.length);
  active.forEach((r, idx) => {
    if (idx > 0) lines.push('');   // 并发的轮拼在同一张上，段间空行分隔
    lines.push(...renderItems(r.items));
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

/** 内存台账丢了（重启）就按 tag 从板上认领旧便签 —— 这是"不再新建"的另一半 */
function adoptExisting(st, board) {
  if (st.rel) return;
  const hits = Object.entries(board.objects || {})
    .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && e?.by === 'agent'
      && typeof e?.tag === 'string' && (e.tag === TAG || e.tag.startsWith(`${TAG}-`)))
    .map(([id]) => id)
    .sort();
  if (hits.length) { st.rel = hits[hits.length - 1]; st.fileName = st.rel.split('/').pop(); }
}

async function upsert(st, projectId, session) {
  const body = renderList(st.runs);
  const content = renderChalk({ body, by: 'agent', tag: TAG, sessionId: session || null });
  const sharedRoot = getSharedDir(projectId);
  const board = await readBoard(projectId);
  adoptExisting(st, board);
  if (!st.fileName) st.fileName = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')}-步骤.md`;
  st.rel = await writeChalkFile(sharedRoot, st.fileName, content, { overwrite: !!st.rel });
  st.fileName = st.rel.split('/').pop();   // 首写可能被加了防撞序号，之后原地覆盖同一个文件
  const box = textBox(body, 'md', { md: true, wUnits: 14 });
  const prev = board.objects?.[st.rel];
  if (prev && Number.isFinite(prev.x)) {
    // 已有座位：只改高（行数变了）不碰宽/位置 —— 宽由前端量过真值，位置是
    // agent/用户经营出来的，跨轮保留（可更新的版面组件正是这个意思）
    await patchBoard(projectId, { objects: { [st.rel]: { ...prev, h: box.h, tag: TAG } } });
    return;
  }
  // 首次落位（2026-08-30 暂存架）：机器的手只够得到架
  const known = new Set(Object.keys(board.zones || {}));
  const obstacles = Object.entries(board.objects || {})
    .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === '')
    .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
  const vp = getViewpoint(projectId);
  const origin = resolveShelfOrigin(board, (vp?.camera && !vp.layer) ? vp.camera : null);
  const spot = nextShelfSpot(origin);   // 一摞：所有货叠在原点（2026-09-01）
  await patchBoard(projectId, {
    objects: { [st.rel]: { x: spot.x, y: spot.y, z: 1, w: box.w, h: box.h, by: 'agent', seat: 'shelf', tag: TAG } },
    ...(origin.changed ? { shelf: { x: origin.x, y: origin.y } } : {}),
  });
}

export function attachBoardTasklist(bus, projectId) {
  const handle = async (evt) => {
    if (!evt?.runId) return;
    let st = byProject.get(projectId);
    if (evt.type === 'run.todo.updated') {
      const items = Array.isArray(evt.todos) ? evt.todos.filter(t => t && typeof t === 'object') : [];
      if (!items.length) return;
      if (!st) { st = { rel: null, fileName: null, runs: new Map() }; byProject.set(projectId, st); }
      let run = st.runs.get(evt.runId);
      if (!run) { run = { items: [], linked: new Set(), session: evt.sessionId || null }; st.runs.set(evt.runId, run); }
      run.items = items;
      await upsert(st, projectId, run.session);
      bus.publish({ type: 'board.updated', sessionId: null, runId: evt.runId, summary: '步骤清单上板' });
      return;
    }
    if (evt.type === 'run.file_changed') {
      const run = st?.runs?.get(evt.runId);
      if (!st?.rel || !run || !evt.filePath) return;
      const idx = run.items.findIndex(t => t.status === 'in_progress');
      if (idx < 0) return;
      // 只连工作区内、非隐藏目录的真产物；每轮封顶（否则 /tmp、.nd、.claude 里的写入会灌一堆
      // 指向虚空的 auto 线，MAX_BINDINGS 一到用户自己的线都不收 —— fable 08-23 P2）
      const rel = String(evt.filePath).replace(/\\/g, '/');
      if (rel.startsWith('/') || rel.split('/').some(seg => seg === '..' || seg.startsWith('.') || seg === 'node_modules')) return;
      if (rel.startsWith(`${CHALK_DIR}/`) || rel.startsWith('notes/')) return;
      if (run.linked.size >= MAX_LINKS_PER_RUN) return;
      const board = await readBoard(projectId);
      const target = canvasIdForRel(board, evt.filePath);
      if (!target || target === st.rel || target.startsWith(`${CHALK_DIR}/`)) return;
      if (run.linked.has(target)) return;
      run.linked.add(target);
      const id = `b:auto:step:${String(evt.runId).slice(-6)}:${run.linked.size}`;
      await patchBoard(projectId, { bindings: { [id]: { type: 'annotates', from: st.rel, to: target, by: 'auto', label: `第 ${idx + 1} 步`, tag: TAG } } });
      bus.publish({ type: 'board.updated', sessionId: null, runId: evt.runId, summary: `第 ${idx + 1} 步 → ${path.basename(target)}` });
      return;
    }
    if (evt.type === 'run.done' || evt.type === 'run.cancelled' || evt.type === 'run.error') {
      const run = st?.runs?.get(evt.runId);
      if (!run) return;
      st.runs.delete(evt.runId);
      // 工完线收：这一轮拉出去的 auto 步骤线说的是"正在其上工作"，轮结束就拆
      if (run.linked.size) {
        const dead = {};
        for (let n = 1; n <= run.linked.size; n += 1) dead[`b:auto:step:${String(evt.runId).slice(-6)}:${n}`] = null;
        await patchBoard(projectId, { bindings: dead });
      }
    }
  };
  bus.subscribe('*', (evt) => {
    handle(evt).catch(err => console.warn('[board-tasklist]', err?.message || err));
  });
}

export function _resetBoardTasklist() { byProject.clear(); }
