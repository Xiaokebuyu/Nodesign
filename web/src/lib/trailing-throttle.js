/**
 * 尾沿节流：窗口内头一条立刻放行，其余合成窗口末尾一条。
 * 用于高频扳机（run.browser_opened 每次换页一条）触发的全量重拉。
 */
export function trailingThrottle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); fn(); return; }
    if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
  };
}
