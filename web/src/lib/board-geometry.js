/**
 * board-geometry.js — 桌面画布的几何常量与纯函数（2026-07-28 重构 3 抽出）
 *
 * BoardCanvas（桌面）与 StageLayer（舞台）共享，避免互相 import 的循环依赖。
 * 常量语义见 BoardCanvas 顶部说明。（服务端 ZONE_DEFAULTS 已随 zones 瘦身
 * 删除 —— zones 存档只剩坐标，尺寸恒为这里的 FOLDER_CARD。）
 */

// 桌面逻辑宽度固定（跨端坐标稳定），视口窄时整体 fitScale 等比缩（非交互）
export const DESKTOP_W = 1360;
// 反馈两轮都是同一句"文件夹周边空隙太多"：48 → 24（07-29）→ 10（07-30）。
// 工作区宽度由堆叠 effect 按 DESKTOP_W - MARGIN_X*2 重算，存档矩形下次渲染自动迁移。
export const MARGIN_X = 10;               // 桌面左右留白
export const ZONE_GAP_Y = 28;             // 堆叠工作区之间的垂直间距
/**
 * 文件夹卡的脚印（2026-08-13）。**方卡**，跟桌面上别的东西一样是"一个物件"。
 *
 * 在这之前文件夹有两态：收起是一条整宽窄条、展开是一块带标题栏的实体区域，
 * 成员摆在框里。那套几何（区内网格 / 区内排布 / 分组带 / 一屏画幅）随
 * "当前目录"模型一起退役 —— 现在进文件夹是**换一层桌面**，不是把框摊开。
 */
// 2026-08-13 从 200×200 加大：卡面要装下 2×2 的真缩略（图片直出、deck/站点
// LiveFrame 微缩），200 宽的格子里缩略什么都看不清（用户要"看一眼知道装了什么"）
export const FOLDER_CARD = { w: 288, h: 240 };
export const FOLDER_CARD_H = FOLDER_CARD.h;
export const DECK_EMBED_W = 640;          // deck 内嵌渲染宽度（1920 → 1/3 缩放）
/**
 * 一张卡的高度天花板（2026-08-29 占位契约刀 B→E，站主定「一张纸的 40%」）。
 * 真身与理由在 `server/lib/screen.js` 的 CARD_MAX_H（parity 测试钉着两端一致）。
 *
 * ⚠️ 执行点在**工具层**不在这里：写不下就拒收，让 agent 分块重排。前端留着这个
 * 常量只为算文件卡预览体的裁切高度（那是文件内容，agent 分不了块）。
 * 折叠展开做过一版，站主否掉 ——「收起展开没必要」，那是替它把问题藏起来。
 */
export const CARD_MAX_H = 384;

/**
 * 纸的版心边距（真身 `server/lib/board-sheets.js` 的 SHEET_MARGIN，parity 钉着）。
 * 前端要它是因为流式板书要把 agent 给的**纸内局部坐标**换算成世界坐标 —— 字才
 * 能流到它真正要去的地方（2026-08-29 占位契约刀 C）。
 */
export const SHEET_MARGIN = 24;
/** 版位内两件之间的间距（服务端 nextSpotInSlot 的 gap，同为 UNIT） */
const SLOT_GAP = 24;

/**
 * 纸内局部坐标 → 世界坐标。
 *
 * `sheet` 没点名时回落到"登记时间最新的那张"—— 跟服务端 currentSheet 的回落逻辑
 * 一致（服务端还多一层会话指针，那是前端够不着的；模型点名了 sheet 就没有分歧）。
 * 算不出来返回 null，调用方退回原来的"视口里一块空地"。
 *
 * @param {object} sheets  board.sheets
 * @param {{at?:{x,y}, sheet?:string}} spot  流式入参里抽出来的位置字段
 */
export function sheetSpotToWorld(sheets, spot, layout = null) {
  const table = sheets || {};
  let s = spot?.sheet ? table[spot.sheet] : null;
  if (!s) {
    for (const v of Object.values(table)) {
      if (!Number.isFinite(v?.x)) continue;
      if (!s || String(v.at || '') > String(s.at || '')) s = v;
    }
  }
  if (!s || !Number.isFinite(s.x)) return null;

  // 版位优先（2026-08-29 刀 E）：agent 规划过的块。落点跟服务端 nextSpotInSlot
  // 同一条规则 —— 接在这块地里最低那件下面。**两处算同一件事**是有意的：服务端
  // 是权威（落盘的那个数），这里只是让流式预览落在同一个地方，写完不跳。
  // 规则只有"往下接"一条，简单到不值得为它开一条前后端通信。
  const sl = spot?.slot ? s.slots?.[spot.slot] : null;
  if (sl) {
    const rect = { x: s.x + SHEET_MARGIN + sl.x, y: s.y + SHEET_MARGIN + sl.y, w: sl.w, h: sl.h };
    let bottom = rect.y - SLOT_GAP;
    for (const e of Object.values(layout || {})) {
      if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
      const cx = e.x + (e.w || 0) / 2; const cy = e.y + (e.h || 0) / 2;
      if (cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h) {
        bottom = Math.max(bottom, e.y + (e.h || 0));
      }
    }
    return { x: Math.round(rect.x), y: Math.round(bottom + SLOT_GAP), w: sl.w };
  }

  if (!spot?.at || !Number.isFinite(spot.at.x) || !Number.isFinite(spot.at.y)) return null;
  return { x: Math.round(s.x + SHEET_MARGIN + spot.at.x), y: Math.round(s.y + SHEET_MARGIN + spot.at.y) };
}
export const STAGE_CARD_W = 560;          // 舞台卡宽度（板内坐标系）

// 项目区顶带（2026-07-28）：项目级四件套（记忆 / 指引 / 品牌 / 文件）常驻桌面顶部，
// 工作区往下排。ProjectHub 那个二级页由此退役 —— 项目级东西回到同一张桌面上。
export const PROJECT_BAND_Y = 16;
export const PROJECT_CARD_W = 232;
export const PROJECT_CARD_H = 84;
export const PROJECT_BAND_H = PROJECT_CARD_H + 28;

export const ZONE = {
  w: 1120, h: 640, gap: 60, bandX: 320, bandY: PROJECT_BAND_Y + PROJECT_BAND_H, perRow: 3,
  header: 56, pad: 16, cellW: 244, cellH: 210,
};

// 工作区实际高度贴内容走（ZONE.h 只是创建时的估算矩形）；这是空区的最小身位：
// 标题栏 + 一格边距 + 够接住一次拖放的空地。空工作区不再占大半屏空画幅。
export const ZONE_MIN_H = ZONE.header + ZONE.pad * 2 + 120;
/**
 * 空文件夹的最小宽度（2026-08-08）。
 *
 * 文件夹从整宽的一条带变成桌面上的一张卡之后，宽度贴内容 —— 但空的时候
 * 得有个身位：够放下标题、计数和那排按钮，再留一格能接住一次拖放的空地。
 */
export const ZONE_MIN_W = 300;

// 物件尺寸表已随「形态能力表」搬去 `board-kinds.js`（2026-08-07）：尺寸是
// 形态的属性之一，跟它的阅读器 / 工具条 / 展开能力属于同一张表，散在两个
// 文件里会出现「加了形态忘了加尺寸」。这里只留纯几何（桌面/工作区/避让）。
// 需要 `sizeOf` / `SIZES` 的从 board-kinds.js 取。

/**
 * 站点预览的视口档位。
 *
 * deck 用「比例」（16:9 / 9:16…），站点用「宽度」—— 这是两种东西：deck 的版面
 * 是照着一个固定画布画死的，站点的版面是被视口宽度算出来的。所以这里给的是
 * 真实设备宽度，iframe 的 CSS 像素宽就设成它，**不做整体缩放**，否则手机档只是
 * 一张缩小的桌面版截图，看不出断点有没有生效。
 */
export const SITE_VIEWPORTS = [
  { id: 'desktop', label: '桌面', w: 1440, icon: 'monitor' },
  { id: 'tablet',  label: '平板', w: 834,  icon: 'tablet' },
  { id: 'mobile',  label: '手机', w: 390,  icon: 'smartphone' },
];

export const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const POP_IN = 'ndPopIn 260ms cubic-bezier(0.32, 0.72, 0, 1)';

/* ── 区内排布：顺序是权威，坐标是算出来的（2026-08-01 写，2026-08-07 接线）──
 *
 * 用户报过两件事「自由拖拽手感差」「排列空格不均匀」，量下来是同一处数学的
 * 两个后果：格子写死 244×210，而卡高从 40（文件条）到 176（图片）不等 ——
 * 一排 deck 卡（88 高）下面永远吊 122px 死白；区宽去 pad 剩 1088，
 * floor(1088/244)=4 列只用掉 976，**右边 112px 谁都用不上**。
 *
 * 用户拍板「全部自动排，拖只是换位置」，于是模型换成：顺序是权威，坐标是
 * 派生值。坐标仍存 board.json（schema 不动、pin_to_board 不受影响），
 * 只是从"真相"降级成"算出来的结果"。
 *
 * ⚠️ 这段纯函数 08-01 就写完了、20 条断言也全过，但**一直没有调用点**，
 * 在 exp/world-live-0801 上躺了六天。08-07 相机改造后截图里那片空隙就是它。
 */
/** 收纳文件夹标题带的高度（一行小字 + 呼吸） */
export const GROUP_LABEL_H = 26;

export const COL_W = 240;
export const COL_GAP = 16;
export const ROW_GAP = 16;
/** 块边界（关系组）的行距：affinity「摆近点」的反面是组间要呼吸 —— 组内
 *  行距 ROW_GAP、组间 BLOCK_GAP，留白差就是版面的分段语言（北极星路线2） */
export const BLOCK_GAP = 40;

/**
 * 把一组成员按顺序排进一个宽度里（纯函数）。
 *
 * @param {Array<{id, w, h}>} members  **已经按想要的先后排好**
 * @param {{width:number, xMin:number, yTop:number}} box
 * @returns {{ slots: Array<{id,x,y,w,h}>, bottom:number, cols:number }}
 */
export function packRow(members, { width, xMin, yTop }) {
  const cols = Math.max(1, Math.floor((width + COL_GAP) / (COL_W + COL_GAP)));
  const used = cols * COL_W + (cols - 1) * COL_GAP;
  // 余量居中，而不是全留给右边。整块内容偏左是旧网格最显眼的毛病之一
  // （区宽 1088 / 格宽 244 → 4 列只用掉 976，右边空 112 谁都用不上）。
  const xStart = xMin + Math.max(0, Math.floor((width - used) / 2));

  const slots = [];
  let col = 0; let rowY = yTop; let rowH = 0;
  for (const m of members) {
    const span = Math.min(cols, Math.max(1, Math.ceil((m.w + COL_GAP) / (COL_W + COL_GAP))));
    // 块边界（北极星二程）：关系组独占成行 —— 组头/组后强制换行，
    // 且换行用 BLOCK_GAP（组间呼吸 > 组内行距）。行首的 breakBefore 是 noop。
    if (m.breakBefore && col > 0) {
      rowY += rowH + BLOCK_GAP;
      col = 0; rowH = 0;
    }
    if (col > 0 && col + span > cols) {   // 这一行放不下了，换行
      rowY += rowH + ROW_GAP;
      col = 0; rowH = 0;
    }
    slots.push({ id: m.id, x: xStart + col * (COL_W + COL_GAP), y: rowY, w: m.w, h: m.h });
    rowH = Math.max(rowH, m.h);
    col += span;
    if (col >= cols) { rowY += rowH + ROW_GAP; col = 0; rowH = 0; }
  }
  return { slots, bottom: rowY + rowH, cols };
}

/**
 * 光标落在这串槽位的第几个之前（拖拽期间算插入点）。
 *
 * 判法是**读序**而不是最近距离：先按行找（落在哪一行的垂直范围里），再在行内
 * 按水平中点找。最近距离在换行处会跳 —— 你把卡拖到一行的右端，欧氏距离上
 * 下一行的行首可能更近，于是预览疯狂跳两个位置。读序不会。
 *
 * @returns {number} 插入下标 [0, slots.length]
 */
export function insertIndexAt(slots, x, y) {
  if (!slots.length) return 0;
  const rows = [];
  for (const s of slots) {
    const row = rows.find(r => Math.abs(r.y - s.y) < 1);
    if (row) row.items.push(s);
    else rows.push({ y: s.y, h: s.h, items: [s] });
  }
  for (const r of rows) r.h = Math.max(...r.items.map(s => s.h));

  let row = rows.find(r => y < r.y + r.h + ROW_GAP / 2);
  if (!row) row = rows[rows.length - 1];       // 落在所有行下面 → 末行
  let idx = slots.indexOf(row.items[0]);
  for (const s of row.items) {
    if (x < s.x + s.w / 2) return idx;
    idx += 1;
  }
  return idx;
}

// ── 同区避让系统（2026-07-29）──────────────────────────────────────────
//
// 语义：**交互中的卡有路权，别人让**。谁的 z 大（最近被摸过 / 展开过）谁不动，
// 其余成员按最小位移让位：向下 / 向右 / 向左三个方向挑挪得最少的，连锁避让；
// 侧移次数超限后只往下（y 单调增，必收敛）。这是"避让"不是"排斥"——
// 卡可以被拖到任何地方，是周围的卡自己走开。
export const AVOID_GAP = 12;
const AVOID_MAX_ITER = 60;
const AVOID_SIDE_ITER = 8;

export const rectsHit = (a, b) =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 对一个工作区的成员做避让重排（纯函数，不改入参）。
 *
 * @param {Array<{id, pos:{x,y,z?}, w, h}>} members  含尺寸的成员矩形
 * @param {{ xMin:number, xMax:number, yMin:number }} bounds
 *        xMin/xMax = 水平可用范围（xMax 按"左边缘最大值"传），yMin = 区内容顶
 * @returns {{ moved: Map<string,{x,y}>, bottom: number }}
 *        moved 只含真被挪动的成员；bottom = 重排后内容最低点
 */
export function resolveZoneAvoidance(members, { xMin, xMax, yMin }) {
  const ordered = [...members].sort((a, b) =>
    (b.pos.z ?? 1) - (a.pos.z ?? 1) || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  const placed = [];
  const moved = new Map();
  let bottom = yMin;
  for (const m of ordered) {
    const rect = { x: m.pos.x, y: m.pos.y, w: m.w, h: m.h };
    let guard = 0;
    while (guard < AVOID_MAX_ITER) {
      const blocker = placed.find(r => rectsHit(rect, r));
      if (!blocker) break;
      guard += 1;
      const down = blocker.y + blocker.h + AVOID_GAP - rect.y;
      const cands = [{ dx: 0, dy: down, cost: down }];
      if (guard <= AVOID_SIDE_ITER) {
        const right = blocker.x + blocker.w + AVOID_GAP - rect.x;
        const left = rect.x + rect.w + AVOID_GAP - blocker.x;
        if (rect.x + right <= xMax) cands.push({ dx: right, dy: 0, cost: right });
        if (rect.x - left >= xMin) cands.push({ dx: -left, dy: 0, cost: left });
      }
      cands.sort((a, b) => a.cost - b.cost);
      rect.x += cands[0].dx; rect.y += cands[0].dy;
    }
    if (guard >= AVOID_MAX_ITER) {
      // 不收敛兜底：回原 x，垂直堆到当前最底
      rect.x = m.pos.x;
      rect.y = placed.reduce((mx, r) => Math.max(mx, r.y + r.h), yMin) + AVOID_GAP;
    }
    if (Math.abs(rect.x - m.pos.x) > 0.5 || Math.abs(rect.y - m.pos.y) > 0.5) {
      moved.set(m.id, { x: rect.x, y: rect.y });
    }
    placed.push(rect);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { moved, bottom };
}

// ── 几何点选（2026-08-27，随点选操作条撤役从 action-bar-place.js 搬来）────
//
// 画布的指针事件在捕获下会被重定向（平移层 setPointerCapture 后 click/dblclick
// 落到公共祖先 —— 08-25 板书武装案实锤），闲置板书又被 board-hit 归成空地。
// 所以「点了哪件东西」只能拿世界坐标对矩形算，DOM 的 target 不可信。
// 几何命中顺带把**叠堆下翻**白送了：一摞卡片点第一下命中最上面的，再点同一处
// 循环翻到底下那件 —— DOM 永远只给你最上面的那个。

/**
 * 世界坐标点选：这一点底下压着哪些物件，最上面的排最前。
 * @param {Array} objects   带 pos{x,y,z} 的物件（positioned 那份）
 * @param {Function} sizeOfFn  物件 → {w,h}
 * @param {{x,y}} pt        世界坐标
 * @returns {string[]}      物件 id，按 z 从高到低（同 z 按渲染序靠后者先）
 */
export function hitsAt(objects, sizeOfFn, pt) {
  const hs = [];
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    const sz = sizeOfFn(o) || { w: 0, h: 0 };
    if (pt.x >= o.pos.x && pt.x <= o.pos.x + sz.w && pt.y >= o.pos.y && pt.y <= o.pos.y + sz.h) {
      hs.push(o);
    }
  }
  hs.sort((a, b) => (b.pos.z || 1) - (a.pos.z || 1));
  return hs.map((o) => o.id);
}

/**
 * 叠堆下翻：当前选中的在命中列表里 → 选它底下那件（到底再绕回顶）；
 * 不在（或没选）→ 选最上面的。列表为空 → null（点了空地，取消选中）。
 */
export function nextPick(hits, currentId) {
  if (!hits.length) return null;
  const i = currentId ? hits.indexOf(currentId) : -1;
  return i < 0 ? hits[0] : hits[(i + 1) % hits.length];
}

/** 新工作区先在现有栈底占位（用存档矩形估算），堆叠 effect 下一拍精确归位 */
export function newStackedZoneRect(zones) {
  /**
   * 新文件夹的落脚点：从已有的最低边往下再放一行。
   *
   * ⚠️ 2026-08-13 尺寸改成方卡。原来返回的是 `w: 桌面宽 - 边距, h: ZONE.h`
   * （1340×640）—— 那是"文件夹是版面上一整条带"时代的形状。文件夹变方卡之后
   * 那两个数字没人读了，但它们**会被写进 board.json**，成为将来读代码的人
   * 手里一份自相矛盾的证据（画布上 200 宽，存档里 1340）。
   *
   * 横向也换成一行一行排：一条 1340 宽的东西下面只能再放一条，而 200 的卡
   * 一行能放六个。
   */
  const cols = Math.max(1, Math.floor((DESKTOP_W - MARGIN_X * 2 + COL_GAP) / (FOLDER_CARD.w + COL_GAP)));
  const n = Object.keys(zones || {}).length;
  return {
    x: MARGIN_X + (n % cols) * (FOLDER_CARD.w + COL_GAP),
    y: MARGIN_X + Math.floor(n / cols) * (FOLDER_CARD.h + ROW_GAP),
    w: FOLDER_CARD.w,
    h: FOLDER_CARD.h,
  };
}
