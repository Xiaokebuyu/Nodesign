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
 *
 * ## 2026-08-30 暂存架：机器的手只够得到架
 *
 * 上面那个「开工例外」当天就翻了车（proj_mtfz7n8p）：web_search 采回的参考图
 * 先于 agent 的第一笔到场，入座器铺了 p1 —— 第一张纸又成了机器铺的，agent
 * 不知道它存在，自己的板书全在缝里流。站主拍板：**机器从此完全不产纸、
 * 也不往纸面顺排**。三档收成两档：
 *   ① 这一页规划了 `for:'artifacts'` 的地 → 落进那块地（agent 事前说了放哪儿）
 *   ② 其余（没规划 / 排不下 / 一张纸都没有）→ 一律上暂存架（lib/board-shelf.js，
 *      seat:'shelf'），每回合状态块点名，agent 用 pin_to_board / edit_board move
 *      安置。旧 board.pending 队列并进架上（它们从「看不见」变「看得见」）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBoard, patchBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { estimateSizeOn } from '../../lib/board-kind-sizes.js';
import { obstaclesIn } from '../../lib/board-obstacles.js';
import { layerOf, normalizeCanvasId } from '../../lib/canvas-id.js';
import {
  currentSheet, placeThread, placeBeside, slotRectOf, nextSpotInSlot,
} from '../../lib/board-sheets.js';
import { resolveShelfOrigin, nextShelfSpot, FOLDER_BOX } from '../../lib/board-shelf.js';
import { textBox } from '../../lib/sketch-layout.js';
import { getViewpoint } from '../../projects/viewpoint-store.js';
import { parseChalk, CHALK_DIR } from '../../lib/chalk.js';
import { isReservedFile, HARD_IGNORE_DIRS, RESERVED_DIRS, DRAFTS_DIR } from '../../lib/task-scan.js';
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
  // 暂存架（2026-08-30）：批内原点算一次（架立了就不挪）；本批内后来者靠
  // live 障碍矩形自然码在先来者下面。
  const rootCam = (vp?.camera && !vp.layer) ? vp.camera : null;
  const shelfOrigin = resolveShelfOrigin(board, rootCam);
  const stillPending = [];          // 本批没轮到的（只剩封顶截流一种情况）
  let seated = 0; let lines = 0; let shelved = 0;

  // 文件夹卡也上架（2026-08-30，站主拍板「文件夹和单个文件一律落暂存区」）：
  // 这批文件揭示的顶层目录，还没有文件夹卡坐标的，先码在架上 —— 前端的
  // newStackedZoneRect 只给没坐标的排位，这里写了它就不再排。判据与 seatable
  // 同一套精神：保留目录（assets/notes/…）和隐藏目录不是用户的文件夹。
  const zonesPatch = {};
  const zoneRects = Object.entries(board.zones || {})
    .filter(([, z]) => Number.isFinite(z?.x) && Number.isFinite(z?.y))
    .map(([, z]) => ({ x: z.x, y: z.y, w: FOLDER_BOX.w, h: FOLDER_BOX.h }));
  for (const rel of uniq) {
    const segs = rel.split('/');
    if (segs.length < 2 || !seatable(rel)) continue;
    const top = segs[0];
    if (RESERVED_DIRS.has(top) || zonesPatch[top]) continue;
    if (board.zones?.[top] && Number.isFinite(board.zones[top].x)) continue;
    const rootRects = Object.entries(live)
      .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === '')
      .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
    const spot = nextShelfSpot(shelfOrigin, [...rootRects, ...zoneRects]);
    zonesPatch[top] = { x: spot.x, y: spot.y };
    zoneRects.push({ x: spot.x, y: spot.y, w: FOLDER_BOX.w, h: FOLDER_BOX.h });
    known.add(top);   // 这批的文件按新文件夹归层（跟前端 homeOf 同判）
  }

  for (const rel of uniq) {
    const id = canvasIdForRel({ objects: live, zones: board.zones }, rel);
    if (!id) continue;
    if (live[id] && Number.isFinite(live[id].x)) continue;   // 已有座位
    // 封顶截流：没轮到的留在队列里下批再来（暂存架永远有地方，这是唯一的排队原因）
    if (seated >= MAX_SEATS_PER_RUN) { stillPending.push(rel); continue; }
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
    // 落位（2026-08-30 暂存架）：线程接楼 > 锚点贴放 > 产物地（根层）> 暂存架（根层）
    // / 内容底下（文件夹层）。机器不产纸、不往纸面顺排。
    const liveBoard = { ...board, objects: live };
    let placed = null; let onShelf = false;
    if (replyRect) {
      const p = placeThread(liveBoard, replyRect, box, { obstacles });
      placed = p.sheetFull ? null : p;   // 线程纸满：接不了楼就上暂存架（线还在，找得回）
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
      // ② 其余一律上暂存架：agent 没说放哪儿的，机器不替它定版面。
      //    文件夹卡不在 objects 里，避让要把 zoneRects 一并算上
      if (!placed) {
        placed = nextShelfSpot(shelfOrigin, [...obstacles, ...zoneRects]);
        onShelf = true;
      }
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
      zone, seat: onShelf ? 'shelf' : 'auto',
      ...(by ? { by } : {}), ...(tag ? { tag } : {}),
    };
    if (onShelf) shelved += 1;
    objects[id] = entry; live[id] = entry;
    seated += 1;
    if (anchorId) { bindings[`b:a${stamp()}`] = { type: 'annotates', from: id, to: anchorId, by: by || 'agent', ...(tag ? { tag } : {}) }; lines += 1; }
    if (parentId) { bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: id, by: by || 'agent', material: 'pencil', ...(tag ? { tag } : {}) }; lines += 1; }
  }

  // 队列整表写回：**必须无条件写**，哪怕这一批一件都没坐下 ——
  // 队列清空也是一次状态变化（旧 pending 这一轮上了架，队列该空）。
  const pendingChanged = JSON.stringify(queued) !== JSON.stringify(stillPending);
  const zoned = Object.keys(zonesPatch).length;
  if (seated || pendingChanged || zoned) {
    await patchBoard(projectId, {
      ...(seated ? { objects, bindings } : {}),
      ...(zoned ? { zones: zonesPatch } : {}),
      ...(pendingChanged ? { pending: stillPending } : {}),
      // 架的原点：第一次用到（或被纸压住重立）才落盘
      ...((shelved || zoned) && shelfOrigin.changed ? { shelf: { x: shelfOrigin.x, y: shelfOrigin.y } } : {}),
    });
  }
  // 领养的板书带 tag：有人跟着这个 tag（状态板）就自动重锚（fail-soft）
  for (const [id, e] of Object.entries(objects)) {
    if (e?.tag) { try { await applyFollows(projectId, { tag: e.tag, newId: id }); } catch { /* */ } }
  }
  return { seated, lines, shelved, pending: stillPending.length };
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
      const { seated, shelved } = await seatArtifacts(projectId, batch);
      // 上架的要出声：架不是版面，agent 得给它们找地方（状态块每回合也点名）
      if (seated) {
        bus.publish({ type: 'board.updated', sessionId: null,
          summary: `${seated} 件新产物入了座${shelved ? `（${shelved} 件在暂存架等安置）` : ''}` });
      }
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
