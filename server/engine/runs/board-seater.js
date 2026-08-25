/**
 * server/engine/runs/board-seater.js —— 服务端入座（2026-08-25 范式重做④）
 *
 * 病根（08-25 信箱实证）：入座算法原来只住前端 board-seating.js，只在浏览器渲染
 * 那一层时发生。agent 写完 `小说/第一章.md`，26 秒后 `write_on_board {near:它}`
 * 失败「还没有座位」，6 小时后依然没有 —— 用户没打开过那个文件夹。而工具描述
 * 正教 agent「Use it right after you finish something」。read_board 同病：刚写的
 * 文件看不见 → agent 误判"没上画布" → 去 pin → 重影。
 *
 * 这里把入座下沉：挂在 project bus 上收本轮的 run.file_changed，**回合末一批**
 * 排座（站主拍板的时机）。判据不新写黑名单 —— 复用 task-scan 的同一套排除件
 * （隐藏目录 / node_modules / _drafts / 保留文件），层隔离照 layerOf。
 *
 * 板书领养：prelude 说「你写的每张 .md 在桌面上渲成贴纸」，但 Write 直接落
 * notes/板书/ 的文件从来不上墙（10-05 friction）。这里把它领养成正式板书：
 * 认 frontmatter（nd: chalk 的 anchor/reply_to/tag），照 write_on_board 同款
 * 画线落座 —— 从此那句 prelude 是真话。
 *
 * 座位一律 seat:'auto'（可被前端重排）；已有座位的绝不动。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import { resolvePlacement } from '../../lib/board-place.js';
import { textBox } from '../../lib/sketch-layout.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { parseChalk, CHALK_DIR } from '../../lib/chalk.js';
import { isReservedFile, HARD_IGNORE_DIRS, DRAFTS_DIR } from '../../lib/task-scan.js';
import { canvasIdForRel } from './board-tasklist.js';

const MAX_SEATS_PER_RUN = 24;   // 一轮生成几百个文件的（构建产物漏网）也别刷爆板

/** 会渲染成卡的才配座位：跟 /artifacts 扫描同一套排除精神 */
export function seatable(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300) return false;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  if (segs.some(s => s === '..' || s === DRAFTS_DIR || HARD_IGNORE_DIRS.has(s))) return false;
  // 点开头的段（.nd/.claude/.thumbnails…）整条不渲染
  if (segs.some(s => s.startsWith('.'))) return false;
  if (isReservedFile(segs[segs.length - 1])) return false;
  return true;
}

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/**
 * 给一批相对路径排座（幂等：已有座位的跳过）。导出给测试与手动对账用。
 * @returns {Promise<{seated: number, lines: number}>}
 */
export async function seatArtifacts(projectId, rels) {
  const uniq = [...new Set(rels)].filter(seatable).slice(0, MAX_SEATS_PER_RUN * 2);
  if (!uniq.length) return { seated: 0, lines: 0 };
  const sharedRoot = getSharedDir(projectId);
  const board = await readBoard(projectId);
  const known = new Set(Object.keys(board.zones || {}));
  const vp = getViewpoint(projectId);
  const objects = {}; const bindings = {};
  // 本批内后来者要避开先来者：live 副本随排随更新
  const live = { ...board.objects };
  let seated = 0; let lines = 0;

  for (const rel of uniq) {
    if (seated >= MAX_SEATS_PER_RUN) break;
    const id = canvasIdForRel({ objects: live, zones: board.zones }, rel);
    if (!id) continue;
    if (live[id] && Number.isFinite(live[id].x)) continue;   // 已有座位
    // 文件还在才入座（本轮建又删的别复活）
    try { await fs.access(path.join(sharedRoot, rel)); } catch { continue; }

    let box = estimateSizeOn(board, id, null);
    let anchorRect = null; let replyRect = null;
    let anchorId = null; let parentId = null; let tag = null; let by = null;

    // 板书领养：Write 直接落盘的 notes/板书/*.md 按 frontmatter 接线
    if (rel.startsWith(`${CHALK_DIR}/`) && rel.endsWith('.md')) {
      try {
        const raw = await fs.readFile(path.join(sharedRoot, rel), 'utf8');
        const { body, chalk } = parseChalk(raw);
        if (chalk) {
          by = chalk.by;
          tag = chalk.tag || null;
          box = textBox(body, 'md', { md: true });
          if (chalk.anchor) {
            const aid = normalizeCanvasId(chalk.anchor);
            const e = aid && live[aid];
            if (e && Number.isFinite(e.x)) { anchorId = aid; anchorRect = { x: e.x, y: e.y, ...estimateSizeOn(board, aid, e) }; }
          }
          if (chalk.replyTo) {
            const pid2 = normalizeCanvasId(chalk.replyTo);
            const e = pid2 && live[pid2];
            if (e && Number.isFinite(e.x)) { parentId = pid2; replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) }; }
          }
        }
      } catch { /* 读不到就按普通文件排 */ }
    }

    const zone = layerOf(id, live[id], known);
    const obstacles = Object.entries(live)
      .filter(([oid, e]) => oid !== id && Number.isFinite(e?.x) && layerOf(oid, e, known) === zone)
      .map(([oid, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, oid, e) }));
    const contentBottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), 0);
    const vpRect = (vp && (vp.layer || '') === zone && vp.camera) ? vp.camera : null;
    const placed = resolvePlacement({
      box, anchor: anchorRect, replyTo: replyRect,
      obstacles, contentBottom, viewport: vpRect,
    });
    const entry = {
      x: Math.round(placed.x), y: Math.round(placed.y), z: 1,
      w: Math.round(box.w), h: Math.round(box.h),
      zone, seat: 'auto',
      ...(by ? { by } : {}), ...(tag ? { tag } : {}),
    };
    objects[id] = entry; live[id] = entry;
    seated += 1;
    if (anchorId) { bindings[`b:a${stamp()}`] = { type: 'annotates', from: id, to: anchorId, by: by || 'agent', ...(tag ? { tag } : {}) }; lines += 1; }
    if (parentId) { bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: id, by: by || 'agent', material: 'pencil', ...(tag ? { tag } : {}) }; lines += 1; }
  }

  if (seated) await patchBoard(projectId, { objects, bindings });
  return { seated, lines };
}

/** 挂 project bus：收整轮的 file_changed，run 收尾一批入座（与 board-tasklist 同栖） */
export function attachBoardSeater(bus, projectId) {
  const byRun = new Map();   // runId → Set<rel>
  bus.subscribe('*', async (evt) => {
    if (!evt?.runId) return;
    if (evt.type === 'run.file_changed') {
      // 两种历史载荷形状都认（Events.fileChanged 的 filePath / 内联对象的 path）
      const rel = typeof evt.filePath === 'string' ? evt.filePath : (typeof evt.path === 'string' ? evt.path : null);
      if (!rel || !seatable(rel)) return;
      let set = byRun.get(evt.runId);
      if (!set) { set = new Set(); byRun.set(evt.runId, set); }
      set.add(rel);
      return;
    }
    if (evt.type === 'run.done' || evt.type === 'run.cancelled' || evt.type === 'run.error') {
      const set = byRun.get(evt.runId);
      byRun.delete(evt.runId);
      if (!set?.size) return;
      try {
        const { seated } = await seatArtifacts(projectId, [...set]);
        if (seated) bus.publish({ type: 'board.updated', sessionId: null, summary: `${seated} 件新产物入了座` });
      } catch (err) {
        console.warn('[board-seater]', projectId, err?.message || err);
      }
    }
  });
}
