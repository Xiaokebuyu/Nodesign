/**
 * mcp/tools/write-on-board-place.js —— write_on_board 的纸上落位（2026-08-29 纸范式刀 2，
 * 行数棘轮拆件：text 与 sketch 两条路共用同一份落位与返回文案）。
 *
 * 决策树（启发式引擎退役后仅存的分支）：
 *   near+side 显式 → 精确贴放（语义要求；压上如实报）
 *   slot          → 规划好的那块地里往下堆（装不下**拒收**，一个字不落盘）
 *   reply_to      → 接楼正下方（纸满拒收）
 *   at            → 纸内定点（钳进版心，钳了如实报）
 *   什么都没有    → 纸内顺排（先往下、这一列到底往右；真的排不下才拒收）
 * 文件夹层没有纸：线程/贴放照常，否则排在这一层内容底下。
 */

import {
  currentSheet, toLocal, placeAtOnSheet, placeThread, placeBeside,
  nextSpotInSheet, overlapIds, sheetOfPoint, slotRectOf, nextSpotInSlot,
} from '../../../lib/board-sheets.js';
import { capacityOf } from '../../../lib/sketch-layout.js';
import { currentSheetIdOf, setCurrentSheetId } from '../../../lib/sheet-state.js';
import { UNIT } from '../../../lib/rect.js';
import { openSheetFor } from './open-sheet.js';

export function makeSheetPlacer({ projectId, sessionId, by }) {
  /**
   * 版位解析（2026-08-29 刀 E）。**要在算板书宽度之前调** —— 一块地多宽，
   * 写进去的东西就多宽，不再各自按内容估。
   * @returns {{rect,sheet}|{error:string,message:string}}
   */
  const resolveSlot = (b, { slotName, sheetName }) => {
    const sheets = b.sheets || {};
    const sheet = (sheetName && sheets[sheetName])
      ? { id: sheetName, ...sheets[sheetName] }
      : currentSheet({ sheets }, currentSheetIdOf(sessionId));
    if (!sheet) {
      return { error: 'no-sheet', message: 'No sheet yet — open_sheet first (plan the page, then write into its slots).' };
    }
    const rect = slotRectOf(sheet, slotName);
    if (!rect) {
      const names = Object.keys(sheet.slots || {});
      return {
        error: 'no-slot',
        message: names.length
          ? `Sheet ${sheet.id} has no slot "${slotName}". It has: ${names.join(', ')}.`
          : `Sheet ${sheet.id} has no slots planned. Plan the page first: open_sheet{plan:[{slot,at,w,h,about}…]}.`,
      };
    }
    return { rect, sheet };
  };

  /**
   * 版位内落位。装不下**拒收**（站主拍板：提示 agent 分块内容、重新布置）——
   * 折叠/裁切/挤进去都是替它把问题藏起来，而它下一条还会照写不误。
   */
  const placeInSlot = (b, { rect, sheet, slotName, box, obstacles }) => {
    const spot = nextSpotInSlot(b, rect, box);
    if (spot.full) {
      const left = capacityOf(rect.w, spot.freeH);
      const whole = capacityOf(rect.w, rect.h);
      // 量纲对齐（刀⑥ 2026-08-30）：两边都报 px + 行，还差多少直接说 —— 此前
      // 「剩 ~15 行 / 要 ~15 行」被拒，在模型眼里就是量具坏了（真差 21px）。
      const short = spot.needH - spot.freeH;
      return {
        full: true,
        message: [
          `⛔ Slot "${slotName}" on sheet ${sheet.id} cannot take this — short by ${short}px (~${Math.max(1, Math.ceil(short / 26))} line${short > 26 ? 's' : ''}).`,
          `   Free: ${spot.freeH}px (~${left.lines} lines / ~${left.cjk} CJK chars); this note needs ${spot.needH}px.`
            + `${spot.taken ? ` The ${rect.w}x${rect.h} slot (~${whole.cjk} CJK chars) already holds ${spot.taken} item(s).` : ''}`,
          '   Nothing was written. Split it YOUR way: make this slot taller (replan it by name,',
          '   omit at — it resizes in place) or carve fresh blocks (omit at to stack below) and fill them one',
          '   note each. Or trim it. Lazy fallback: flow:true lets the machine split at paragraph breaks.',
        ].join('\n'),
      };
    }
    setCurrentSheetId(sessionId, sheet.id);
    return {
      x: spot.x, y: spot.y, resolution: 'slot', slot: slotName, sheetId: sheet.id,
      pressed: overlapIds({ x: spot.x, y: spot.y, w: box.w, h: box.h }, obstacles),
    };
  };

  /** 根层：纸上落位。返回 {x,y,resolution,sheetId,opened,clamped,pressed} */
  const placeOnSheets = async (b, { box, at, sheetName, replyRect, anchorRect, side, obstacles }) => {
    let sheets = b.sheets || {};
    let opened = null;
    const pick = () => {
      if (sheetName && sheets[sheetName]) return { id: sheetName, ...sheets[sheetName] };
      return currentSheet({ sheets }, currentSheetIdOf(sessionId));
    };
    /** 铺第一张纸（还一张都没有时）。**不用于翻页** —— 见下方 sheetFull。 */
    const openFirst = async () => {
      opened = await openSheetFor(projectId, { sessionId, by, where: null });
      sheets = { ...sheets, [opened.id]: { x: opened.x, y: opened.y, w: opened.w, h: opened.h, at: opened.at, by: opened.by } };
      return { id: opened.id, ...sheets[opened.id] };
    };
    const bWith = () => ({ ...b, sheets });
    const done = (p, resolution, sheetId, clamped = false) => {
      if (sheetId) setCurrentSheetId(sessionId, sheetId);
      const pressed = overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstacles);
      return {
        x: Math.round(p.x), y: Math.round(p.y), resolution, sheetId, opened, clamped, pressed,
        overflowY: p.overflowY || 0,   // 纸从那个 y 往下不够高还差多少（换纸判据）
        moved: !!p.moved,              // 这一列到底了、往右挪了一块空地
      };
    };
    const sheetOf = (p) => {
      const hit = sheetOfPoint(bWith(), { x: p.x + box.w / 2, y: p.y + box.h / 2 });
      return hit ? hit.id : null;
    };

    // 显式贴放（near + side）：语义要求（题注在上方）的精确几何，不搜索
    if (anchorRect && side) {
      const p = placeBeside(anchorRect, box, side, UNIT);
      return done(p, `beside-${side}`, sheetOf(p));
    }
    // 线程：正下方；接不下去就在同一张纸上顺排（真满了才翻页）
    if (replyRect) {
      const p = placeThread(bWith(), replyRect, box, { obstacles });
      if (!p.sheetFull) return done(p, 'thread', p.sheetId);
      /**
       * ⚠️ placeThread 只认**正下方一个方向**，被挡住就往那件底下跳，一跳出纸底
       * 就报 sheetFull —— 但这只说明"这条线接不下去"，不说明"这张纸满了"。
       *
       * 真案 proj_mtg61or1 19:13：p1 上母板书正下方杵着 960x628 的试作站点卡，
       * 接楼跳过它就出了版心底（2437），于是报了
       * 「⛔ Sheet p1 is full (all columns used) — nothing was written」。
       * 同一张纸同一刻，nextSpotInSheet 返回 (1392,1512) —— 第 4 栏整栏空着。
       * agent 信了这句话去 open_sheet，一场会话开出四张纸；每开一张，暂存架和
       * 纸互相顶的那个棘轮就再转一格（见 lib/board-shelf.js bandHitsSheet）。
       *
       * 所以先在同一张纸上顺排。回复关系靠 reply_to 落的那条边保着，本来就
       * 不依赖几何相邻 —— 挪一栏丢的只是"紧贴在下面"这个视觉暗示。
       */
      const flow = nextSpotInSheet(bWith(), p.sheetFull, box);
      if (flow) return done(flow, 'thread-flow', p.sheetFull);
      return { sheetFull: p.sheetFull };
    }
    // 定点 / 顺排：都要有一张纸
    let s = pick();
    if (!s) s = await openFirst();
    if (at) {
      const p = placeAtOnSheet(s, at, box);
      return done(p, 'at', s.id, p.clamped);
    }
    const flow = nextSpotInSheet(bWith(), s.id, box);
    if (flow) return done(flow, 'flow', s.id);
    // 这张纸排满了。**不替它翻页**（2026-08-29 刀 F，站主拍板"每张纸规划一次"）：
    // 机器悄悄翻页的话，agent 根本不知道自己换了页，新纸自然也没有版面 —— 真会话
    // proj_mtfhey1x 里 p2 规划得好好的，写满翻到 p3 就散回顺排了。纸是它开的，
    // 满了该由它决定下一页什么样。
    return { sheetFull: s.id };
  };

  /** 文件夹层落位（没有纸）：线程/贴放照常，否则排在这一层内容底下 */
  const placeInZone = ({ box, replyRect, anchorRect, side, obstacles }) => {
    if (replyRect) {
      const p = placeThread({ sheets: {} }, replyRect, box, { obstacles });
      return { x: p.x, y: p.y, resolution: 'thread', pressed: [] };
    }
    if (anchorRect) {
      const p = placeBeside(anchorRect, box, side || 'below', UNIT);
      return { x: p.x, y: p.y, resolution: `beside-${side || 'below'}`, pressed: overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstacles) };
    }
    const left = obstacles.length ? Math.min(...obstacles.map(o => o.x)) : 10;
    const bottom = obstacles.reduce((m, o) => Math.max(m, o.y + o.h), 0);
    return { x: Math.round(left), y: Math.round(bottom) + 40, resolution: 'below-content', pressed: [] };
  };

  /** 纸排满了的报文：不替它翻页，告诉它该规划下一页了 */
  const describeSheetFull = (b, sheetId) => {
    const sh = b.sheets?.[sheetId];
    const inner = sh ? { w: sh.w - 48, h: sh.h - 48 } : { w: 0, h: 0 };
    const landscape = inner.w > inner.h;
    return [
      `⛔ Sheet ${sheetId} is full${landscape ? ' (all columns used)' : ''} — nothing was written.`,
      `   Open the next page yourself and plan it: open_sheet{title:"…", plan:[{slot,at,w,h,about}…]}.`,
      `   Each sheet gets its own layout — decide what this next page is for before filling it.`,
    ].join('\n');
  };

  /** 返回文案：从真实落点生成（"工具返回不许撒谎"—— 08-25 陷阱③ 的纪律不变） */
  const describeSpot = (b, placed) => {
    const bits = [];
    if (placed.sheetId && b.sheets?.[placed.sheetId]) {
      const s = { id: placed.sheetId, ...b.sheets[placed.sheetId] };
      const l = toLocal(s, placed);
      bits.push(`on sheet ${s.id}${s.title ? `（${s.title}）` : ''} at local (${Math.round(l.x)},${Math.round(l.y)})`);
    }
    if (placed.resolution === 'thread') bits.push('under the note it replies to (thread)');
    else if (placed.resolution === 'flow') {
      bits.push(placed.moved
        ? 'the column you were in ran out — flowed into free space further right on the same sheet'
        : 'flowed below the last item');
    }
    else if (placed.resolution === 'slot') bits.push(`in slot "${placed.slot}" (planned block)`);
    else if (placed.resolution === 'at') {
      // 换纸判据（08-29 刀 C）：光说"钳住了"不够 —— 钳住的结果是这条被压到贴着
      // 纸底、跟上一条挤在一起，而 agent 不知道该翻页了。
      bits.push(placed.overflowY
        ? `at your spot but this sheet RAN OUT below that y (short by ${placed.overflowY}px) — it was pushed up to fit. Turn the page (open_sheet) or write it shorter`
        : (placed.clamped ? 'at your spot, CLAMPED into the sheet (it stuck out)' : 'exactly where you asked'));
    }
    else if (placed.resolution?.startsWith('beside-')) bits.push(`${placed.resolution.slice(7)} of the anchor (exact — no auto-nudging)`);
    else if (placed.resolution === 'lane-open') bits.push('at the head of its fresh sheet');
    else if (placed.resolution === 'below-content') bits.push('below current content (folder layer has no sheets)');
    if (placed.opened) bits.push(`opened sheet ${placed.opened.id} (${placed.opened.innerW}x${placed.opened.innerH} writable)`);
    if (placed.pressed?.length) bits.push(`⚠ overlaps ${placed.pressed.slice(0, 4).join(', ')} — move yours (edit_board) if unintended`);
    return bits.join('; ');
  };

  return { placeOnSheets, placeInZone, describeSpot, resolveSlot, placeInSlot, describeSheetFull };
}
