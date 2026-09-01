/**
 * mcp/tools/write-on-board-place.js —— write_on_board 的纸上落位（2026-08-29 纸范式刀 2，
 * 行数棘轮拆件：text 与 sketch 两条路共用同一份落位与返回文案）。
 *
 * 决策树（2026-09-01 刀 2 撤掉版位那一支之后）：
 *   near+side 显式 → 精确贴放（语义要求；压上如实报）
 *   reply_to      → 接楼正下方（接不下去 → 同页顺排 → 翻页）
 *   at            → 纸内定点（钳进版心，钳了如实报）
 *   什么都没有    → **机器按栏排**（竖着填满一栏、到底换右边一栏、整页满了翻下一页）
 * 文件夹层没有纸：线程/贴放照常，否则排在这一层内容底下。
 *
 * 翻了一页还是装不下（这一条本身比一整页还大）才走溢出暂存。
 */

import {
  currentSheet, toLocal,
  nextSpotInSheet, overlapIds, sheetOfPoint, innerRect, resolveSheet, sheetColumns, freeColumnsInSheet,
} from '../../../lib/board-sheets.js';
import { placeAtOnSheet, placeThread, placeBeside } from '../../../lib/board-place.js';
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
   * 根层：纸上落位。返回 {x,y,resolution,sheetId,opened,turned,clamped,pressed}
   *
   * ## ⭐ 2026-09-01 刀 2：纸满**自动翻到这一摞的下一页**
   *
   * 08-29 刀 F 定的是反过来的规矩 ——「机器绝不替 agent 翻页」。那条当时是对的，
   * 理由写在旧注释里：机器悄悄翻页，agent 不知道自己换了页，**新纸自然也没有
   * 版面**，规划好的 p2 一写满就散回顺排。
   *
   * ⭐ 注意那个理由的落点是**版面**。版位 09-01 撤了（站主：「模型在纸张中只需要
   * 输入内容，然后由机械层自动排版切层」），于是翻页不再毁掉任何东西：新一页
   * 跟上一页是同一摞、同一套栏格，读的人一翻就到。理由没了，规矩就得跟着改 ——
   * 留着它只会让「装不下」重新变成 agent 的活。
   *
   * 一次调用最多翻**一页**：连新的一整页都装不下，那是这一条本身太大（或者纸
   * 太小），再翻下去就是无限翻页。那种情况照旧走溢出暂存。
   */
  const placeOnSheets = async (b, { box, at, sheetName, replyRect, anchorRect, side, obstacles }) => {
    let sheets = b.sheets || {};
    let opened = null;      // 铺了第一张纸（板上原来一张都没有）
    let turned = null;      // 翻了一页（这一摞的下一页）
    const pick = () => {
      if (sheetName && sheets[sheetName]) return resolveSheet(b, sheetName);
      return currentSheet({ sheets }, currentSheetIdOf(sessionId));
    };
    const remember = (o) => {
      sheets = {
        ...sheets,
        [o.id]: { x: o.x, y: o.y, w: o.w, h: o.h, at: o.at, by: o.by, ...(o.colW ? { colW: o.colW } : {}), ...(o.stack ? { stack: o.stack } : {}) },
      };
      return { id: o.id, ...sheets[o.id] };
    };
    /** 铺第一张纸（还一张都没有时） */
    const openFirst = async () => {
      opened = await openSheetFor(projectId, { sessionId, by, where: null });
      return remember(opened);
    };
    const bWith = () => ({ ...b, sheets });
    const done = (p, resolution, sheetId, clamped = false) => {
      if (sheetId) setCurrentSheetId(sessionId, sheetId);
      const pressed = overlapIds({ x: p.x, y: p.y, w: box.w, h: box.h }, obstacles);
      return {
        x: Math.round(p.x), y: Math.round(p.y), resolution, sheetId, opened, turned, clamped, pressed,
        overflowY: p.overflowY || 0,   // 纸从那个 y 往下不够高还差多少（换纸判据）
        moved: !!p.moved,              // 这一列到底了、往右挪了一块空地
      };
    };
    const sheetOf = (p) => {
      const hit = sheetOfPoint(bWith(), { x: p.x + box.w / 2, y: p.y + box.h / 2 });
      return hit ? hit.id : null;
    };
    /**
     * 顺排；这一页满了就翻下一页再排。返回 null = 翻了也放不下（调用方走溢出暂存）。
     */
    const flowOrTurn = async (sheetId, resolution) => {
      const here = nextSpotInSheet(bWith(), sheetId, box);
      if (here) return done(here, resolution, sheetId);
      if (turned) return null;                     // 一次调用只翻一页
      turned = await openSheetFor(projectId, { sessionId, by, where: 'stack', fromSheet: sheetId });
      const next = remember(turned);
      const there = nextSpotInSheet(bWith(), next.id, box);
      return there ? done(there, 'flow-turned', next.id) : null;
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
       * agent 信了这句话去 open_sheet，一场会话开出四张纸。
       *
       * 所以先在同一张纸上顺排。回复关系靠 reply_to 落的那条边保着，本来就
       * 不依赖几何相邻 —— 挪一栏丢的只是"紧贴在下面"这个视觉暗示。
       */
      const flowed = await flowOrTurn(p.sheetFull, 'thread-flow');
      return flowed || { sheetFull: p.sheetFull };
    }
    // 定点 / 顺排：都要有一张纸
    let s = pick();
    if (!s) s = await openFirst();
    if (at) {
      const p = placeAtOnSheet(s, at, box);
      return done(p, 'at', s.id, p.clamped);
    }
    const flowed = await flowOrTurn(s.id, 'flow');
    return flowed || { sheetFull: s.id };
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

  /**
   * 翻了一页还是装不下的报文（2026-09-01 刀 2 之后这条只在**这一件本身比一整页
   * 还大**时出现 —— 纸满已经由机器翻页接住了）。
   */
  const describeSheetFull = (b, sheetId) => {
    const sh = b.sheets?.[sheetId];
    const cols = sh ? sheetColumns({ ...sh, id: sheetId }) : null;
    const cap = cols ? capacityOf(cols.colW, cols.inner.h) : null;
    return [
      `⛔ This does not fit even on a FRESH page — it is bigger than a whole sheet.`,
      cap ? `   A page here is ${cols.n} column(s) of ${cols.colW}px (~${cap.lines} lines each, ~${cap.cjk * cols.n} CJK chars for the page).`
          : `   Sheet ${sheetId} could not take it.`,
      `   Write it shorter, or pass flow:true and the machine will split it at paragraph breaks across pages.`,
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
    const spot = nextShelfSpot(origin);   // 一摞：所有货叠在原点（2026-09-01）
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
    '   · give it a spot: edit_board{ops:[{op:"move", id:"<the path above>", to:{…}}]}, or',
    '   · open a page for it: open_sheet{title:"…"} then move it there.',
  ].join('\n');

  /** 返回文案：从真实落点生成（"工具返回不许撒谎"—— 08-25 陷阱③ 的纪律不变） */
  const describeSpot = (b, placed) => {
    const bits = [];
    if (placed.sheetId && b.sheets?.[placed.sheetId]) {
      const s = resolveSheet(b, placed.sheetId);
      const l = toLocal(s, placed);
      bits.push(`on sheet ${s.id}${s.title ? `（${s.title}）` : ''} at local (${Math.round(l.x)},${Math.round(l.y)})`);
    }
    if (placed.resolution === 'thread') bits.push('under the note it replies to (thread)');
    else if (placed.resolution === 'flow' || placed.resolution === 'thread-flow') {
      bits.push(placed.moved
        ? 'the column it was in filled up — flowed to the top of the next column on the same page'
        : 'flowed below the last item in its column');
    }
    else if (placed.resolution === 'flow-turned') bits.push('the page filled up — the machine TURNED TO A NEW PAGE on the same pile and put it at the top of the first column');
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
    if (placed.turned) bits.push(`turned to page ${placed.turned.id} of pile "${placed.turned.pile}" (the reader flips to it; the page before is intact)`);
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
  const describeChalkWrite = ({ rel, rect, board, placed, box, args, vpRect, parentId, anchorId, laneFrom, boardBefore }) => {
    const lines = [
      `Wrote board note ${rel} at (${rect.x},${rect.y}) ${rect.w}x${rect.h} — ${describeSpot(board, placed)}.`,
      `Visible in the user's viewport: ${visibleIn(rect, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    // 溢出暂存：这段必须紧跟落点，且要点名这条的路径 —— agent 下一步就是拿它去 move
    if (placed.resolution === 'shelf-overflow') lines.push(describeOverflow(placed));
    // 余量随手报（2026-08-30 容量线；09-01 版位换成栏）：下一条还塞不塞得下，
    // 最有用的时机就是刚写完这一刻 —— 别让它再去翻状态块或者赌一发。
    if (placed.sheetId && board.sheets?.[placed.sheetId]) {
      const cols = freeColumnsInSheet(board, placed.sheetId);
      const best = cols.reduce((n, c) => Math.max(n, c.freeH), 0);
      const cw = sheetColumns({ ...board.sheets[placed.sheetId], id: placed.sheetId }).colW;
      const c = capacityOf(cw, best);
      lines.push(`Page ${placed.sheetId} now has ${cols.length} column(s); the roomiest has ~${c.lines} lines (~${c.cjk} CJK chars, ${best}px) left. When they all fill, the machine turns the page for you.`);
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
   * 落在哪一页：入参点名的那张 > 会话正写的那张。
   */
  const obstaclesFor = (b, zone, { sheetName = null } = {}) => {
    const sheetId = zone ? null : ((sheetName && b?.sheets?.[sheetName] ? sheetName : null)
      || currentSheet(b, currentSheetIdOf(sessionId))?.id
      || null);
    return obstaclesIn(b, zone, { sheetId });
  };

  return { placeOnSheets, placeInZone, describeSpot, describeSheetFull, placeOverflowOnShelf, describeOverflow, describeChalkWrite, obstaclesFor };
}
