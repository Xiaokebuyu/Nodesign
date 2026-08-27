/**
 * 点选操作条的落位 + 几何点选（2026-08-27 桌面交互重制）—— 纯函数，别进 React。
 *
 * ## 为什么点选走几何不走 DOM
 *
 * 画布的指针事件在捕获下会被重定向（平移层 setPointerCapture 后 click/dblclick
 * 落到公共祖先 —— 08-25 板书武装案实锤），闲置板书又被 board-hit 归成空地。
 * 所以「点了哪件东西」只能拿世界坐标对矩形算，DOM 的 target 不可信。
 * 几何命中顺带把**叠堆下翻**白送了：一摞卡片点第一下选最上面的，再点同一处
 * 循环翻到底下那件 —— DOM 永远只给你最上面的那个。
 *
 * ## 落位的降级链（用户 2026-08-27 拍板：挤在一块也要出得来）
 *
 *   四周三圈找空位（下 → 上 → 右 → 左，一圈不行往外扩，远了调用方画引线）
 *   → 全满则降级成屏幕锚定的 HUD（贴视口下缘，永不消失 —— 跟精灵候场兜底
 *   同一条规矩：屏幕边缘永远有地方）。
 */

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * 给操作条找落点。全部屏幕（视口）坐标。
 * @param {{x,y,w,h}} target   被选中物件的屏幕矩形
 * @param {{w,h}} bar          操作条尺寸
 * @param {{w,h}} viewport     视口尺寸
 * @param {Array<{x,y,w,h}>} obstacles  要避开的东西（其他物件/精灵，不含 target）
 * @returns {{mode:'world',x,y,detached:boolean} | {mode:'hud'}}
 */
export function placeBar({ target, bar, viewport, obstacles = [], gap = 8, margin = 8 }) {
  if (!viewport || bar.w + margin * 2 > viewport.w || bar.h + margin * 2 > viewport.h) {
    return { mode: 'hud' };
  }
  // target 外扩一圈：贴得太近会盖住选中描边
  const t = { x: target.x - 4, y: target.y - 4, w: target.w + 8, h: target.h + 8 };
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const xs = [
    target.x + target.w / 2 - bar.w / 2,   // 居中
    target.x,                              // 左对齐
    target.x + target.w - bar.w,           // 右对齐
  ];
  const ys = [
    target.y + target.h / 2 - bar.h / 2,
    target.y,
    target.y + target.h - bar.h,
  ];
  for (const d of [gap, 56, 112]) {
    const candidates = [
      ...xs.map((x) => ({ x, y: target.y + target.h + d })),   // 下（用户点名的首选）
      ...xs.map((x) => ({ x, y: target.y - d - bar.h })),      // 上
      ...ys.map((y) => ({ x: target.x + target.w + d, y })),   // 右
      ...ys.map((y) => ({ x: target.x - d - bar.w, y })),      // 左
    ];
    for (const c of candidates) {
      const r = {
        x: clamp(c.x, margin, viewport.w - bar.w - margin),
        y: clamp(c.y, margin, viewport.h - bar.h - margin),
        w: bar.w, h: bar.h,
      };
      // 夹回视口后可能被推到 target 身上（比如卡贴着视口下沿时「下」被夹上来）
      // —— 压住 target 或压住别人都不算数，落到下一个候选
      if (overlaps(r, t)) continue;
      if (obstacles.some((o) => overlaps(r, o))) continue;
      return { mode: 'world', x: r.x, y: r.y, detached: d > gap };
    }
  }
  return { mode: 'hud' };
}

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
