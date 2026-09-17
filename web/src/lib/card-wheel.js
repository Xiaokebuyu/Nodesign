/**
 * card-wheel —— 画布上活预览卡的滚轮归属（2026-09-17，问题库 iss_mtuhruna_yg6c）
 *
 * ## 病
 *
 * 08-14 起站点卡把滚轮转发进 iframe：先 stopPropagation + preventDefault 拦住相机，
 * 再 `contentWindow.scrollBy`。这对「文档本身在滚」的普通站点成立。09-05 演出卡
 * （664f54aa）照抄了 `wheel:'iframe'`，但演出显示器的文档根本不滚 ——
 * `html,body{height:100%}` + `body{overflow:hidden}`，真正的滚动容器是 `.beats` /
 * `.opening` / `.page.scroll` / `.cast-scroll`。于是 `window.scrollBy` 什么也没动，
 * 事件又已经被吞，画布也不平移：卡片上转滚轮两头都没反应，只剩 Ctrl+滚轮能到相机。
 * 站点卡也有同一个缺口的轻症：短页（没有可滚的）或滚到底之后，滚轮照样被吞。
 *
 * ## 法
 *
 * 照浏览器自己的滚动链找目标：取指针在 iframe 文档里的命中元素，沿祖先往上找
 * **这一下方向上还滚得动的**第一个滚动容器，最后才轮到视口。
 *   - 找到 → 吞事件、滚它。
 *   - 找不到（没有可滚的 / 已经滚到头 / 跨源看不见里面）→ 不碰事件，相机照常平移。
 *   - 例外：同一串滚轮刚刚还在卡里滚（WHEEL_LATCH_MS 内），滚到头后的尾巴继续吞掉
 *     但不滚。触控板惯性和连续拨滚轮会在到底的那一刻整串溢出去平移画布，
 *     卡片从指针底下滑走 —— 浏览器对嵌套滚动也是这样锁定在一个目标上的。
 *   - Ctrl/⌘ 放行（缩放手势归相机）；Shift 放行（画布约定 Shift+滚轮是左右平移，
 *     见 canvas-shortcuts.js）。
 *
 * 判定全部是纯函数，元素只读 scrollTop / scrollHeight / clientHeight / parentElement，
 * 样式经 `win.getComputedStyle` 取 —— 单测用假对象即可覆盖（card-wheel.test.js）。
 */

/**
 * 锁定窗口：上一次在卡里吞掉滚轮之后这么久之内，到头也不放给相机。
 * 取值是经验值不是浏览器常量：要长过连续拨轮 / 惯性事件的间隔（几十毫秒量级），
 * 又要短到用户停手再滚时能立刻平移画布。
 */
export const WHEEL_LATCH_MS = 300;

/** 这几种 overflow 才是用户能滚的容器（hidden / clip 只能由脚本滚，滚轮不该进去） */
const USER_SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);

/** 在 dy 方向上还有没有余量。1px 容差：缩放下 scrollTop 常是小数，到底时差个零点几 */
export function hasRoomY(el, dy) {
  if (!el || !dy) return false;
  const max = (el.scrollHeight || 0) - (el.clientHeight || 0);
  if (max <= 1) return false;
  const top = el.scrollTop || 0;
  return dy > 0 ? top < max - 1 : top >= 1;
}

function overflowYOf(win, el) {
  try { return win.getComputedStyle(el)?.overflowY || 'visible'; } catch { return 'visible'; }
}

/**
 * 视口能不能被滚轮滚。CSS 规则：根元素 overflow 是 visible 时，body 的 overflow
 * 传播给视口（演出显示器就是 body{overflow:hidden} 这样关掉了文档滚动）。
 */
function viewportScrollable(doc, win) {
  let ov = overflowYOf(win, doc.documentElement);
  if (ov === 'visible' && doc.body) ov = overflowYOf(win, doc.body);
  return ov !== 'hidden' && ov !== 'clip';
}

/**
 * 从命中点出发找这一下滚轮该滚的元素；没有就返回 null。
 * @param {Document} doc  iframe 的文档（同源才拿得到）
 * @param {number|undefined} x  iframe 文档坐标；拿不到命中点时只看视口
 * @param {number|undefined} y
 * @param {number} dy  WheelEvent.deltaY
 */
export function findWheelScroller(doc, x, y, dy) {
  if (!doc || !dy) return null;
  const win = doc.defaultView;
  if (!win) return null;
  const vp = doc.scrollingElement || doc.documentElement;
  // body 的 overflow 被传播给视口时，body 自己不是滚动容器（computed 值仍写着 auto，
  // 不跳过就会把事件吞给一个滚不动的 body）
  const bodyPropagates = !!doc.body && overflowYOf(win, doc.documentElement) === 'visible';
  let el = null;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    try { el = doc.elementFromPoint?.(x, y) || null; } catch { el = null; }
  }
  for (; el && el !== vp; el = el.parentElement) {
    if (el === doc.body && bodyPropagates) continue;
    if (USER_SCROLLABLE.has(overflowYOf(win, el)) && hasRoomY(el, dy)) return el;
  }
  if (vp && viewportScrollable(doc, win) && hasRoomY(vp, dy)) return vp;
  return null;
}

/**
 * 父文档里的指针坐标 → iframe 文档坐标。卡片 iframe 叠着两层缩放（卡内等比缩 +
 * 画布相机），getBoundingClientRect 两层都算进去了，offsetWidth 是布局尺寸没算，
 * 两者一比就是总倍率。
 */
export function framePoint(frame, clientX, clientY) {
  const r = frame?.getBoundingClientRect?.();
  if (!r || !r.width || !r.height) return null;
  return {
    x: (clientX - r.left) * (frame.offsetWidth / r.width),
    y: (clientY - r.top) * (frame.offsetHeight / r.height),
  };
}

/** 卡片 iframe 里这一下滚轮的目标；跨源 / 没挂上 / 滚不动都是 null */
export function wheelTargetInFrame(frame, e) {
  let doc = null;
  try { doc = frame?.contentDocument || null; } catch { doc = null; }
  if (!doc) return null;
  const pt = framePoint(frame, e.clientX, e.clientY);
  return findWheelScroller(doc, pt?.x, pt?.y, e.deltaY);
}

/**
 * 这一下滚轮怎么处置。
 * @returns {'pass'|'scroll'|'hold'}
 *   pass   不碰事件，冒泡给相机（平移 / 缩放）
 *   scroll 吞掉事件并滚 target
 *   hold   吞掉事件但不滚：同一串滚轮刚在卡里滚到头，尾巴不许溢出去平移画布
 */
export function decideCardWheel({ ctrlKey, metaKey, shiftKey, deltaY, target, now, lastConsumedAt }) {
  if (ctrlKey || metaKey || shiftKey) return 'pass';
  if (target) return 'scroll';
  if (deltaY && lastConsumedAt != null && now - lastConsumedAt < WHEEL_LATCH_MS) return 'hold';
  return 'pass';
}

/** 滚一下。有 scrollBy 就用它（跟 08-14 的 window.scrollBy 一样尊重页面的 scroll-behavior） */
export function scrollTargetBy(el, dy) {
  if (typeof el.scrollBy === 'function') el.scrollBy(0, dy);
  else el.scrollTop += dy;
}
