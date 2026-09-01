/**
 * server/lib/board-stacks.js —— 栈（一摞纸）的身份与几何派生（2026-09-01 叠纸刀 0）
 *
 * ## 为什么有这一层
 *
 * 纸范式（08-29）到现在，纸是**横着排、竖着长**的：新纸铺在当前纸正下方，一场
 * 演出下来板子越长越高。真板实测 proj_mthruv6h_900v：一场 47 分钟的手机演出开了
 * 7 张纸，从 y=-408 排到 y=4454，用户在 390 的屏上跟这场戏要滑 4862 个像素；
 * 而那张「状态表」夹在第三位，想看一眼就得往回滑一整屏再滑回来。
 *
 * 叠纸把第三个方向加进来：**一摞纸占同一块地，一次只显示其中一张**。于是导航
 * 从一条轴变成两条 —— 左右换摞，上下翻这一摞里的纸。
 *
 * ## 栈只有身份，几何是派生的
 *
 * `board.stacks[name]` 里没有 x/y/w/h。原点取成员纸的 x/y（同一摞里它们相等，
 * 这就是"叠在一起"的定义），宽高取成员的最大值，都在这儿现算。
 *
 * ⛔ 位置**没有**搬到栈上，这是有意的：全仓有二十来处代码在 `{...board.sheets[id]}`
 * 上直接读 `.x/.y`，把位置抽走会让它们静默拿到 undefined，再经 innerRect 变成 NaN。
 * 「一个事实两份存储」的账在这儿是这么还的：**写入口只有一个**（铺纸时把纸的 x/y
 * 设成这一摞的原点），不变量由 `stackInvariantErrors` 在测试里钉着。
 *
 * ## 没有 stack 字段的纸自己就是一摞
 *
 * 存量 103 张纸一张都没有这个字段，而它们本来就不叠。这里把它们当成**隐式的
 * 单张摞**（`implicit: true`），于是导航、翻页、目录对新老板子是同一套代码，
 * 不需要先跑一次全库迁移才敢上线。
 */

import { sheetRects } from './board-sheets.js';

/** 这张纸属于哪一摞。没登记过就用纸名当摞名（隐式单张摞） */
export function stackOfSheet(board, sheetId) {
  const s = board?.sheets?.[sheetId];
  if (!s) return null;
  return s.stack || sheetId;
}

/**
 * 一摞里的纸，按登记时间从早到晚（= 翻页序，第一张在最底下）。
 * 摞名可能是隐式的（等于纸名），所以两种都要认。
 */
export function sheetsInStack(board, stackName) {
  const out = [];
  for (const s of sheetRects(board)) {
    if (stackOfSheet(board, s.id) === stackName) out.push(s);
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
}

/**
 * 板上所有的摞，按阅读序（先上后下、同带先左后右 —— 跟 sheetRects 同一把尺）。
 *
 * @returns {Array<{name, x, y, w, h, title, by, at, sheets:string[], implicit:boolean}>}
 */
export function stacksOf(board) {
  const groups = new Map();
  for (const s of sheetRects(board)) {
    const name = stackOfSheet(board, s.id);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  }
  const out = [];
  for (const [name, members] of groups) {
    members.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
    const reg = board?.stacks?.[name] || null;
    // 原点取**最早那张**的 x/y（不变量成立时全体相等；万一被外部写歪了，
    // 取第一张比取最小值稳 —— 后者会让一次写歪把整摞悄悄挪走）
    const head = members[0];
    out.push({
      name,
      x: head.x, y: head.y,
      w: Math.max(...members.map((m) => m.w)),
      h: Math.max(...members.map((m) => m.h)),
      title: reg?.title || head.title || null,
      by: reg?.by || head.by || null,
      at: reg?.at || head.at || '',
      sheets: members.map((m) => m.id),
      implicit: !board?.stacks?.[name],
    });
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** 一摞的矩形（世界坐标）。摞不存在返回 null */
export function stackRectOf(board, stackName) {
  return stacksOf(board).find((s) => s.name === stackName) || null;
}

/**
 * 这一摞的产物地（世界坐标）。没规划过返回 null。
 *
 * 产物地原来是**纸**的属性（版位的 `for:'artifacts'`）。这一版栈只叠墨（板书 /
 * 手写字 / 涂鸦），产物不参与叠放、一直看得见 —— 两张叠着的纸各规划一块产物地
 * 的话，两件产物会落在同一块世界坐标上互相压，那正是"产物被覆盖"。所以这块地
 * 升到栈上：一摞纸共享一块，翻页只换正文，产物原地不动。
 */
export function stackArtifactsRect(board, stackName) {
  const reg = board?.stacks?.[stackName];
  const a = reg?.artifacts;
  if (!a) return null;
  const st = stackRectOf(board, stackName);
  if (!st) return null;
  return { x: st.x + a.x, y: st.y + a.y, w: a.w, h: a.h };
}

/**
 * 不变量自查：同一摞里所有纸的 x/y 必须相等。
 *
 * ⚠️ 这不是运行时守卫（跑在热路径上不值），是给测试和一次性脚本用的判据。
 * 铺纸是唯一会写这几个数的入口，守住那一个入口就够；这条用来证明它守住了。
 *
 * @returns {string[]} 违例说明，空数组 = 干净
 */
export function stackInvariantErrors(board) {
  const errs = [];
  for (const st of stacksOf(board)) {
    if (st.sheets.length < 2) continue;
    for (const id of st.sheets) {
      const s = board.sheets[id];
      if (s.x !== st.x || s.y !== st.y) {
        errs.push(`纸 ${id} 在摞 ${st.name} 里，坐标 (${s.x},${s.y}) 跟摞原点 (${st.x},${st.y}) 对不上`);
      }
    }
  }
  return errs;
}

/**
 * 左右换摞：给一个摞名，返回相邻的那一摞。
 * @param {number} dir  +1 下一摞 / -1 上一摞
 * @returns {object|null} 到头返回 null（不循环 —— 到头就是到头，靠回弹给反馈）
 */
export function neighborStack(board, stackName, dir) {
  const list = stacksOf(board);
  const i = list.findIndex((s) => s.name === stackName);
  if (i < 0) return null;
  return list[i + (dir > 0 ? 1 : -1)] || null;
}
