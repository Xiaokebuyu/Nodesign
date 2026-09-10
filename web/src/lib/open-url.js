/**
 * open-url.js —— 「这个地址该在哪儿打开」全站一处（2026-09-10）。
 *
 * 起因是站主报的白屏：agent 做完一个 web、起了个 dev server、把地址写进聊天正文，
 * 点一下整个应用就没了。桌面版只有一扇窗，普通 `<a href>` 的点击是**顶层导航** ——
 * 它把 SPA 换成了那个地址；地址上没东西（进程已经随服务端重启没了）就是一片白，
 * 因为 Electron 不带浏览器那套错误页。而那扇窗没有地址栏、没有后退、关掉只是收进
 * 托盘，于是只能重启应用。壳那边的 setWindowOpenHandler 拦不住这种点击：它只接管
 * window.open / target=_blank，顶层导航不经过它。
 *
 * 所以规矩是：**要离开这个 SPA 的地址，一律不在本窗口开。**
 *   桌面版 → 走 preload 的桥交给系统浏览器（有地址栏、有后退，dev server 本来就该在那儿看）
 *   网页版 → 新标签页
 *
 * 页内锚点（`#…`）不归这里管 —— 那是目录跳转不是离开，调用方保留默认行为。
 */

/** 相对地址按当前页面补全成绝对地址；补不出来（怪协议之类）返回 null */
export function toAbsoluteUrl(href, base) {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, base || (typeof location !== 'undefined' ? location.href : undefined)).href;
  } catch { return null; }
}

/**
 * 在窗口之外打开一个地址。桌面壳的桥只收 http(s)（主进程再校验一遍），
 * 别的协议（mailto: 之类）落到 window.open，由壳的 setWindowOpenHandler 交给系统。
 */
export function openUrl(href, base) {
  const url = toAbsoluteUrl(href, base) || String(href ?? '').trim();
  if (!url || typeof window === 'undefined') return;
  const desktop = window.nodesignDesktop;
  if (desktop?.openExternal) {
    desktop.openExternal(url).catch(() => window.open(url, '_blank', 'noopener'));
    return;
  }
  window.open(url, '_blank', 'noopener');
}
