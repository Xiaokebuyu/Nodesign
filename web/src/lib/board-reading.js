/**
 * 画布的「阅读顺序」与「一件占满一屏」（2026-08-28 移动端第二轮）
 *
 * ## 这是什么
 *
 * 无限画布在桌面上不需要顺序：一屏就能看见十几件，眼睛自己会挑。手机上不行 ——
 * 390 宽的屏装不下一件 450 宽的板书，于是画布退化成一个透过纸筒看画的体验，
 * 而**纸筒必须有个移动的章法**。这里就是那个章法：
 *
 *   1. 把散在二维平面上的物件排成一条**读得下去的序**（像读一页报纸：先分行，
 *      行内从左到右）；
 *   2. 给「翻到上一件 / 下一件」提供索引；
 *   3. 定义「一件占满一屏」到底是什么取景。
 *
 * ## ⭐ 为什么是「按宽度取景」而不是「整件入镜」
 *
 * 手机上读长内容的天然姿势是**竖着滚**。差别随内容变高而张开（390x664 的屏）：
 *
 *     450x150  的短块   整件 0.76  ｜ 按宽 0.82    几乎一样
 *     450x900  的板书   整件 0.68  ｜ 按宽 0.82    小赚
 *     450x1800 的长板   整件 0.34  ｜ 按宽 0.82    **16px 正文 5.5px vs 13px**
 *
 * ⚠️ 别把这条的收益说大：短块上两者差不多，真正的收益在长块和「顶对齐」——
 * 整件入镜是把块**居中**，长块居中意味着开头在屏幕外，你得先往上滑才能开始读。
 * 按宽 + 顶对齐则一落地就是这块的第一行。这条对平板同样成立，只是平板上大多数
 * 块本来就装得下，两条路重合。
 *
 * ## ⚠️ 「最近动过的那件」是个有意的近似
 *
 * board.json 的物件没有时间戳（字段全集：by/data/h/kind/tag/w/x/y/z/zone），
 * 但**对象键的插入序就是产出序** —— patchBoard 是 `{...prev, ...patch}`，新 id
 * 落在末尾、老 id 留在原位。所以「最后一个键」= 最后写出来的那件。
 *
 * 它不含「我上次拖过谁」（挪动不改键序）。这是有意的：开局要对准的是**上次
 * 干出来的东西**，不是上次碰过的东西。真要精确到"动过"，得给物件加 mtime，
 * 那是另一档工程，而且多一个字段就多一处会跟别处对不上的真相。
 */

/** 同一行的判据：纵向重叠超过较矮那件的这个比例，就算并排 */
const ROW_OVERLAP = 0.5;

/**
 * 把物件排成阅读顺序：先按行分带，行内从左到右。
 *
 * 纵向单列的板（agent 在手机档下产出的形状）每行只有一件，退化成纯粹的从上到下；
 * 桌面那种横向铺开的老板子则读成"一行一行"。两种都不用调用方操心。
 *
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} items
 * @returns {Array} 同样的对象，按阅读序
 */
export function readingOrder(items) {
  const list = (items || []).filter((it) => it && Number.isFinite(it.x) && Number.isFinite(it.y));
  if (list.length < 2) return list.slice();
  const byTop = list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const it of byTop) {
    const row = rows[rows.length - 1];
    if (row && overlapsRow(row, it)) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y);
      row.bottom = Math.max(row.bottom, it.y + (it.h || 0));
      continue;
    }
    rows.push({ top: it.y, bottom: it.y + (it.h || 0), items: [it] });
  }
  const out = [];
  for (const row of rows) {
    row.items.sort((a, b) => (a.x - b.x) || (a.y - b.y));
    out.push(...row.items);
  }
  return out;
}

function overlapsRow(row, it) {
  const top = it.y;
  const bottom = it.y + (it.h || 0);
  const cover = Math.min(row.bottom, bottom) - Math.max(row.top, top);
  if (cover <= 0) return false;
  // 拿**较矮的那个**当分母：一件很高的东西旁边站着一张小卡，小卡该算同一行
  const shorter = Math.min(row.bottom - row.top, bottom - top);
  return shorter <= 0 ? true : cover / shorter >= ROW_OVERLAP;
}

/**
 * 开局该对准谁：board.objects 的最后一个键（= 最后写出来的那件）。
 *
 * @param {string[]} orderedIds  board.objects 的键序（插入序，别先排序再传进来）
 * @param {Array<{id:string}>} items  当前真在画布上的物件（过滤掉已删/不在这一层的）
 */
export function latestItem(orderedIds, items) {
  const byId = new Map((items || []).map((it) => [it.id, it]));
  for (let i = (orderedIds || []).length - 1; i >= 0; i -= 1) {
    const hit = byId.get(orderedIds[i]);
    if (hit) return hit;
  }
  return (items || [])[0] || null;
}

/**
 * 取景参数：一件东西该怎么占满这一屏。
 *
 * 桌面不走这条路（桌面开局根本不取景，一屏本来就看得见好几件）。
 * 手机/平板都按宽取景 + 顶对齐；差别只在留白：手机屏窄，边距吃掉的比例大得多。
 */
export function readFocusOpts(deviceClass) {
  const pad = deviceClass === 'phone' ? 10 : 20;
  return {
    axis: 'x',
    alignY: 'top',
    padding: { x: pad, y: pad },
    // 小卡片别放到 3 倍去；但也别死守 1 —— 手机上一张 200 宽的便签放到 1.6 倍
    // 才占得住一屏，那正是"一件占满一屏"想要的
    maxZoom: deviceClass === 'phone' ? 1.6 : 1.2,
  };
}

/**
 * 当前读到第几件：取阅读序里**中心离视口中心最近**的那件。
 *
 * 用中心距而不是"第一个与视口相交的"：手机上视口窄，一件高板书能横跨半屏之外，
 * 相交的常常有三四件，而人眼盯着的是中间那件。
 *
 * @returns {number} 索引；序为空回 -1
 */
export function currentIndex(order, camCenter) {
  if (!order?.length || !camCenter) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < order.length; i += 1) {
    const it = order[i];
    const dx = (it.x + (it.w || 0) / 2) - camCenter.x;
    const dy = (it.y + (it.h || 0) / 2) - camCenter.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * 翻一件。到头就停在头/尾（不绕回去 —— 画布不是轮播，绕回去会让人以为翻错了）。
 * @returns {object|null} 目标物件；已经在尽头回 null（调用方据此把按钮置灰）
 */
export function stepItem(order, camCenter, dir) {
  const i = currentIndex(order, camCenter);
  if (i < 0) return null;
  const next = i + (dir > 0 ? 1 : -1);
  if (next < 0 || next >= order.length) return null;
  return order[next];
}
