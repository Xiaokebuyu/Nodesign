/**
 * 画布相机 —— 无限画布的坐标与约束数学（2026-08-07）
 *
 * ## 为什么现在做
 *
 * 2026-07-28「桌面化」把 zoom / 二维 pan / clampPan / minZoom / 相机 rAF 全删了，
 * 换成 `DESKTOP_W=1360` 定宽 + 纵向普通滚动，理由是跨端坐标稳定。那个决定在
 * 「画布只占右半屏」的年代是对的。
 *
 * 08-07 外壳改成**画布全屏 + 聊天栏浮在其上**之后它就不成立了：实测 1600 视口下
 * 聊天窗压住画布右边 160px，而画布只能纵向滚，**被压住的部分永远拿不出来**。
 * 浮层面板这套之所以在 Figma / tldraw 里成立，是因为底下的东西永远能平移出来。
 * 所以「无限画布」不是锦上添花，是全屏浮窗的前置条件。
 *
 * ## 坐标约定
 *
 *   screen = (world + cam) * cam.z
 *   world  = screen / cam.z - cam
 *
 * `cam.x / cam.y` 是**加在世界坐标上的偏移**（不是"镜头在哪"），跟 tldraw 一致。
 * 这个约定的好处是缩放公式里不出现减法嵌套，边界推导短一截。
 *
 * ## 约束模型
 *
 * 抄的是 tldraw `TLCameraConstraints` 的**思路**（不是代码，它是专有许可证）：
 * 每根轴先算一个「自然缩放」= 内容正好填满视口时的 z，然后按 behavior 决定
 * 低于/高于它时怎么办。我们只需要其中两种：
 *
 * - `contain`（默认）：z 低于自然缩放时按 origin 停靠（= 现在这种规规矩矩的
 *   桌面感），高于时把内容夹在视口内可自由平移（= 无限画布感）。
 *   **一个参数横跨两种形态，不用在「桌面」和「无限」之间二选一。**
 * - `free`：完全不管，能一直平移到虚空里去。
 *
 * 默认给 `contain` 而不是 `free`，因为 `free` 意味着**用户能把画布拖进一片
 * 什么都没有的地方然后找不回来**。我们的边界不是内容外沿，是内容外沿再放宽
 * 一整屏（`ROAM_MARGIN`）—— 那一圈空地就是给涂鸦和批注用的"画布外延"，
 * 够自由，但走不丢。
 */

/** 可缩放的档位。第一个和最后一个即 min / max。 */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];

export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * 内容外沿再放宽多少（世界单位）才是可平移边界。
 * 一整屏左右的余量：既够在产物旁边空地上写字画线，又不会拖到迷路。
 */
export const ROAM_MARGIN = 800;

/**
 * 视口内边距（屏幕像素）。内容不贴着边，也给浮层留点余地。
 *
 * ⚠️ 注意 `naturalZoom` 里 x 方向的 padding 是拿 `viewport.w` 夹的、y 拿
 * `viewport.h` —— **参考实现那边这两个是反的**（px 夹 vsb.h/2、py 夹 vsb.w/2，
 * 疑似上游笔误）。将来谁对着 tldraw 逐行比对，别把这里"改回去"。
 */
export const CAMERA_PADDING = { x: 24, y: 24 };

/**
 * 内容停靠位置（0~1）。x:0.5 = 水平居中（跟改造前 `margin:0 auto` 一致），
 * y:0 = 顶部对齐（内容比视口矮时贴顶，不要垂直居中 —— 桌面是从上往下长的）。
 */
export const CAMERA_ORIGIN = { x: 0.5, y: 0 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const IDENTITY_CAMERA = { x: 0, y: 0, z: 1 };

// ── 坐标换算 ──────────────────────────────────────────────────────────

export function worldToScreen(pt, cam) {
  return { x: (pt.x + cam.x) * cam.z, y: (pt.y + cam.y) * cam.z };
}

export function screenToWorld(pt, cam) {
  return { x: pt.x / cam.z - cam.x, y: pt.y / cam.z - cam.y };
}

/** 屏幕上的长度换成世界长度（拖拽位移要用这个，不然缩放后跟手感是错的）。 */
export function screenDeltaToWorld(d, cam) {
  return { x: d.x / cam.z, y: d.y / cam.z };
}

// ── 矩形工具 ──────────────────────────────────────────────────────────

export function boxUnion(boxes) {
  // 四个字段都要查。只查 w/h 会让坏掉的 x 穿过去，而**坏的偏偏最常是坐标**
  // （board.json 里持久化的布局）。一个 NaN 进来，union 出 NaN、相机变 NaN、
  // 所有元素的 transform 变 NaN → 整块画布白屏，而且不会自愈。
  const list = boxes.filter(b => b
    && Number.isFinite(b.x) && Number.isFinite(b.y)
    && Number.isFinite(b.w) && Number.isFinite(b.h));
  if (!list.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const b of list) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function boxExpand(b, m) {
  return { x: b.x - m, y: b.y - m, w: b.w + m * 2, h: b.h + m * 2 };
}

// ── 约束 ──────────────────────────────────────────────────────────────

/**
 * 每根轴的「自然缩放」：内容（含内边距）正好填满视口时的 z。
 * 低于它 = 内容装得下还有富余，高于它 = 内容比视口大。
 */
export function naturalZoom(bounds, viewport, padding = CAMERA_PADDING) {
  const px = Math.min(padding.x, viewport.w / 2);
  const py = Math.min(padding.y, viewport.h / 2);
  // 退化轴（宽或高为 0）兜底 **Infinity 不是 1**。
  //
  // 兜 1 会出事：`contain` 的不变量是「`free > 0` 等价于 `z < zFit`」，所以
  // `clamp(v, minV + free, minV)` 那个 lo > hi 的分支本该不可达。但 zx 兜成 1
  // 之后，`freeW = (viewport.w - 2px)/z` 恒为正，`z ≥ 1` 就带着正的 free 撞进
  // clamp —— 而 `Math.min(hi, Math.max(lo, v))` 在 lo > hi 时**恒返回 hi**，
  // 跟请求值无关，相机被钉死。实测 w=0、视口 1000×800：z=0.999 时内容点在
  // 屏幕 x=500，z=1.000 时跳到 24，**一个像素的缩放变化导致 476px 跳变**。
  // 兜 Infinity 则 `z < Infinity` 恒真 → 退化轴永远走 origin 停靠，不跳、
  // 且 lo > hi 恢复不可达（不用再去改 applyAxis）。
  return {
    zx: bounds.w > 0 ? (viewport.w - px * 2) / bounds.w : Infinity,
    zy: bounds.h > 0 ? (viewport.h - py * 2) / bounds.h : Infinity,
  };
}

/**
 * 缩放被夹住时保持焦点不动。
 *
 * 用户在光标处滚轮放大，请求的 z 越了上限被夹回来 —— 这时如果只夹 z 不动 x/y，
 * 画面会**朝视口中心跳一下**。这个插值把"光标底下那个点"继续钉在原地。
 * （tldraw 里叫 preserveFocalPoint，是个容易漏掉但一漏就很难受的细节。）
 */
function preserveFocal(current, requested, requestedZ, clampedZ, currentZ) {
  // 请求的 z 跟当前一样 → 这次根本不是缩放，是纯平移。**返回 requested 不是
  // current**：这条分支只在「当前相机本身越界」时才可达（比如持久化下来的
  // 相机遇上后来变小的档位），请求里没有任何焦点信息可还原，老老实实保住
  // 用户的平移，比把它整个吃掉强。原来返回 current 会让那一帧的拖拽白拖。
  if (requestedZ === currentZ) return requested;
  const denom = 1 / requestedZ - 1 / currentZ;
  // 守的是**非有限**不是等于零。真正的事故是 currentZ=0 时
  // `1/0 - 1/z = Infinity`，分子也是 ±Infinity，相除得 NaN —— 原来那个
  // `denom === 0` 守卫压根罩不住它，守错了地方。
  if (!Number.isFinite(denom)) return requested;
  return current + ((requested - current) * (1 / clampedZ - 1 / currentZ)) / denom;
}

/**
 * 把一个「想去的」相机位置夹进合法范围。
 *
 * @param next    请求的相机 {x,y,z}
 * @param current 当前相机（只在 z 被夹时用来保持焦点）
 * @param opts    { bounds, viewport, padding, origin, behavior, zoomMin, zoomMax }
 */
export function constrainCamera(next, current, opts) {
  const {
    bounds, viewport,
    padding = CAMERA_PADDING,
    origin = CAMERA_ORIGIN,
    behavior = 'contain',
    zoomMin = ZOOM_MIN,
    zoomMax = ZOOM_MAX,
  } = opts || {};

  // z 缺省 = 保持当前缩放。纯平移的调用方（拖背景、滚轮平移）自然只想给 x/y，
  // 少拼一个字段就返回一整套 NaN 是个坏接口。
  let { x, y } = next;
  let z = next.z ?? current?.z ?? 1;

  // 先夹 z，夹住了就把焦点补回来
  if (z < zoomMin || z > zoomMax) {
    const rz = z;
    z = clamp(z, zoomMin, zoomMax);
    x = preserveFocal(current.x, x, rz, z, current.z);
    y = preserveFocal(current.y, y, rz, z, current.z);
  }

  if (!bounds || !viewport || viewport.w <= 0 || viewport.h <= 0) return { x, y, z };

  // behavior 可以是一个字符串（两轴同规则）或 {x, y}（两轴各来各的）
  const bx = typeof behavior === 'string' ? behavior : behavior.x;
  const by = typeof behavior === 'string' ? behavior : behavior.y;

  const px = Math.min(padding.x, viewport.w / 2);
  const py = Math.min(padding.y, viewport.h / 2);
  const { zx, zy } = naturalZoom(bounds, viewport, padding);

  // 可用空地：内容之外还剩多少世界单位没被视口占住
  const minX = px / z - bounds.x;
  const minY = py / z - bounds.y;
  const freeW = (viewport.w - px * 2) / z - bounds.w;
  const freeH = (viewport.h - py * 2) / z - bounds.h;
  const originX = minX + freeW * origin.x;
  const originY = minY + freeH * origin.y;

  x = applyAxis(bx, x, z, zx, originX, minX, freeW);
  y = applyAxis(by, y, z, zy, originY, minY, freeH);

  return { x, y, z };
}

function applyAxis(behavior, v, z, zFit, originV, minV, free) {
  switch (behavior) {
    case 'free':
      return v;
    case 'fixed':
      return originV;
    case 'contain':
    default:
      // 装得下 → 按 origin 停靠（桌面感）；装不下 → 夹在内容边界内（无限画布感）
      return z < zFit ? originV : clamp(v, minV + free, minV);
  }
}

// ── 常用动作 ──────────────────────────────────────────────────────────

/** 在屏幕某点上缩放，保持该点底下的世界坐标不动。 */
export function zoomAtScreenPoint(cam, screenPt, nextZ) {
  const w = screenToWorld(screenPt, cam);
  return { z: nextZ, x: screenPt.x / nextZ - w.x, y: screenPt.y / nextZ - w.y };
}

/** 下一档 / 上一档缩放（工具栏 +/- 用）。 */
export function stepZoom(z, dir, steps = ZOOM_STEPS) {
  if (dir > 0) return steps.find(s => s > z + 1e-6) ?? steps[steps.length - 1];
  const smaller = steps.filter(s => s < z - 1e-6);
  return smaller.length ? smaller[smaller.length - 1] : steps[0];
}

/** 让一块矩形正好入镜（「回到内容」/ 聚焦某个工作区都用它）。 */
export function fitBox(box, viewport, opts = {}) {
  const {
    padding = CAMERA_PADDING,
    zoomMin = ZOOM_MIN, zoomMax = ZOOM_MAX,
    maxZoom = 1,   // 别把一张小卡片放到 3 倍去，最多原大
    /**
     * 定缩放看哪几根轴（2026-08-28 移动端第二轮）。
     *   'both' 两轴都装得下（桌面「全部内容入镜」要的）
     *   'x'    **只按宽度取景**，高度溢出就溢出
     *
     * ⭐ 差别随内容变高而张开（390x664 的手机屏，一块 450 宽的板书）：
     * 高 150 时两者 0.76 / 0.82 几乎一样，高 1800 时是 0.34 / 0.82 —— 16px 正文
     * 5.5px vs 13px。手机上读长内容的天然姿势就是**竖着滚**，不是把整块缩到
     * 能一眼看全，后者看着"完整"，实际什么都读不了。配 alignY:'top' 用。
     */
    axis = 'both',
    /** 纵向落位：'center' 居中 / 'top' 顶对齐（按宽取景时要从这块的开头读起） */
    alignY = 'center',
  } = opts;
  if (!box || !viewport || viewport.w <= 0 || viewport.h <= 0) return { ...IDENTITY_CAMERA };
  if (!(box.w > 0) && !(box.h > 0)) return { ...IDENTITY_CAMERA };
  const px = Math.min(padding.x, viewport.w / 2);
  const py = Math.min(padding.y, viewport.h / 2);
  // 单边为 0 的矩形是真会出现的（只有一行物件时 union 出来就是一条横线），
  // 那一轴不参与定缩放（取 Infinity 让 Math.min 忽略它），另一轴照常 fit。
  const zFitX = box.w > 0 ? (viewport.w - px * 2) / box.w : Infinity;
  const zFitY = box.h > 0 ? (viewport.h - py * 2) / box.h : Infinity;
  const z = clamp(Math.min(zFitX, axis === 'x' ? Infinity : zFitY, maxZoom), zoomMin, zoomMax);
  // 居中：世界中心落到视口中心；顶对齐：这块的上沿落到视口上沿 + 内边距
  return {
    z,
    x: viewport.w / 2 / z - (box.x + box.w / 2),
    y: alignY === 'top' ? py / z - box.y : viewport.h / 2 / z - (box.y + box.h / 2),
  };
}

/** 当前视口在世界坐标里覆盖的矩形（剔除不可见物件时用）。 */
export function viewportWorldBox(cam, viewport) {
  const tl = screenToWorld({ x: 0, y: 0 }, cam);
  const br = screenToWorld({ x: viewport.w, y: viewport.h }, cam);
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}
