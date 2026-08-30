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
 *
 * ## 2026-08-30 刀 G：入座**不再自己铺纸**
 *
 * 站主拍板：「产物也需要 agent 提前规划放置位置落在纸上，甚至包括文件夹」。
 * 在此之前这里排不下就 allocateSheetRect 翻一张新纸 —— 那张纸没标题、没版位、
 * 署名 by:'agent'，而 agent 根本不知道它存在。真板实证（proj_mtfix5rv）：agent
 * Write 了 CLAUDE.md，入座顺手铺了 p1，agent 随后自己 open_sheet 开了 p2，板上
 * 从此永久留着一张空白无规划的纸。这正是「机器是兜底不是版面」要禁的事。
 *
 * 现在的三档：
 *   ① 这一页规划了 `for:'artifacts'` 的地 → 落进那块地（agent 事前说了放哪儿）
 *   ② 没规划但当前纸还排得下 → 纸内顺排（兜底，跟以前一样）
 *   ③ 排不下 → **不铺纸**，进 board.pending 待摆队列，每回合状态块点名，
 *      等 agent 规划出地方（open_sheet{plan} / pin_to_board 点名）再落座。
 * 唯一的例外是**一张纸都还没有**：那不是翻页，是开工，照旧铺第一张。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { obstaclesIn } from '../../lib/board-obstacles.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import {
  currentSheet, nextSpotInSheet, allocateSheetRect, sheetSizeFor, nextSheetName,
  placeThread, placeBeside, innerRect, inflateSpriteSeats, slotRectOf, nextSpotInSlot,
} from '../../lib/board-sheets.js';
import { textBox, fitFor } from '../../lib/sketch-layout.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { parseChalk, CHALK_DIR } from '../../lib/chalk.js';
import { isReservedFile, HARD_IGNORE_DIRS, DRAFTS_DIR } from '../../lib/task-scan.js';
import { applyFollows } from '../../lib/board-follow.js';
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
  const sharedRoot = getSharedDir(projectId);
  const board = await readBoard(projectId);
  // 待摆队列先并进来（刀 G）：上一批排不下的，这一批 agent 可能已经规划出地方了。
  // 排在新来的前面 —— 等得久的先落。
  const queued = Array.isArray(board.pending) ? board.pending : [];
  const uniq = [...new Set([...queued, ...rels])].filter(seatable).slice(0, MAX_SEATS_PER_RUN * 2);
  if (!uniq.length) return { seated: 0, lines: 0, pending: 0 };
  const known = new Set(Object.keys(board.zones || {}));
  const vp = getViewpoint(projectId);
  const objects = {}; const bindings = {};
  // 本批内后来者要避开先来者：live 副本随排随更新
  const live = { ...board.objects };
  // 纸（2026-08-29）：根层产物入座 = 落进当前纸往下排，纸满自动翻一张。
  // liveSheets 随翻随更新（本批内后来者排进新纸）；新纸随 patch 一起落盘。
  const liveSheets = { ...(board.sheets || {}) };
  const newSheets = {};
  const stillPending = [];          // 这一批还是没地方放的（刀 G 待摆队列）
  let seated = 0; let lines = 0;

  for (const rel of uniq) {
    if (seated >= MAX_SEATS_PER_RUN) break;
    const id = canvasIdForRel({ objects: live, zones: board.zones }, rel);
    if (!id) continue;
    if (live[id] && Number.isFinite(live[id].x)) continue;   // 已有座位
    // 文件还在才入座（本轮建又删的别复活）
    try { await fs.access(path.join(sharedRoot, rel)); } catch { continue; }

    let box = estimateSizeOn(board, id, null);
    let inSlot = null;               // 落进了哪块规划好的产物地
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
    const obstacles = obstaclesIn(board, zone, { objects: live, exclude: [id] });
    // 落位（2026-08-29 纸范式）：线程接楼 > 锚点贴放 > 纸内顺排（根层）/内容底下（文件夹层）
    const liveBoard = { ...board, objects: live, sheets: liveSheets };
    let placed = null;
    if (replyRect) {
      const p = placeThread(liveBoard, replyRect, box, { obstacles });
      placed = p.sheetFull ? null : p;   // 线程纸满：退回顺排（翻纸逻辑统一走下面那条）
    }
    if (!placed && anchorRect) placed = placeBeside(anchorRect, box, 'below');
    if (!placed && !zone) {
      const cur = currentSheet(liveBoard, null);
      // ① agent 事前规划的产物地（slot.for === 'artifacts'）
      if (cur) {
        const named = Object.entries(cur.slots || {}).find(([, sl]) => sl.for === 'artifacts');
        if (named) {
          const r = slotRectOf(cur, named[0]);
          const spot = r ? nextSpotInSlot(liveBoard, r, box) : { full: true };
          if (!spot.full) { placed = spot; inSlot = named[0]; }
        }
      }
      // ② 没规划就纸内顺排（兜底）
      if (!placed && cur) placed = nextSpotInSheet(liveBoard, cur.id, box);
      // ③ 一张纸都还没有 = **开工**，铺第一张（这不是翻页）
      if (!placed && !cur) {
        const rect = allocateSheetRect({
          board: liveBoard, size: sheetSizeFor(fitFor(vp)),
          viewport: (vp?.camera && !vp.layer) ? vp.camera : null,
          nearSheet: null,
          // 铺纸不避家具（纸不渲染，见 board-obstacles.js 的 furniture 参数）
          obstacles: obstaclesIn(board, zone, { objects: live, exclude: [id], furniture: false }),
        });
        const name = nextSheetName(liveBoard);
        const entry = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, by: 'agent', at: new Date().toISOString() };
        liveSheets[name] = entry; newSheets[name] = entry;
        const inner = innerRect(entry);
        placed = { x: inner.x, y: inner.y };
      }
      // ④ 有纸但排不下：**不翻页**（刀 G）。机器替 agent 铺出来的纸没标题没版位，
      //    而 agent 不知道它存在 —— 那是机器在定版面。进队列，等它规划。
      if (!placed) { stillPending.push(rel); continue; }
    }
    if (!placed) {
      // 文件夹层：这一层内容底下接着排（没有纸也没有启发式 —— 单条规则）
      const left = obstacles.length ? Math.min(...obstacles.map(o => o.x)) : 10;
      const bottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), 0);
      placed = { x: Math.round(left), y: Math.round(bottom) + 40 };
    }
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

  // 待摆队列整表写回（刀 G）：**必须无条件写**，哪怕这一批一件都没坐下 ——
  // 队列清空也是一次状态变化（上一批的挂账这一轮落了座，队列该空）。
  const pendingChanged = JSON.stringify(queued) !== JSON.stringify(stillPending);
  if (seated || pendingChanged) {
    await patchBoard(projectId, {
      ...(seated ? { objects, bindings } : {}),
      ...(Object.keys(newSheets).length ? { sheets: newSheets } : {}),
      ...(pendingChanged ? { pending: stillPending } : {}),
    });
  }
  // 领养的板书带 tag：有人跟着这个 tag（状态板）就自动重锚（fail-soft）
  for (const [id, e] of Object.entries(objects)) {
    if (e?.tag) { try { await applyFollows(projectId, { tag: e.tag, newId: id }); } catch { /* */ } }
  }
  return { seated, lines, pending: stillPending.length };
}

/**
 * 挂 project bus（与 board-tasklist 同栖）。时机 = **即时**：file_changed 攒 1.5s
 * 就排一批（回合中写完马上 near 它/read_board 都要看得见 —— 惰性到回合末只修
 * 一半病）；run 收尾再冲一次兜底（防抖窗口里挂掉的尾巴）。
 */
const FLUSH_MS = 1500;

export function attachBoardSeater(bus, projectId) {
  const pending = new Set();
  let timer = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending.size) return;
    const batch = [...pending]; pending.clear();
    try {
      const { seated, pending } = await seatArtifacts(projectId, batch);
      if (seated) bus.publish({ type: 'board.updated', sessionId: null, summary: `${seated} 件新产物入了座` });
      // 待摆的也要出声：板上没地方了，只有 agent 能开新的一页（刀 G）
      if (pending) bus.publish({ type: 'board.updated', sessionId: null, summary: `${pending} 件产物还没地方摆（板面排满了）` });
    } catch (err) {
      console.warn('[board-seater]', projectId, err?.message || err);
    }
  };
  bus.subscribe('*', (evt) => {
    if (!evt?.runId) return;
    if (evt.type === 'run.file_changed') {
      // 两种历史载荷形状都认（Events.fileChanged 的 filePath / 旧内联对象的 path）
      const rel = typeof evt.filePath === 'string' ? evt.filePath : (typeof evt.path === 'string' ? evt.path : null);
      if (!rel || !seatable(rel)) return;
      pending.add(rel);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
      return;
    }
    if (evt.type === 'run.done' || evt.type === 'run.cancelled' || evt.type === 'run.error') void flush();
  });
}
