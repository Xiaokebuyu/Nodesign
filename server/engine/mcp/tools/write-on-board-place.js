/**
 * mcp/tools/write-on-board-place.js —— write_on_board 的纸上落位（2026-08-29 纸范式刀 2，
 * 行数棘轮拆件：text 与 sketch 两条路共用同一份落位与返回文案）。
 *
 * 决策树（启发式引擎退役后仅存的分支）：
 *   near+side 显式 → 精确贴放（语义要求；压上如实报）
 *   slot          → 规划好的那块地里往下堆（装不下 → **溢出暂存**，见下）
 *   reply_to      → 接楼正下方（纸满 → 溢出暂存）
 *   at            → 纸内定点（钳进版心，钳了如实报）
 *   什么都没有    → 纸内顺排（先往下、这一列到底往右；纸真排不下 → 溢出暂存）
 * 文件夹层没有纸：线程/贴放照常，否则排在这一层内容底下。
 */

import {
  currentSheet, toLocal, placeAtOnSheet, placeThread, placeBeside,
  nextSpotInSheet, overlapIds, sheetOfPoint, slotRectOf, nextSpotInSlot, innerRect,
} from '../../../lib/board-sheets.js';
import { capacityOf } from '../../../lib/sketch-layout.js';
import { currentSheetIdOf, setCurrentSheetId } from '../../../lib/sheet-state.js';
import { UNIT } from '../../../lib/rect.js';
import { resolveShelfOrigin, nextShelfSpot } from '../../../lib/board-shelf.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { openSheetFor } from './open-sheet.js';

/** 这个矩形在用户视口里吗（报文里那句 "Visible in the user's viewport"） */
const visibleIn = (rect, vpRect) => !!vpRect && !(rect.x + rect.w < vpRect.x || vpRect.x + vpRect.w < rect.x
  || rect.y + rect.h < vpRect.y || vpRect.y + vpRect.h < rect.y);

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
    // sheetId 必传（2026-09-01 叠纸刀 1）：一摞纸共用一块地，不传的话在第二页的
    // 版位里算余量会把第一页的内容也数进去，报出来的「还剩几行」偏少
    const spot = nextSpotInSlot(b, rect, box, { sheetId: sheet.id });
    if (spot.full) {
      const left = capacityOf(rect.w, spot.freeH);
      const whole = capacityOf(rect.w, rect.h);
      // 量纲对齐（刀⑥ 2026-08-30）：两边都报 px + 行，还差多少直接说 —— 此前
      // 「剩 ~15 行 / 要 ~15 行」被拒，在模型眼里就是量具坏了（真差 21px）。
      if (spot.tooWide) {
        return {
          full: true,
          message: `⛔ Slot "${slotName}" on sheet ${sheet.id} is only ${spot.freeW}px wide, this needs ${spot.needW}px. Nothing was written. Re-plan that block wider (replan it by name, omit at — it resizes in place).`,
        };
      }
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

  /**
   * **溢出暂存**（2026-08-31 站主拍板，替掉整条拒收）。
   *
   * 拒收原来的道理是对的："折叠/裁切/挤进去都是替它把问题藏起来"。错的是**代价**：
   * 全库 547 次自动记录的工具失败里，182 次是 write_on_board，其中 **136 次是
   * 「装不下，一个字没写」——占全系统工具失败的四分之一**。而 116 次版位拒收里
   * 19 次差的不到一行（差 1px / 2px / 9px / 11px 的都有）：一整条内容重写一遍，
   * 换一个像素。
   *
   * 站主的判词：「不直接拒绝 agent 的输入…而是暂存，然后要求 agent 立刻指定
   * 溢出块的放置位置」。所以现在：**内容照写、落到暂存架上、返回里当场点名要
   * 它安置**。藏问题的那条线没有被跨过 —— 位置仍然没定，架不是版面，每回合状态块
   * 还会继续点名，只是不再拿"重写一遍"当收费站。
   *
   * ⚠️ `zone` 强制回根层：架是根层的东西。坐标算在根层、层归属却写文件夹层，
   * 就是 08-30 pin_to_board 那个「前端按 zone 渲染进文件夹、根层画布上根本看不见」
   * 的幽灵卡（同一个病族，别再犯第三次）。
   */
  const placeOverflowOnShelf = (b, { box, why }) => {
    const origin = resolveShelfOrigin(b, null);
    const spot = nextShelfSpot(origin, obstaclesIn(b, ''), box);
    return {
      x: spot.x, y: spot.y, zone: '', seat: 'shelf', resolution: 'shelf-overflow',
      shelf: origin.changed ? { x: origin.x, y: origin.y } : null,
      why, pressed: [],
    };
  };

  /**
   * 溢出之后跟给 agent 的那段话：为什么溢出 + 现在在哪 + 立刻要做什么。
   *
   * ⚠️ `why` **整段照抄，不许只取第一行** —— 原拒收报文的后几行带着这一刀真正
   * 有用的数（还剩几行几字、这张纸底下还有多少、flow 这条懒人路），把它们截掉
   * 就是拿"改了处置"换掉"报得清楚"，两件事本来不冲突。
   */
  const describeOverflow = (placed) => [
    `⚠ OVERFLOW — it was written, but there was no room where you asked, so it is parked on the shelf at (${placed.x},${placed.y}).`,
    'Why it did not fit:',
    String(placed.why || '').trimEnd(),
    'The shelf is NOT a layout — place it now, in this same turn:',
    '   · make room where it belongs: edit_board{ops:[{op:"replan", slot:"…", h:…}]} then pin it back, or',
    '   · give it a spot: edit_board{ops:[{op:"move", id:"<the path above>", to:{…}}]}, or',
    '   · plan the next page for it: open_sheet{title:"…", plan:[…]} then move it there.',
  ].join('\n');

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
    else if (placed.resolution === 'shelf-overflow') bits.push('PARKED ON THE SHELF (it did not fit where you asked — see the overflow note below)');
    if (placed.opened) bits.push(`opened sheet ${placed.opened.id} (${placed.opened.innerW}x${placed.opened.innerH} writable)`);
    if (placed.pressed?.length) bits.push(`⚠ overlaps ${placed.pressed.slice(0, 4).join(', ')} — move yours (edit_board) if unintended`);
    return bits.join('; ');
  };


  /**
   * 板书写完那一段返回文案（2026-08-31 从 write-on-board.js 迁来 —— 行数棘轮
   * 619 > 600，按规矩拆不抬上限）。
   *
   * 落在这个文件是因为它本来就是「落位与返回文案」那一半：describeSpot /
   * describeSheetFull / describeOverflow 都在这儿，报文的措辞纪律（"工具返回不许
   * 撒谎"、量纲两边同单位）也都记在这儿的注释里。散在两个文件迟早各说各话。
   */
  const describeChalkWrite = ({ rel, rect, board, placed, slotInfo, box, args, vpRect, parentId, anchorId, laneFrom, boardBefore }) => {
    const lines = [
      `Wrote board note ${rel} at (${rect.x},${rect.y}) ${rect.w}x${rect.h} — ${describeSpot(board, placed)}.`,
      `Visible in the user's viewport: ${visibleIn(rect, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    // 溢出暂存：这段必须紧跟落点，且要点名这条的路径 —— agent 下一步就是拿它去 move
    if (placed.resolution === 'shelf-overflow') lines.push(describeOverflow(placed));
    // 余量随手报（2026-08-30 容量线）：下一条要不要拆、还塞不塞得下，
    // 最有用的时机就是刚写完这一刻 —— 别让它再去翻状态块或者赌一发。
    if (slotInfo) {
      const freeH = Math.max(0, Math.round(slotInfo.rect.y + slotInfo.rect.h - (rect.y + rect.h) - UNIT));
      const c = capacityOf(slotInfo.rect.w, freeH);
      // 版位满 ≠ 纸满（2026-08-30 利用率线）：旧措辞 "goes elsewhere" 把模型往门外
      // 推（sonnet 真会话走成每拍一张新纸）。版位用完先报纸还剩多少，复用是主路径。
      let tail = '';
      if (freeH < 60) {
        const inn = innerRect(slotInfo.sheet);
        const sheetFree = Math.round(inn.y + inn.h - (rect.y + rect.h) - UNIT);
        tail = sheetFree >= 120 ? ` — this slot is full, but the sheet still has ~${sheetFree}px below: keep writing on it (no slot needed — notes flow down; or replan more blocks). A fresh sheet is for a scene change or a refusal, not for every note` : ' — slot and sheet are both nearly full; plan the next page (open_sheet) before the next note';
      }
      lines.push(`Slot "${args.slot}" now has ~${c.lines} lines (~${c.cjk} CJK chars, ${freeH}px) left${tail}.`);
    }
    if (box.reserved) lines.push(`Box height reserved at ${box.h}px (content measured shorter — the box keeps your planned size).`);
    // 折叠如实报（08-29 占位契约刀 B）：卡高封顶到 CARD_MAX_H，超出的折在卡里。
    // ⚠ 旧判据 `box.h > SKETCH_FIT.h*0.6`（720px）封顶之后永远不成立 —— 换成真话。
    if (box.capped) {
      lines.push(`⚠ Too long for one card: it shows ${box.h}px of ~${box.fullH}px — the rest is folded (the reader must click to unfold). Split it into several notes (chain:true keeps them threaded), or start a fresh sheet.`);
    }
    // 收卷提醒（2026-08-27 收纳器）：落进收着的组 = 用户看不见这条新话
    {
      const rolledInto = [args.tag, boardBefore.objects?.[parentId]?.tag, boardBefore.objects?.[anchorId]?.tag]
        .find(t => t && board.rolls?.[t]);
      if (rolledInto) lines.push(`⚠ #${rolledInto} 这条线收着卷（用户看不见里面）——这条也进了卷。要让用户看见，先 edit_board unroll{tag:"${rolledInto}"}。`);
    }
    if (laneFrom) {
      lines.push(`Opened lane #${args.tag}${laneFrom !== 'fresh' ? ` branching from ${laneFrom.id}` : ''} on its own sheet`
        + ` — continue it with {tag:"${args.tag}", chain:true}; read_board lists lanes and sheets.`);
    }
    lines.push('The user can annotate it to reply; answer with reply_to (or chain:true on the same tag).');
    return lines;
  };

  /**
   * 这一层上谁占着地方（含文件夹卡 / 卷卡 / 精灵身位，见 lib/board-obstacles.js）。
   *
   * 叠纸（2026-09-01 刀 2）：根层要说清**往哪一页上放**。一摞纸占同一块地，别页的
   * 墨此刻没画在屏幕上，把它算成障碍就是让一块看不见的东西挡住真正空着的地方 ——
   * 在第二页写第一笔当场报「纸满」。文件夹层没有纸，那儿传了也没用。
   *
   * 落在哪一页：版位点名的那张 > 入参点名的 > 会话正写的那张。
   */
  const obstaclesFor = (b, zone, { slotInfo = null, sheetName = null } = {}) => {
    const sheetId = zone ? null : (slotInfo?.sheet?.id
      || (sheetName && b?.sheets?.[sheetName] ? sheetName : null)
      || currentSheet(b, currentSheetIdOf(sessionId))?.id
      || null);
    return obstaclesIn(b, zone, { sheetId });
  };

  return { placeOnSheets, placeInZone, describeSpot, resolveSlot, placeInSlot, describeSheetFull, placeOverflowOnShelf, describeOverflow, describeChalkWrite, obstaclesFor };
}
