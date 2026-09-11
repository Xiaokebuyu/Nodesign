import { PAPER } from './paper.js';
import { CANVAS } from './theme.js';

/**
 * 关系线的视觉映射 —— 每种语义长什么样。
 *
 * 语义**真相在服务端** `server/lib/binding-types.js`（它是校验方）。这里只管
 * "画成什么"。两份表的 id 必须一一对应，`board-bindings.test.js` 有 parity
 * 断言看着 —— 加了语义忘了给视觉、或者反过来，测试直接红。
 *
 * ## 五种线怎么区分
 *
 * 靠**线型 + 端头**区分，不靠颜色。颜色留给状态（选中 / agent 刚画的 / 悬停），
 * 一旦拿颜色区分语义，状态就没有表达手段了，而且色弱用户读不出差别。
 *
 *   改自 derives-from  实线 + 实心箭头      版本谱系，最该被一眼看见 → 最重的线
 *   批注 annotates     细虚线 + 圆点        引线，不该抢戏 → 最轻的线
 *   接着 flow          实线 + 开口箭头      读序
 *   取材 ref           点线 + 开口箭头      跨任务引用，最弱的耦合 → 点线
 *   对照 contrast      实线 + 两端短横      无向，端头对称才读得出"并列"
 */

// 2026-08-14 加粗一档（用户点名"太不显眼"）：原版线宽 1~1.6 在缩小的镜头下
// 细得像卡片描边的毛刺。加粗保持相对秩序不变 —— 改自最重、批注最轻。
export const BINDING_STYLES = {
  'derives-from': {
    label: '改自',
    stroke: PAPER.ink,
    width: 2.4,
    dash: null,
    head: 'arrow',      // 终点实心箭头
    tail: null,
    /** 布局提示：这条线希望两端离多近（世界单位）。null = 不表态 */
    affinity: 260,
  },
  annotates: {
    label: '批注',
    stroke: PAPER.ink2,
    width: 1.4,
    dash: '3 4',
    head: 'dot',
    tail: null,
    affinity: 140,      // 批注要贴着被批注的东西
  },
  flow: {
    label: '接着',
    stroke: PAPER.ink2,
    width: 2,
    dash: null,
    head: 'arrow-open',
    tail: null,
    affinity: 300,
  },
  ref: {
    label: '取材',
    stroke: PAPER.pencil,
    width: 1.6,
    dash: '1 5',
    head: 'arrow-open',
    tail: null,
    affinity: null,     // 跨任务引用，不要求靠近
  },
  contrast: {
    label: '对照',
    stroke: CANVAS.brass,
    width: 2,
    dash: null,
    head: 'bar',
    tail: 'bar',        // 两端对称 = 无向
    affinity: 40,       // 唯一一条明确要求并排的关系，贴得最紧
  },
  link: {
    label: '关联',
    stroke: PAPER.ink2,
    width: 1.8,
    dash: null,
    head: 'dot',        // 两端对称小圆点 = 无向；纯素线会跟涂鸦笔画混淆
    tail: 'dot',
    affinity: 220,
  },
};

/** 悬停 / 选中时的强调色（状态用颜色，语义用线型） */
export const BINDING_ACCENT = CANVAS.brass;

export const BINDING_STYLE_IDS = Object.keys(BINDING_STYLES);

export function bindingStyle(type) {
  return BINDING_STYLES[type] || null;
}

/**
 * 一条线的两个端点：从各自矩形的**边界**出发，不是从中心。
 *
 * 从中心到中心画会让线穿过卡片本身，箭头也埋在卡片底下看不见。做法是取
 * 两个矩形中心的连线，各自求出它与自己矩形边框的交点。
 *
 * 返回 null 表示这条线画不出来（端点缺失 / 两个矩形重叠到中心重合）。
 */
export function edgePoints(a, b, gap = 6) {
  if (!a || !b) return null;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null;
  return {
    from: rectEdgePoint(a, ac, dx, dy, gap),
    to: rectEdgePoint(b, bc, -dx, -dy, gap),
  };
}

/**
 * 从矩形中心沿 (dx,dy) 方向走到矩形边框上的那个点，再往外让开 gap。
 *
 * 用的是「射线与轴对齐矩形求交」的标准解：分别算出射线撞到竖边和横边所需的
 * 参数 t，取小的那个（先撞到哪条边就是哪条）。比逐边求交短得多也没有分支坑。
 */
function rectEdgePoint(rect, center, dx, dy, gap) {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: center.x + dx * t + (dx / len) * gap,
    y: center.y + dy * t + (dy / len) * gap,
  };
}

/**
 * 两点之间的路径。用**二次贝塞尔**微微起拱，不用直线。
 *
 * 直线在多条线共端点时会叠成一坨分不开，而且横平竖直的直线跟卡片边框混在
 * 一起读不出是线还是描边。起拱量取两点距离的一个小比例（有上限），距离近的
 * 时候几乎是直线，远的时候拱起来，多条线自然分开。
 */
export function bindingPath(from, to, bow = 0.14, maxBow = 46) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(dist * bow, maxBow);
  // 法线方向偏移中点（法线 = 方向向量转 90°）
  const mx = (from.x + to.x) / 2 + (-dy / dist) * lift;
  const my = (from.y + to.y) / 2 + (dx / dist) * lift;
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
}

/** 曲线中点（挂标签用）。二次贝塞尔 t=0.5 的解析解。 */
export function bindingMidpoint(from, to, bow = 0.14, maxBow = 46) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(dist * bow, maxBow);
  const cx = (from.x + to.x) / 2 + (-dy / dist) * lift;
  const cy = (from.y + to.y) / 2 + (dx / dist) * lift;
  // B(0.5) = 0.25*P0 + 0.5*C + 0.25*P1
  return {
    x: 0.25 * from.x + 0.5 * cx + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * cy + 0.25 * to.y,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * 材质轴（2026-08-23 黑板）—— 与语义正交的第二个轴
 *
 * 语义类型管"这条线是什么意思"（label / 端头 / affinity），材质管"它是用什么
 * 画的"。整块画布是一张侦探板：版面线安静地用墨线归档，推理中的关系拿丝线
 * 和图钉压着，人顺手拉的一笔是铅笔。三种材质谁都能用（用户/agent 都可以
 * 选），缺省由语义给：存档里不写 material 就是 ink。
 *
 * 服务端 `server/lib/binding-types.js` 的 BINDING_MATERIALS 是校验方，两份 id
 * 必须一一对应（board-bindings.test.js 有 parity 断言）。
 * ──────────────────────────────────────────────────────────────────────── */

export const BINDING_MATERIALS = {
  ink:    { label: '墨线' },
  pencil: { label: '手绘' },
  yarn:   { label: '丝线', stroke: PAPER.red, width: 2.6 },
};
export const BINDING_MATERIAL_IDS = Object.keys(BINDING_MATERIALS);

export function materialOf(b) {
  return BINDING_MATERIALS[b?.material] ? b.material : 'ink';
}

/** 字符串 → 32 位种子（FNV-1a）。抖动要稳定：同一条线每次渲染抖在同一处 */
function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** mulberry32 —— 够用的确定性随机 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二次贝塞尔上取点 */
function qPoint(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/**
 * 手绘线：沿原本那条微拱的贝塞尔采样成折线，每个采样点沿法线抖一点。
 * 抖幅随线长微增但封顶（长线抖 1.6px 已经像手画了，再大就像心电图）。
 * 返回 { d, mid }。
 */
function pencilGeometry(from, to, seed, ctrl = null) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const lift = Math.min(dist * 0.14, 46);
  const c = ctrl || { x: (from.x + to.x) / 2 + (-dy / dist) * lift, y: (from.y + to.y) / 2 + (dx / dist) * lift };
  const nx = -dy / dist; const ny = dx / dist;
  const rand = rng(seed);
  const segs = Math.max(6, Math.min(28, Math.round(dist / 22)));
  const amp = Math.min(1.6, 0.6 + dist / 400);
  const pts = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const p = qPoint(from, c, to, t);
    // 两端不抖：端头要贴着卡边
    const w = (i === 0 || i === segs) ? 0 : amp * (rand() * 2 - 1);
    pts.push({ x: p.x + nx * w, y: p.y + ny * w });
  }
  // 用 Catmull-Rom 转三次贝塞尔让折线圆滑一点，不然像锯齿
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
  }
  return { d, mid: qPoint(from, c, to, 0.5) };
}

/**
 * 丝线：两颗图钉之间绷着的线会往下垂（重力朝 +y，不管两点怎么摆）。
 * 垂度取线长的一个小比例并封顶；近乎竖直的线几乎不垂（绷直了）。
 */
function yarnGeometry(from, to, ctrl = null) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const horiz = Math.abs(dx) / dist;          // 越横越垂
  const sag = Math.min(dist * 0.11, 56) * (0.25 + 0.75 * horiz);
  const c = ctrl || { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + sag };
  return { d: `M ${from.x} ${from.y} Q ${c.x} ${c.y} ${to.x} ${to.y}`, mid: qPoint(from, c, to, 0.5) };
}

/**
 * 一条线的几何 —— 按材质派发。ink 走原来的 bindingPath/bindingMidpoint。
 * @returns {{ d: string, mid: {x:number,y:number} }}
 */
export function bindingGeometry(from, to, material, seedKey = '', ctrl = null) {
  // ctrl：绕开中间卡片的控制点（09-11，lib/line-route.js 的 routeLine 算）；不给就是各材质原来的样子
  if (material === 'pencil') return pencilGeometry(from, to, hashSeed(seedKey), ctrl);
  if (material === 'yarn') return yarnGeometry(from, to, ctrl);
  if (ctrl) return { d: `M ${from.x} ${from.y} Q ${ctrl.x} ${ctrl.y} ${to.x} ${to.y}`, mid: qPoint(from, ctrl, to, 0.5) };
  return { d: bindingPath(from, to), mid: bindingMidpoint(from, to) };
}
