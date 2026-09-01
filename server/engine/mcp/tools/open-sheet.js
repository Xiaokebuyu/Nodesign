/**
 * mcp/tools/open-sheet.js —— open_sheet 铺纸（2026-08-29 纸范式刀 2）
 *
 * 开工先铺纸：在画布上登记一块 0.75 倍缩放下等于用户一屏的矩形工作区。
 * 铺在哪由机器定（第一张对准用户此刻的视口 —— 「agent 在用户眼皮底下开工」；
 * 之后缺省铺在当前纸正下方，像往桌上接着铺稿纸）。铺完这张纸就是**当前纸**：
 * write_on_board 的 at 坐标以它的版心左上角为原点，没给 at 的写入在纸内自动
 * 往下排，写满自动翻下一张。
 *
 * 纸是分配纪律不是容器，**也不渲染**（用户拍板：纸只是位置范围的概念）——用户
 * 看到的只有内容本身；纸的存在体现在落位秩序、翻纸导航和 read_board 的账本里。
 * 用户可以把东西拖出纸外，组照旧由 tag/线派生。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { fitFor, capacityOf, DEFAULT_CHALK_W } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import {
  sheetSizeFor, allocateSheetRect, nextSheetName, currentSheet, innerRect, SHEET_MARGIN,
  membersInRect, sheetMembers, stackSheetRect, nextStackRect,
} from '../../../lib/board-sheets.js';
import { stackOfSheet } from '../../../lib/board-stacks.js';
import { setCurrentSheetId, currentSheetIdOf } from '../../../lib/sheet-state.js';
import { resolveShelfOrigin } from '../../../lib/board-shelf.js';
import { Events } from '../../agent/events.js';

/** 版位的 at：两轴各自可省 —— 省掉的轴由竖排糖补（below/接上一块）。
 * ⛔ 不复用 write_on_board 的 SHEET_PT：它双轴必填，`at:{x:640}, below:"s1"`
 * 这种半坐标会被 zod 整调用拒掉。 */
const SLOT_AT = z.object({
  x: z.number().min(0).max(12000).optional(),
  y: z.number().min(0).max(12000).optional(),
});

/** 一块地（版位）。坐标/尺寸全是纸内局部像素 —— 跟 write_on_board 的 at 同一套
 *（export 给 edit_board 的 replan 用 —— 版位的合法性只有这一份定义） */
export const SLOT = z.object({
  slot: z.string().regex(TAG_RE).describe('Name for this block, ASCII like main/aside/notes'),
  at: SLOT_AT.optional().describe("Top-left of this block, pixels from the sheet's writable corner. OMIT it to stack this block right below the previous one in the list (or below the block named in `below`) — carve a column of slots without doing any y arithmetic. In a replan, omitting it on an EXISTING slot means resize in place (position kept)"),
  below: z.string().regex(TAG_RE).optional().describe('Stack this block right under the named slot (24px gap). x follows that slot unless at.x says otherwise'),
  w: z.number().min(48).max(12000).describe('Width in PIXELS (a default note column is 432)'),
  h: z.number().min(24).max(12000).describe('Height in PIXELS (~26px per line of text)'),
  about: z.string().max(60).optional().describe('What goes here (正文 / 人物小传 / 待办) — for your own map'),
  for: z.literal('artifacts').optional()
    .describe("Set to 'artifacts' on ONE block to make it this page's landing spot for generated files (images, docs, sites). Without it, files you produce have nowhere planned to go and the page fills up with them wherever there is room."),
});

/**
 * 版面规划钳制（2026-08-29 刀 E；2026-08-30 抽出来给 replan 共用）：
 * 开工先把这一屏切成几块地。坐标跟 at 同一套（纸内局部像素）。
 * 越出版心的钳回来 —— 钳过如实报（规划错了要当场知道）。
 *
 * 竖排糖（2026-08-30 用户拍板「agent 自己定几个空位分段填」）：省掉 at（或点名
 * `below`）＝接在上一块正下方 24px。**y 累加这道算术归机器**，几个空位怎么切、
 * 每段写什么归 agent —— 分段的语义权不外包，只有几何外包。
 * `prevSlots` 是 replan 时该纸已有的版位（below 可以引用它们；点名已有版位又
 * 没给坐标＝原地改尺寸，不走竖排糖）。
 */
export function clampPlan(plan, inner0, prevSlots = {}) {
  const slots = {};
  const clampedSlots = [];
  let prev = null;                       // 数组序上一块（本批的）
  const refOf = (name) => slots[name] || prevSlots[name] || null;
  for (const it of Array.isArray(plan) ? plan : []) {
    const w = Math.min(Math.round(it.w), inner0.w);
    const h = Math.min(Math.round(it.h), inner0.h);
    // 点名**已有**版位又没给坐标 = 原地改尺寸（2026-08-30）：replan 想把 state 加高、
    // 位置没提，此前走竖排糖落到 (0,0) 跟别的版位叠上 —— glm 真会话为这一下花了
    // 三分钟理版面。竖排糖只对新版位生效。
    const keep = !it.at && !it.below ? prevSlots[it.slot] : null;
    const base = keep ? null : (it.below ? refOf(it.below) : (it.at ? null : prev));
    const wantX = it.at?.x ?? keep?.x ?? base?.x ?? 0;
    const wantY = it.at?.y ?? keep?.y ?? (base ? base.y + base.h + 24 : 0);
    const x = Math.min(Math.max(0, Math.round(wantX)), Math.max(0, inner0.w - w));
    const y = Math.min(Math.max(0, Math.round(wantY)), Math.max(0, inner0.h - h));
    if (x !== Math.round(wantX) || y !== Math.round(wantY)
      || w !== Math.round(it.w) || h !== Math.round(it.h)) clampedSlots.push(it.slot);
    slots[it.slot] = { x, y, w, h, ...(it.about ? { about: it.about } : {}), ...(it.for === 'artifacts' ? { for: 'artifacts' } : {}) };
    prev = slots[it.slot];
  }
  return { slots, clampedSlots };
}

/**
 * 铺一张纸并登记（write_on_board 自动铺纸也走这一份 —— 分配纪律只有一份）。
 * @returns {{ id, x, y, w, h, innerW, innerH, basis, overlapsLoose }}
 */
export async function openSheetFor(projectId, {
  sessionId = null, by = 'agent', title = null, name = null, where = null, plan = null,
  stack = null, size: wantSize = null,
} = {}) {
  const board = await readBoard(projectId);
  const vp = getViewpoint(projectId);
  const fit = fitFor(vp);
  /**
   * 纸的尺寸（2026-09-01 叠纸刀 7）。缺省仍按设备档算 —— 那是对的默认，
   * 用户没表示过意见时机器按他的屏幕铺。
   *
   * `size` 入参是给**他表示过意见**的时候用的：他手动改过缩放、或者把板书拖成
   * 某个宽度，那都是有信息量的动作（`learnedChalkWidth` 从 08-28 起就在学后者）。
   * ⚠️ 但别自作主张 —— 教义要求先问一句再照做（prelude「纸的尺寸」那节）。
   */
  const size = (wantSize && Number.isFinite(wantSize.w) && Number.isFinite(wantSize.h))
    ? { w: Math.round(wantSize.w), h: Math.round(wantSize.h) }
    : sheetSizeFor(fit);
  let cur = currentSheet(board, currentSheetIdOf(sessionId));
  /**
   * 缺省：还没有纸（或点名 viewport）→ 对准用户视口；**有当前纸 → 叠上去**。
   *
   * ⭐ 2026-09-01 翻案（刀 3 埋的那条）。原来的缺省是 `next`（铺在正下方），
   * 那时前端还不会藏页，把默认改成叠等于让几页字压在一起。前端会藏页之后这条
   * 就该翻过来了：**翻页本来就是"下一页"，不是"下面那张纸"**。板子从此不再
   * 越长越高，用户也不用滑屏幕去追 agent 写在哪儿。
   *
   * 三档还在：`next` 留给"我就是要一条竖排"（老板子接着往下写）；`viewport`
   * 第一张对准用户；`stack` 入参点名铺到哪一摞，那一摞还没有纸就在最右边
   * 另起一摞（摞横向排开）。
   */
  const stackName = stack || null;
  const mode = where || (cur ? 'stack' : 'viewport');
  // 翻页裁纸（刀② 2026-08-30）：纸固定一屏高、下一张贴满高矩形正下方，上一张
  // 只用了一半时内容之间就是几百像素的空白（proj_mtfpehm3 实测 268~557px，
  // 设计间隔明明只有 48）。翻页那一刻把上一张裁到内容底 —— 纸是分配纪律不是
  // 画出来的框，裁掉的只是"再也不会写进去的余白"；它的版位一并钳到新底。
  let trimmed = null;
  /**
   * 翻页前当前这张纸还剩多少（2026-08-31，agent 自己报的 iss_mthb9nef）。
   *
   * 「纸缝对用户可见、对 agent 不可见」—— 状态块只报纸内余量，从不报两张纸之间
   * 那条空白带，于是「每拍翻一张」的代价它看不见。真案 proj_mth8wd7k：一章开了
   * 12 张纸，覆盖率 20%~45%（平均 27%），纸内尾部空白 1871px + 纸缝 576px，
   * 合起来是板高的 23%。这个数报在**决策点上**（就在它开纸这一刻）比事后警告有用。
   */
  let prevFree = null; let prevId = null;
  /**
   * 叠这一档也报「上一页还剩多少」（2026-09-01），只是不裁纸也没有纸缝 ——
   * 叠起来的页不占竖向空间，裁掉余白没有意义。但**利用率那笔账照算**：
   * 08-30 那个「每拍一张纸」的真案（14 张纸每张剩三分之二）跟纸怎么排没关系，
   * 换成叠一样会发生，而且更隐蔽（板子不长高，看不出来浪费）。
   */
  if (mode === 'stack' && cur) {
    const members = sheetMembers(board, cur.id);
    const innerC = innerRect(cur);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : innerC.y;
    prevFree = Math.max(0, Math.round(innerC.y + innerC.h - bottom));
    prevId = cur.id;
  }
  if (mode === 'next' && cur) {
    const members = sheetMembers(board, cur.id);
    const innerC = innerRect(cur);
    const bottom = members.length ? Math.max(...members.map((m) => m.y + m.h)) : innerC.y;
    prevFree = Math.max(0, Math.round(innerC.y + innerC.h - bottom));
    prevId = cur.id;
    const newH = Math.max(240, Math.ceil((bottom + SHEET_MARGIN - cur.y) / 24) * 24);
    if (newH < cur.h - 24) {
      const oldEntry = board.sheets[cur.id];
      const newSlots = {};
      for (const [nm, sl] of Object.entries(oldEntry.slots || {})) {
        newSlots[nm] = { ...sl, h: Math.max(24, Math.min(sl.h, newH - SHEET_MARGIN * 2 - sl.y)) };
      }
      const patched = { ...oldEntry, h: newH, ...(Object.keys(newSlots).length ? { slots: newSlots } : {}) };
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
  const rect = wantStack
    ? (stackSheetRect(board, wantStack, size) || nextStackRect(board, size))
    : allocateSheetRect({
      board, size,
      viewport: mode === 'viewport' && vp?.camera && !vp.layer ? vp.camera : null,
      nearSheet: mode === 'next' && cur ? cur.id : null,
      obstacles,
    });
  const id = (name && TAG_RE.test(name) && !board.sheets?.[name]) ? name : nextSheetName(board);
  const inner0 = innerRect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  const { slots, clampedSlots } = clampPlan(plan, inner0);
  const entry = {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    by, at: new Date().toISOString(), ...(title ? { title } : {}),
    ...(Object.keys(slots).length ? { slots } : {}),
    ...(wantStack ? { stack: wantStack } : {}),
    // 哪一轮对话铺的（叠纸刀 8）—— 目录里能从一页跳回当时那段对话
    ...(sessionId ? { sid: String(sessionId).slice(0, 100) } : {}),
  };
  await patchBoard(projectId, {
    sheets: { [id]: entry },
    /**
     * 摞的登记表只记身份（标题、产物地）；几何长在纸上，见 lib/board-stacks.js。
     *
     * ⛔ **标题只在真的另起一摞时才写**（`stack-new`）。叠上去那一档如果也写，
     * 新一页的标题会盖掉整摞的名字 —— 第一版就这么干的，demo 里一摞叫「第一拍
     * 码头」的纸，叠了第二页之后整摞变成「第二拍 灯塔」。一摞的名字讲的是这一摞
     * 是什么，不是最上面那一页是什么。
     */
    ...(wantStack && !board.stacks?.[wantStack]
      ? { stacks: { [wantStack]: { by, at: entry.at, ...(title && rect.basis === 'stack-new' ? { title } : {}) } } }
      : {}),
  });
  /**
   * 铺完纸重算一次暂存架的原点（2026-08-31）。
   *
   * 架的原点是**存下来**的（board.shelf），前端 useBoardData 直接镜像它、
   * board-seating 拿它排新到货，中间没有任何撞纸检查。而回写只发生在入座器
   * 真有东西上架的那一刻（board-seater.js 的 `(shelved || zoned) && changed`）——
   * 于是「铺了一张纸把架带盖住了、但这一轮没有任何东西到货」的板，会带着一个
   * 已经失效的原点一直跑到下次到货为止。真案 proj_mtgeaeps_7kly：架停在 (24,24)，
   * 判据算出来该搬到 (-360,96)，前端照着旧值把新到货码在 x=24 那一列，
   * 正好是纸的地盘。
   *
   * 铺纸是架**唯一**会失效的时刻（判据本身只看纸），所以补在这里就闭合了。
   */
  try {
    const after = { ...board, sheets: { ...(board.sheets || {}), [id]: entry } };
    const origin = resolveShelfOrigin(after, null);
    if (origin.changed) await patchBoard(projectId, { shelf: { x: origin.x, y: origin.y } });
  } catch { /* 架挪不动不挡铺纸 */ }
  setCurrentSheetId(sessionId, id);
  const inner = innerRect({ ...entry });
  // 占地者点名（刀③ 2026-08-30）：铺纸不避家具（纸不渲染，压着文件夹用户什么也
  // 看不见），但**必须说清这块地上已经住着谁** —— proj_mtfpehm3 首拍就是纸铺在
  // 文件夹排上、agent 规划的版位下半截被占，连吃四发拒收却没人告诉它为什么。
  const occupants = membersInRect({ ...board, sheets: board.sheets }, { x: rect.x, y: rect.y, w: rect.w, h: rect.h })
    .map((m) => ({
      id: m.id, folder: !!m.folder,
      local: { x: m.x - inner.x, y: m.y - inner.y }, w: m.w, h: m.h,
      slots: Object.entries(slots)
        .filter(([, sl]) => m.x < inner.x + sl.x + sl.w && m.x + m.w > inner.x + sl.x
          && m.y < inner.y + sl.y + sl.h && m.y + m.h > inner.y + sl.y)
        .map(([nm]) => nm),
    }));
  return {
    id, ...entry, stack: wantStack, innerW: inner.w, innerH: inner.h,
    basis: rect.basis, overlapsLoose: rect.overlapsLoose, clampedSlots, occupants, trimmed,
    prevFree, prevId,
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
After this, write_on_board's at:{x,y} means PIXELS from this sheet's top-left
writable corner, and writes without at flow top-to-bottom on it; when a sheet
fills up a new one is opened for you automatically — call open_sheet yourself when
you START A NEW TOPIC/CHAPTER, so each sheet reads as one page about one thing.
The user can drag things off a sheet freely — the sheet constrains you, not them.`;

export function makeOpenSheetTool({ projectId, sessionId, ctx }) {
  return tool('open_sheet', DESCRIPTION, {
    title: z.string().max(60).optional().describe('What this sheet is about (for read_board / your own map, e.g. 第二章 — sheets are invisible to the user)'),
    name: z.string().regex(TAG_RE).optional().describe('Sheet name to refer to it later (ASCII like act2; default auto p1/p2/…)'),
    where: z.enum(['next', 'viewport', 'stack']).optional()
      .describe("stack = a NEW PAGE on the current pile, same ground, the reader flips to it (THE DEFAULT once a sheet exists — the board stops growing taller and he never has to hunt for where you wrote); viewport = right where the user is looking now (default for the very first sheet — also use it to bring work back to his eyes); next = a separate sheet BELOW this pile, which he has to scroll to (rare; only when you really want a vertical run)"),
    w: z.number().min(240).max(8000).optional()
      .describe("Sheet width in px. LEAVE IT OUT normally — the default is computed from the user's screen. Pass it only when he has told you (or shown you) what he wants: he changed the zoom, or dragged notes to a width. Ask him first."),
    h: z.number().min(240).max(12000).optional()
      .describe('Sheet height in px. Same rule as w — both must be given together, otherwise the device default is used.'),
    stack: z.string().regex(TAG_RE).optional()
      .describe('Put this sheet on a NAMED PILE (ASCII like main/state). Sheets on one pile share the same ground and the reader flips through them; a name with no pile yet starts a new pile to the RIGHT of the existing ones. Use a second pile for something that must stay reachable while you write elsewhere, e.g. a status table.'),
    plan: z.array(SLOT).max(24).optional()
      .describe('PLAN THE WHOLE PAGE HERE, before writing anything: carve the sheet into named blocks (slots) and say what goes in each. Then write_on_board{slot:"main"} drops content into that block. A sheet is WIDE (landscape) — a single column down the left wastes most of it; think in columns and rows.'),
  }, async (args, extra) => {
    if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
    const by = byOf(extra);
    const s = await openSheetFor(projectId, {
      sessionId, by, title: args.title || null, name: args.name || null, where: args.where || null,
      plan: args.plan || null, stack: args.stack || null,
      size: (args.w && args.h) ? { w: args.w, h: args.h } : null,
    });
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `铺了一张纸 ${s.id}` });
      ctx?.emit?.(Events.boardFocus({ x: s.x, y: s.y, w: s.w, h: s.h }, { layer: '', soft: s.basis !== 'viewport', actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const colCap = capacityOf(DEFAULT_CHALK_W, s.innerH);
    const cols = Math.max(1, Math.floor(s.innerW / (DEFAULT_CHALK_W + SHEET_MARGIN)));
    const lines = [
      `Sheet ${s.id} laid at world (${s.x},${s.y}) ${s.w}x${s.h}${s.title ? ` — “${s.title}”` : ''}; it is now the current sheet.`,
      `Writable area: ${s.innerW}x${s.innerH}px, margin ${SHEET_MARGIN}. at:{x,y} means pixels from its top-left writable corner (x→right, y→down).`,
      // 量纲（刀 D）：agent 手里的东西是字，护栏却全是像素 —— 让它自己换算
      // ＝ 每次落笔前做一道做不准的算术，结果是写完才发现装不下。
      `Scale: ~26px per line, ~${colCap.perLine} CJK chars per ${DEFAULT_CHALK_W}px-wide line. This sheet is ${colCap.lines} lines deep and ${cols} columns wide (≈${colCap.cjk * cols} CJK chars if you use all of it).`,
    ];
    const slotList = Object.entries(s.slots || {});
    if (slotList.length) {
      // 覆盖率（刀 E）：一张横着的纸只画一条竖栏，大半是空的 —— 把这个数直接报出来
      const used = slotList.reduce((n, [, v]) => n + v.w * v.h, 0);
      const pct = Math.round((used / (s.innerW * s.innerH)) * 100);
      lines.push(`Planned ${slotList.length} slots covering ${pct}% of the sheet:`);
      for (const [nm, v] of slotList) {
        const c = capacityOf(v.w, v.h);
        lines.push(`  ${nm}${v.about ? `（${v.about}）` : ''}: at (${v.x},${v.y}) ${v.w}x${v.h} — ~${c.lines} lines, ~${c.cjk} CJK chars`);
      }
      lines.push('write_on_board{slot:"<name>"} drops a note into a block (they stack downward inside it). Content that does not fit is NOT squeezed in and NOT dropped — it is written and PARKED ON THE SHELF, and you are asked to place it on the spot (re-plan the block taller, or move it somewhere deliberate).');
      if (pct < 45) lines.push(`⚠ ${100 - pct}% of this sheet is unplanned. A landscape sheet holds ${cols} columns side by side — carve more blocks rather than leaving it empty.`);
      if (s.clampedSlots?.length) lines.push(`⚠ Clamped into the sheet (they stuck out): ${s.clampedSlots.join(', ')} — check their at/w/h.`);
    } else {
      lines.push(`No slots planned. Plan the page in one go — open_sheet{plan:[{slot,at,w,h,about}…]} — instead of writing one note at a time and hoping it lands well. This sheet takes ${cols} columns side by side; a single column down the left leaves ${Math.round((1 - 1 / cols) * 100)}% of it empty.`);
    }
    const BASIS_LINE = {
      viewport: 'Opened under the user’s current view.',
      'below-sheet': 'Stacked below the current sheet.',
      stack: `Laid ON TOP of pile "${s.stack}" — same ground as the sheet(s) under it. The reader flips to this page instead of scrolling; the pages below stay where they are and are not covered.`,
      'stack-new': `Started a new pile "${s.stack}" to the right of the existing ones. Left/right moves between piles, up/down flips through this one.`,
    };
    lines.push(BASIS_LINE[s.basis] || 'Placed below existing content.');
    /**
     * 纸缝 + 翻页代价，报在决策点上（2026-08-31，agent 自己报的 iss_mthb9nef）。
     * 它看得见纸内余量，看不见两张纸之间那条空白带 —— 而用户看到的就是那条带。
     */
    if (s.gapAbove !== null) {
      lines.push(`Gap above: ${s.gapAbove}px of blank between the bottom of ${s.prevId} and the top of this sheet — that band is what the user scrolls through.`);
    }
    if (s.prevFree !== null && s.prevFree >= 400) {
      lines.push(`⚠ ${s.prevId} still had ~${s.prevFree}px free (~${capacityOf(DEFAULT_CHALK_W, s.prevFree).lines} lines) when you turned the page. Short beats keep landing on the current sheet — they flow down, no slot needed. Turn the page for a scene change or an overflow, not for every beat.`);
    }
    if (s.trimmed) {
      lines.push(`Previous sheet ${s.trimmed.id} was trimmed to its content (${s.trimmed.from}→${s.trimmed.to}px tall) so the pages sit close — its leftover blank is gone, not its content.`);
      // 利用率点名（2026-08-30）：裁掉近半张纸 = 翻页翻快了。只点名不拦 ——
      // 换场景翻新纸永远合法，这里治的是「每拍一张纸」的过度避险。
      const waste = s.trimmed.from - s.trimmed.to;
      if (waste >= 400) {
        lines.push(`⚠ You left ~${waste}px of that sheet unused — pages are turning faster than they fill. Short beats can keep landing on the current sheet (they flow down; no slot needed). Turn the page for a scene change or a refusal, not for every beat.`);
      }
    }
    // 占地者点名（刀③）：谁在纸上、占了哪块版位、该怎么办 —— 三样一次说清
    if (s.occupants?.length) {
      const named = s.occupants.slice(0, 6).map((o) =>
        `${o.folder ? '📁 ' : ''}${o.id} at local (${Math.round(o.local.x)},${Math.round(o.local.y)}) ${o.w}x${o.h}${o.slots.length ? ` — sits in your slot "${o.slots.join('", "')}"` : ''}`);
      lines.push(`⚠ ${s.occupants.length} item(s) ALREADY LIVE on this sheet's ground (they count against your space):`);
      for (const n of named) lines.push(`   ${n}`);
      if (s.occupants.length > 6) lines.push(`   …and ${s.occupants.length - 6} more (read_board lists them).`);
      lines.push('   Options: plan/re-plan your blocks AROUND them (edit_board replan), move them somewhere'
        + ' deliberate (edit_board move — they may be the user\'s, so keep them visible), or re-open with'
        + ' where:"next" for clean ground. Do NOT just write over them.');
    } else if (s.overlapsLoose) {
      lines.push('⚠ Some loose items already sit in this area — they now read as “on this sheet”; move them (edit_board) if that is wrong.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
