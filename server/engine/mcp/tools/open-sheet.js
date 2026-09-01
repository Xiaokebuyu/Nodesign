/**
 * mcp/tools/open-sheet.js —— open_sheet 铺纸（2026-08-29 纸范式刀 2）
 *
 * 开工先铺纸：在画布上登记一块矩形工作区。铺在哪由机器定 —— 第一张对准用户此刻
 * 的视口（「agent 在用户眼皮底下开工」），之后**缺省叠在当前这一摞上**（同一块地
 * 的下一页，读的人翻过去看）。铺完这张纸就是**当前纸**：write_on_board 的 at 坐标
 * 以它的版心左上角为原点，没给 at 的写入由机器按栏排，整页排满自动翻下一页。
 *
 * 纸是分配纪律不是容器，**也不渲染**（用户拍板：纸只是位置范围的概念）——用户
 * 看到的只有内容本身。用户可以把东西拖出纸外，组照旧由 tag/线派生。
 *
 * ## 2026-09-01 刀 2：版位没了，多了三样
 *
 * 站主撤掉纸内版位（「模型在纸张中只需要输入内容，然后由机械层自动排版切层」），
 * 于是这里少了 `plan`/`scope`，多了三样：
 *   · `colW` —— 这张纸的**栏宽**，铺纸这一刻按设备档 + 用户拖出来的宽度定死并
 *     存进登记里。机器排版按它切栏（lib/board-sheets.js 的 sheetColumns）。
 *     ⭐ 存下来而不是每次现算：现算的话用户拖宽一条板书，整张纸的栏格跟着变，
 *     已经写好的内容当场全部错位。
 *   · `near`/`side` —— 把纸铺在某件产物旁边（站主：「agent 可以在为需要的产物
 *     附近设置任意大小的纸张并放置合适的提示文本来介绍产物」）。摆放从「纸内切块」
 *     升到了「纸本身摆哪儿」。
 *   · `order` —— 这一摞正序还是倒序（站主点名的参数）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { fitFor, capacityOf, DEFAULT_CHALK_W } from '../../../lib/sketch-layout.js';
import { learnedChalkWidth } from '../../../lib/chalk-size-pref.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { normalizeCanvasId } from '../../../lib/canvas-id.js';
import { UNIT } from '../../../lib/rect.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import {
  sheetSizeFor, allocateSheetRect, nextSheetName, currentSheet, innerRect, SHEET_MARGIN,
  membersInRect, sheetMembers, stackSheetRect, nextStackRect, sheetColumns, resolveSheet,
} from '../../../lib/board-sheets.js';
import { stackOfSheet } from '../../../lib/board-stacks.js';
import { setCurrentSheetId, currentSheetIdOf } from '../../../lib/sheet-state.js';
import { resolveShelfOrigin } from '../../../lib/board-shelf.js';
import { Events } from '../../agent/events.js';

/**
 * 这张纸的栏宽。三档回落，跟 write_on_board 的宽度回落同一条脉络：
 *   手机档给的一屏宽（fit.colW） > 用户拖出来的宽度 > 默认板书宽。
 * 「用户拖宽过板书」是有信息量的动作（chalk-size-pref 从 08-28 起就在学它）——
 * 他调出来的版心读着舒服，纸就照那个宽度切栏。
 */
export function colWFor(board, fit) {
  if (Number.isFinite(fit?.colW)) return Math.round(fit.colW);
  const learned = learnedChalkWidth(board);
  return Math.round(learned ? learned * UNIT : DEFAULT_CHALK_W);
}

/** 贴着某件东西铺纸时的理想落点（世界坐标） */
function idealBeside(board, anchorId, side, size) {
  const id = normalizeCanvasId(anchorId);
  const e = id ? board?.objects?.[id] : null;
  if (!e || !Number.isFinite(e.x)) return null;
  const sz = estimateSizeOn(board, id, e);
  const gap = UNIT * 2;
  const S = {
    right: { x: e.x + sz.w + gap, y: e.y },
    left: { x: e.x - size.w - gap, y: e.y },
    below: { x: e.x, y: e.y + sz.h + gap },
    above: { x: e.x, y: e.y - size.h - gap },
  };
  const pick = S[side] || S.right;
  return { ...pick, basis: `beside-${side || 'right'}`, anchor: id };
}

/**
 * 铺一张纸并登记（write_on_board 自动翻页也走这一份 —— 分配纪律只有一份）。
 * @returns {{ id, x, y, w, h, colW, innerW, innerH, basis, overlapsLoose }}
 */
export async function openSheetFor(projectId, {
  sessionId = null, by = 'agent', title = null, name = null, where = null,
  stack = null, size: wantSize = null, order = null, near = null, side = null,
  fromSheet = null,
} = {}) {
  const board = await readBoard(projectId);
  const vp = getViewpoint(projectId);
  const fit = fitFor(vp);
  /**
   * 纸的尺寸。缺省按设备档算 —— 那是对的默认，用户没表示过意见时机器按他的屏幕铺。
   * `size` 入参给两种场合：他表示过意见（改过缩放 / 把板书拖成某个宽度），
   * 或者这是一张**贴着产物的说明纸**（那种纸本来就该按内容大小裁，不是一屏）。
   */
  const size = (wantSize && Number.isFinite(wantSize.w) && Number.isFinite(wantSize.h))
    ? { w: Math.round(wantSize.w), h: Math.round(wantSize.h) }
    : sheetSizeFor(fit);
  /** 翻页时锚定的是**那一页**，不是「会话此刻正写的那张」（两者在批量写入时会分叉） */
  let cur = (fromSheet && board.sheets?.[fromSheet])
    ? resolveSheet(board, fromSheet)
    : currentSheet(board, currentSheetIdOf(sessionId));
  /**
   * 缺省：还没有纸（或点名 viewport）→ 对准用户视口；**有当前纸 → 叠上去**。
   * 三档还在：`next` 留给"我就是要一条竖排"；`viewport` 第一张对准用户；
   * `stack` 入参点名铺到哪一摞，那一摞还没有纸就在最右边另起一摞（摞横向排开）。
   * 点名了 `near` 就不叠 —— 那是"把纸摆到那件东西旁边"，跟翻页是两件事。
   */
  const stackName = stack || null;
  const beside = near ? idealBeside(board, near, side, size) : null;
  const mode = where || (beside ? 'beside' : (cur ? 'stack' : 'viewport'));
  // 翻页裁纸（刀② 2026-08-30）：纸固定一屏高、下一张贴满高矩形正下方，上一张
  // 只用了一半时内容之间就是几百像素的空白。翻页那一刻把上一张裁到内容底 ——
  // 纸是分配纪律不是画出来的框，裁掉的只是"再也不会写进去的余白"。
  let trimmed = null;
  /** 翻页前当前这张纸还剩多少（2026-08-31，报在决策点上比事后警告有用） */
  let prevFree = null; let prevId = null;
  const freeOf = (sh) => {
    const members = sheetMembers(board, sh.id);
    const innerC = innerRect(sh);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : innerC.y;
    return Math.max(0, Math.round(innerC.y + innerC.h - bottom));
  };
  if ((mode === 'stack' || mode === 'next') && cur) { prevFree = freeOf(cur); prevId = cur.id; }
  if (mode === 'next' && cur) {
    const members = sheetMembers(board, cur.id);
    const innerC = innerRect(cur);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : innerC.y;
    const newH = Math.max(240, Math.ceil((bottom + SHEET_MARGIN - cur.y) / 24) * 24);
    if (newH < cur.h - 24) {
      const patched = { ...board.sheets[cur.id], h: newH };
      await patchBoard(projectId, { sheets: { [cur.id]: patched } });
      trimmed = { id: cur.id, from: cur.h, to: newH };
      board.sheets = { ...board.sheets, [cur.id]: patched };
      cur = { ...cur, h: newH };
    }
  }
  // 铺纸尽量不压散件。⛔ 不含文件夹/卷卡这类常驻家具：纸不渲染，纸矩形盖住文件夹
  // 用户什么也看不见，而纸内落位照样会避开它 —— 算进来只会把第一张纸推离用户视口。
  const obstacles = obstaclesIn(board, '', { furniture: false });
  // 叠这一档不搜位置：抄这一摞的原点就是"叠在一起"的全部含义
  const wantStack = (mode === 'stack' || stackName)
    ? (stackName || (cur ? stackOfSheet(board, cur.id) : null))
    : null;
  /**
   * 叠上去的页**继承这一摞头一页的尺寸**（2026-09-01 刀 2）。
   *
   * ⛔ 翻案：刀 3 当时写的是「尺寸仍按此刻的设备档走（人换了机器，新的一页该按
   * 新机器铺）」。机器自动翻页之后那条站不住 —— 一张 480x300 的说明纸（贴在产物
   * 旁边那种）写满时会翻出一张 1867x1200 的巨页压在同一块地上。同一摞的页要能
   * 一页页翻着读，版心就不能一页一个样（栏宽 colW 也是同一条理由）。
   * 显式给了 w/h 仍然照给的来。
   */
  const headSheet = wantStack
    ? Object.entries(board.sheets || {})
      .filter(([sid, sh]) => (sh.stack || sid) === wantStack && Number.isFinite(sh?.x))
      .sort(([, a], [, b]) => String(a.at || '').localeCompare(String(b.at || '')))[0]?.[1] || null
    : null;
  const pileSize = (!wantSize && headSheet) ? { w: headSheet.w, h: headSheet.h } : size;
  const rect = wantStack
    ? (stackSheetRect(board, wantStack, pileSize) || nextStackRect(board, pileSize))
    : allocateSheetRect({
      board, size,
      viewport: mode === 'viewport' && vp?.camera && !vp.layer ? vp.camera : null,
      nearSheet: mode === 'next' && cur ? cur.id : null,
      ideal: beside, slideAxis: beside ? 'x' : 'y',
      obstacles,
    });
  const id = (name && TAG_RE.test(name) && !board.sheets?.[name]) ? name : nextSheetName(board);
  /** 栏宽：叠上去的页跟着这一摞头一页走（同一摞的栏格必须一致，否则翻页版心跳） */
  const headColW = Number.isFinite(headSheet?.colW) ? headSheet.colW : null;
  const colW = Math.round(headColW || colWFor(board, fit));
  const entry = {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h, colW,
    by, at: new Date().toISOString(), ...(title ? { title } : {}),
    ...(wantStack ? { stack: wantStack } : {}),
    // 哪一轮对话铺的（叠纸刀 8）—— 目录里能从一页跳回当时那段对话
    ...(sessionId ? { sid: String(sessionId).slice(0, 100) } : {}),
  };
  const pileName = wantStack || id;
  const newPile = !board.stacks?.[pileName];
  const pilePatch = {
    ...(newPile ? { by, at: entry.at, ...(title && rect.basis !== 'stack' ? { title } : {}) } : {}),
    ...(order ? { order } : {}),
  };
  await patchBoard(projectId, {
    sheets: { [id]: entry },
    /**
     * 摞的登记：身份（标题、正倒序）。
     *
     * ⛔ **标题只在真的另起一摞时才写**。叠上去那一档如果也写，新一页的标题会盖掉
     * 整摞的名字。一摞的名字讲的是这一摞是什么，不是最上面那一页是什么。
     */
    ...(Object.keys(pilePatch).length ? { stacks: { [pileName]: pilePatch } } : {}),
  });
  /**
   * 铺完纸重算一次暂存架的原点（2026-08-31）：架的原点是存下来的，而铺纸是它
   * 唯一会失效的时刻（判据本身只看纸），补在这里就闭合了。
   */
  try {
    const after = { ...board, sheets: { ...(board.sheets || {}), [id]: entry } };
    const origin = resolveShelfOrigin(after, null);
    if (origin.changed) await patchBoard(projectId, { shelf: { x: origin.x, y: origin.y } });
  } catch { /* 架挪不动不挡铺纸 */ }
  setCurrentSheetId(sessionId, id);
  const inner = innerRect({ ...entry });
  const cols = sheetColumns({ id, ...entry });
  // 占地者点名（刀③ 2026-08-30）：铺纸不避家具（纸不渲染，压着文件夹用户什么也
  // 看不见），但**必须说清这块地上已经住着谁**。
  const occupants = membersInRect(board, { x: rect.x, y: rect.y, w: rect.w, h: rect.h })
    .map((m) => ({
      id: m.id, folder: !!m.folder,
      local: { x: m.x - inner.x, y: m.y - inner.y }, w: m.w, h: m.h,
    }));
  return {
    id, ...entry, stack: wantStack, pile: pileName, order: order || board.stacks?.[pileName]?.order || null,
    innerW: inner.w, innerH: inner.h, cols: cols.n, colW: cols.colW,
    basis: rect.basis, overlapsLoose: rect.overlapsLoose, occupants, trimmed,
    prevFree, prevId, beside: beside?.anchor || null,
    // 纸缝：这张纸的顶边离上一张**内容底部**多远（用户眼里那条横穿版面的空白带）
    gapAbove: (mode === 'next' && prevFree !== null) ? Math.max(0, Math.round(rect.y - (cur.y + cur.h))) : null,
  };
}

const DESCRIPTION = `Lay a fresh SHEET on the board and make it the current one — do this before you
start writing (like turning to a clean page). A sheet is one screen of the user's
device; the machine picks where it goes — the first one opens right under his current
view, and after that each new sheet is A NEW PAGE ON THE SAME PILE: same ground, he
flips to it. Only one page of a pile is on screen at a time, so the board stops growing
taller and he never has to scroll off to find what you just wrote.
YOU DO NOT LAY OUT THE INSIDE OF A SHEET. Just write — the machine flows notes down
a column, moves to the next column when one fills, and TURNS THE PAGE for you when the
whole sheet is full. Call open_sheet yourself when you START A NEW TOPIC/CHAPTER (so a
pile reads as one thing), or with near: to put a sheet of caption text beside an artifact.
The user can drag things off a sheet freely — the sheet constrains you, not them.`;

export function makeOpenSheetTool({ projectId, sessionId, ctx }) {
  return tool('open_sheet', DESCRIPTION, {
    title: z.string().max(60).optional().describe('What this sheet is about (for read_board / your own map, e.g. 第二章 — sheets are invisible to the user)'),
    name: z.string().regex(TAG_RE).optional().describe('Sheet name to refer to it later (ASCII like act2; default auto p1/p2/…)'),
    where: z.enum(['next', 'viewport', 'stack']).optional()
      .describe("stack = a NEW PAGE on the current pile, same ground, the reader flips to it (THE DEFAULT once a sheet exists); viewport = right where the user is looking now (default for the very first sheet — also use it to bring work back to his eyes); next = a separate sheet BELOW this pile, which he has to scroll to (rare; only when you really want a vertical run)"),
    near: z.string().max(300).optional()
      .describe('Lay this sheet BESIDE something already on the board (a path like 图片/封面.png, or a tag). Use it to put a caption / notes sheet next to an artifact you just made, then write into it.'),
    side: z.enum(['right', 'left', 'above', 'below']).optional()
      .describe('Which side of `near` to lay it on (default right).'),
    w: z.number().min(240).max(8000).optional()
      .describe("Sheet width in px. LEAVE IT OUT for a normal page — the default is computed from the user's screen. Give it for a small sheet beside an artifact, or when he has told you what he wants (he changed the zoom, or dragged notes to a width)."),
    h: z.number().min(240).max(12000).optional()
      .describe('Sheet height in px. Both w and h must be given together, otherwise the device default is used.'),
    stack: z.string().regex(TAG_RE).optional()
      .describe('Put this sheet on a NAMED PILE (ASCII like main/state). Sheets on one pile share the same ground and the reader flips through them; a name with no pile yet starts a new pile to the RIGHT of the existing ones. Use a second pile for anything that must STAY VISIBLE while you write elsewhere — a status table, a set of choices, a reference image.'),
    order: z.enum(['asc', 'desc']).optional()
      .describe('Reading order of this pile. desc (default) = the newest page is the one on screen and the reader follows you as you write — right for a scene, a log, a conversation. asc = the pile is a document: the reader stays on page 1 and flips forward at his own pace.'),
  }, async (args, extra) => {
    if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
    const by = byOf(extra);
    const s = await openSheetFor(projectId, {
      sessionId, by, title: args.title || null, name: args.name || null, where: args.where || null,
      stack: args.stack || null, order: args.order || null,
      near: args.near || null, side: args.side || null,
      size: (args.w && args.h) ? { w: args.w, h: args.h } : null,
    });
    if (args.near && !s.beside) {
      return { content: [{ type: 'text', text: `⚠ near:"${args.near}" is not on the board (read_board lists what is). The sheet was laid ${s.basis} instead — move it (edit_board) or open another one.` }] };
    }
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `铺了一张纸 ${s.id}` });
      ctx?.emit?.(Events.boardFocus({ x: s.x, y: s.y, w: s.w, h: s.h }, { layer: '', soft: s.basis !== 'viewport', actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const colCap = capacityOf(s.colW, s.innerH);
    const lines = [
      `Sheet ${s.id} laid at world (${s.x},${s.y}) ${s.w}x${s.h}${s.title ? ` — “${s.title}”` : ''}; it is now the current sheet.`,
      `Writable area: ${s.innerW}x${s.innerH}px, margin ${SHEET_MARGIN}. at:{x,y} means pixels from its top-left writable corner (x→right, y→down).`,
      // 量纲（刀 D）：agent 手里的东西是字，护栏却全是像素 —— 让它自己换算
      // ＝ 每次落笔前做一道做不准的算术，结果是写完才发现装不下。
      `Layout is the machine's job: ${s.cols} column(s) of ${s.colW}px, each ~${colCap.lines} lines (~${colCap.cjk} CJK chars) — about ${colCap.cjk * s.cols} CJK chars on this page. Write without at; notes fill a column downward, then the next column, then THE PAGE TURNS BY ITSELF onto this pile.`,
    ];
    const BASIS_LINE = {
      viewport: 'Opened under the user’s current view.',
      'below-sheet': 'Stacked below the current sheet.',
      stack: `Laid ON TOP of pile "${s.stack}" — same ground as the sheet(s) under it. The reader flips to this page instead of scrolling; the pages below stay where they are and are not covered.`,
      'stack-new': `Started a new pile "${s.stack}" to the right of the existing ones. Left/right moves between piles, up/down flips through this one.`,
    };
    lines.push(BASIS_LINE[s.basis] || (s.beside
      ? `Laid beside ${s.beside} — write the caption/notes for it here (no at needed).`
      : 'Placed below existing content.'));
    if (s.order === 'asc') lines.push('Pile order asc: the reader stays on the first page and flips forward — he will NOT be carried along to each new page you open. Say in chat where the new material is.');
    if (s.gapAbove !== null) {
      lines.push(`Gap above: ${s.gapAbove}px of blank between the bottom of ${s.prevId} and the top of this sheet — that band is what the user scrolls through.`);
    }
    if (s.prevFree !== null && s.prevFree >= 400) {
      lines.push(`⚠ ${s.prevId} still had ~${s.prevFree}px free (~${capacityOf(s.colW, s.prevFree).lines} lines) when you turned the page. You do not need to turn pages — the machine does it when a sheet is really full. Open one yourself for a NEW TOPIC, not for every beat.`);
    }
    if (s.trimmed) {
      lines.push(`Previous sheet ${s.trimmed.id} was trimmed to its content (${s.trimmed.from}→${s.trimmed.to}px tall) so the pages sit close — its leftover blank is gone, not its content.`);
    }
    // 占地者点名（刀③）：谁在纸上、该怎么办
    if (s.occupants?.length) {
      const named = s.occupants.slice(0, 6).map((o) =>
        `${o.folder ? '📁 ' : ''}${o.id} at local (${Math.round(o.local.x)},${Math.round(o.local.y)}) ${o.w}x${o.h}`);
      lines.push(`⚠ ${s.occupants.length} item(s) ALREADY LIVE on this sheet's ground (they count against your space):`);
      for (const n of named) lines.push(`   ${n}`);
      if (s.occupants.length > 6) lines.push(`   …and ${s.occupants.length - 6} more (read_board lists them).`);
      lines.push('   The machine flows around them. Move them somewhere deliberate (edit_board move — they may be'
        + ' the user\'s, so keep them visible) if they are in the way.');
    } else if (s.overlapsLoose) {
      lines.push('⚠ Some loose items already sit in this area — they now read as “on this sheet”; move them (edit_board) if that is wrong.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
