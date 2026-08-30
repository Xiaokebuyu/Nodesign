/**
 * board-seating —— 桌面入座算法（2026-08-14 可维护性行动 B 刀，从 BoardCanvas
 * 的入座 memo 原样抽出；语义一个字没改，只是参数化了两个 ref 型依赖）。
 *
 * 职责：给定"这一层有什么"（dirIndex）与"谁已经有座"（layout），算出：
 *   positioned    渲染用的物件清单（带 pos / tier / stack*）
 *   folderView    文件夹卡清单
 *   contentBottom 内容底边（幻影找座的起排线）
 *   seatFixes     这一趟新算出的落点（调用方负责落盘 —— 不落布局会跟着交互抖）
 *   noteFixes     批注手写字的跟随落点
 *
 * 设计要点（全部有真实事故背书）：
 *   - **唯一一条自动**是给没有坐标的排落脚点；已摆放的永不重排（北极星与
 *     「顺序是权威坐标是算的」的边界，2026-08-07 定）
 *   - 谱系收叠在主角判断和入座**之前**（藏起来的不参与排座也不抢主角）
 *   - 关系边决定先后（orderWithGroups），字典序只是兜底；关系组独占成行
 *   - 生图新卡先问幻影表过户座位（claimSeat 回调），不跳位
 *   - movingIds 里的旧 id 不落盘（搬家中，落了就是指向死路径的幽灵行）
 */
import { DESKTOP_W, MARGIN_X, ROW_GAP, packRow } from './board-geometry.js';
import { sizeOf } from './board-kinds.js';
import { lineageFolds } from './lineage.js';
import { pickHero } from './hero.js';
import { orderWithGroups } from './relation-order.js';

/**
 * @param {object} deps
 * @param {{ subsOf: Map, byDir: Map }} deps.dirIndex 目录索引（BoardCanvas 的 memo）
 * @param {object} deps.zonesEff        文件夹坐标表
 * @param {object} deps.layout          物件坐标表（board.json objects 的本地态）
 * @param {object} deps.bindings        关系线表
 * @param {Set}    deps.lineageOpen     用户点开的谱系链尾
 * @param {string|null} deps.boardHero  agent 立的显式主角
 * @param {(id: string, pos: {x:number,y:number}) => object} deps.folderCardOf
 * @param {Set}    deps.movingIds       正在搬家的 id（不落盘）
 * @param {(id: string) => {x:number,y:number}|null} deps.claimSeat 幻影座位过户
 * @param {Array<{x,y,w,h}>} [deps.occupied] 占着地方但不在 layout 里的东西
 *        （生图幻影）—— 它们不落盘也不可拖，只能让排座这边躲开
 * @param {{x,y}|null} [deps.shelf] 暂存架原点（board.shelf，2026-08-30）。给了就把
 *        没坐标的新客码进架的竖带（seat:'shelf'），跟服务端入座器同一条纪律 ——
 *        这条是 1.5s 防抖窗口里前端抢先落座那个 race 的补口：抢先也抢进架，
 *        不再在内容底下另起一行。没有架（还没立过）才走老的 packRow 兜底。
 */
export function computeDesktopSeating({
  dirIndex, zonesEff, layout, bindings, lineageOpen, boardHero,
  folderCardOf, movingIds, claimSeat, occupied = [], shelf = null,
}) {
  // ── 桌面这一层（根目录）有哪些文件夹 ──
  // 桌面**永远是根**（2026-08-13）：双击文件夹开窗，桌面不动。
  const folders = (dirIndex.subsOf.get('') || []).map((id) => {
    const z = zonesEff[id] || {};
    return folderCardOf(id, {
      x: Number.isFinite(z.x) ? z.x : 0,
      y: Number.isFinite(z.y) ? z.y : 0,
    });
  });

  // ── 桌面上有哪些物件 ──
  const items = [];
  const fresh = [];
  for (const o of (dirIndex.byDir.get('') || [])) {
    const stored = layout[o.id];
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      items.push({ ...o, pos: stored, zoneId: '' });
    } else if (movingIds?.has(o.id)) {
      // 搬家中、座位又已经撤了（飞进文件夹的动画放完 → useBoardMoves 删了旧 id 的座位），
      // 但产物清单这一拍还没刷回来：这张旧卡不是新客，别给它排座 —— 排了就是「飞进文件夹
      // 之后又闪回桌面、滑向内容区」那个鬼畜（2026-08-22 用户报；远端 RTT 越大越明显）。
      // 清单刷新它就消失；搬失败 useBoardMoves 会把座位放回来，又走上面那条。
      continue;
    } else {
      const it = { ...o, pos: { x: 0, y: 0, z: 1 }, zoneId: '' };
      items.push(it);
      fresh.push(it);
    }
  }

  // 谱系收叠（北极星路线3）：改自链的旧版藏到现役版身后，链尾带徽标。
  const folds = lineageFolds(items.map(it => String(it.id)), bindings, lineageOpen);
  let visItems = items;
  if (folds.hidden.size) visItems = items.filter(it => !folds.hidden.has(String(it.id)));
  for (const it of visItems) {
    const st = folds.stacks.get(String(it.id));
    if (st) { it.stackCount = st.count; it.stackOpen = st.open; }
  }

  // 主角判断（北极星路线1）：显式主角（board.hero）压过推断，不在本层回落自动。
  // 必须在任何 sizeOf 之前标 —— 命中/排布/渲染吃的是同一个 tier。
  const heroId = (boardHero && visItems.some(it => String(it.id) === boardHero))
    ? boardHero
    : pickHero(visItems.map(it => ({ id: String(it.id), type: it.type })), bindings);
  if (heroId) {
    const h = visItems.find(it => String(it.id) === heroId);
    if (h) h.tier = 'hero';
  }

  let seatSlots = [];   // 这一趟排出的槽位（批注跟随要看行几何）
  // ── 唯一一条自动：给还没有坐标的排个落脚点 ──
  let visFresh = fresh.filter(it => !folds.hidden.has(String(it.id)));
  // 座位过户（幻影入座）：生图占位卡在哪儿等，成品就坐哪儿，不跳位。
  const adopted = [];
  for (const it of visFresh) {
    if (it.type !== 'image') continue;
    const seat = claimSeat?.(it.id);
    if (seat) { it.pos = { ...it.pos, ...seat }; adopted.push(it); }
  }
  if (adopted.length) visFresh = visFresh.filter(it => !adopted.includes(it));
  if (visFresh.length) {
    let seatedBottom = 0;
    for (const f of folders) seatedBottom = Math.max(seatedBottom, f.y + f.h);
    for (const it of visItems) {
      if (visFresh.includes(it)) continue;
      seatedBottom = Math.max(seatedBottom, it.pos.y + sizeOf(it).h);
    }
    // 生图幻影也算"已有内容"（2026-08-17，issue #1 第 9 条）。它跟新卡的起排线
    // 本来是同一条 —— 幻影出生时躲开了所有真卡，可没人躲它，于是"等图的时候
    // 又落了一件东西"必然叠在一起。它不落盘不可拖，让不开，只能这边躲。
    for (const r of occupied) seatedBottom = Math.max(seatedBottom, r.y + r.h);
    // 关系边决定先后（对照/关联凑相邻、接着正向、改自旧→新），字典序兜底；
    // 多成员关系组独占成行（breakBefore），组内紧凑、组间呼吸。
    const byId = new Map(visFresh.map(it => [String(it.id), it]));
    const { order, breakBefore } = orderWithGroups(
      [...byId.keys()].sort((a, b) => a.localeCompare(b)),
      bindings,
    );
    const ordered = order.map(id => byId.get(id));
    if (shelf && Number.isFinite(shelf.x) && Number.isFinite(shelf.y)) {
      // 暂存架模式：竖带占位判据与 server/lib/board-shelf.js nextShelfSpot 同款
      //（常量 360/24 是那份的对齐拷贝 —— 架带宽/间距）
      let bottomY = shelf.y;
      const consider = (x, y, w, h) => {
        if (x + w > shelf.x && x < shelf.x + 360 && y + h > shelf.y) bottomY = Math.max(bottomY, y + h + 24);
      };
      for (const f of folders) consider(f.x, f.y, f.w, f.h);
      for (const it of visItems) {
        if (visFresh.includes(it)) continue;
        const sz = sizeOf(it); consider(it.pos.x, it.pos.y, sz.w, sz.h);
      }
      for (const r of occupied) consider(r.x, r.y, r.w, r.h);
      seatSlots = ordered.map((it) => {
        const sz = sizeOf(it);
        it.pos = { ...it.pos, x: shelf.x, y: bottomY, seat: 'shelf' };
        const slot = { id: it.id, x: shelf.x, y: bottomY, w: sz.w, h: sz.h };
        bottomY += sz.h + 24;
        return slot;
      });
    } else {
      const packed = packRow(
        ordered.map(it => {
          const sz = sizeOf(it);
          return { id: it.id, w: sz.w, h: sz.h, breakBefore: breakBefore.has(String(it.id)) };
        }),
        { width: DESKTOP_W - MARGIN_X * 2, xMin: MARGIN_X, yTop: seatedBottom ? seatedBottom + ROW_GAP : MARGIN_X },
      );
      const slotById = new Map(packed.slots.map(s => [s.id, s]));
      for (const it of visFresh) {
        const s = slotById.get(it.id);
        if (s) it.pos = { ...it.pos, x: s.x, y: s.y };
      }
      seatSlots = packed.slots;
    }
  }

  let bottom = 0;
  for (const f of folders) bottom = Math.max(bottom, f.y + f.h);
  for (const it of visItems) bottom = Math.max(bottom, it.pos.y + sizeOf(it).h);
  // 新算出来的落点交给调用方落盘；过户来的座位（adopted）同样要落 ——
  // 它就是这张图的正式座位
  const seatFixes = {};
  for (const it of [...visFresh, ...adopted]) {
    if (movingIds?.has(it.id)) continue;   // 正在搬家，别给旧 id 排座
    seatFixes[it.id] = { x: it.pos.x, y: it.pos.y, ...(it.pos.seat === 'shelf' ? { seat: 'shelf' } : {}) };
  }
  // 批注文字跟着目标搬家（北极星二程）：目标这一趟被重新落座时，贴着它说话
  // 的手写字跟过去。落点 = 首目标所在**行**的右端空白（不是目标右侧 +24 ——
  // 网格里那个位置就是相邻卡）。只搬 kind==='text'（涂鸦坐标是内容，永不代摆）。
  const noteFixes = {};
  if (visFresh.length) {
    const freshIds = new Set(visFresh.map(it => String(it.id)));
    const textTargets = new Map();
    for (const b of Object.values(bindings || {})) {
      if (b.type !== 'annotates' || !String(b.from).startsWith('text:')) continue;
      if (!freshIds.has(b.to)) continue;
      if (!textTargets.has(b.from)) textTargets.set(b.from, []);
      textTargets.get(b.from).push(b.to);
    }
    for (const [tid, targets] of textTargets) {
      if (layout[tid]?.kind !== 'text') continue;
      const tSlots = targets.map(id => seatSlots.find(sl => sl.id === id)).filter(Boolean);
      if (!tSlots.length) continue;
      const anchorY = Math.min(...tSlots.map(sl => sl.y));
      const rowRight = Math.max(...seatSlots.filter(sl => sl.y === anchorY).map(sl => sl.x + sl.w));
      const noteW = layout[tid].w || 160;
      noteFixes[tid] = {
        x: Math.round(Math.min(rowRight + 24, DESKTOP_W - MARGIN_X - noteW)),
        y: Math.round(anchorY),
      };
    }
  }
  return { positioned: visItems, folderView: folders, contentBottom: bottom, seatFixes, noteFixes };
}
