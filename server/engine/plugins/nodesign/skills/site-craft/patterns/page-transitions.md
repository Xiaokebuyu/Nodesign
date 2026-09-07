# 页面转场与客户端路由

**动手写第一个转场之前看这一页。** 这不是"高级技巧"，是一个结构决定：
上了转场之后，页面脚本从"跑一遍"变成"跑很多遍"，而把单遍执行的脚本回头改成
可重入的，比一开始就分两段贵得多。

## 结构：boot / initPage / AbortController

```js
// script.js —— 任何打算上转场或路由的站从这个骨架起手
const ac = { current: null };

/** 只跑一次：全局的、跟具体页面无关的东西 */
function boot() {
  document.addEventListener('click', onLinkClick);   // 路由拦截，全局一份
  initPage();                                        // 首屏也要走一遍
}

/** 每次进入一个页面都跑：这一页的观察者、动效、交互 */
function initPage() {
  // ⭐ 上一页挂的 window / document 监听全部一次性摘掉。
  // 不摘的话翻十页就有十份 scroll 监听在跑，页面越用越卡，
  // 而且旧监听指着已经被替换掉的 DOM。
  ac.current?.abort();
  ac.current = new AbortController();
  const { signal } = ac.current;

  window.addEventListener('scroll', onScroll, { signal });
  window.addEventListener('resize', onResize, { signal });

  // IntersectionObserver 之类是页面级的，重新建
  const io = new IntersectionObserver(reveal, { threshold: 0.2 });
  document.querySelectorAll('.rv').forEach(el => io.observe(el));
  signal.addEventListener('abort', () => io.disconnect());
}

boot();
```

判据很简单：**这段代码在同一个 tab 里连续跑五次，行为要和跑第一次一样。**

## 路由本体

```js
async function onLinkClick(e) {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;        // 外链照常
  if (!/\.html?$/.test(url.pathname)) return;        // 只接站内页面

  e.preventDefault();
  const html = await fetch(url).then(r => r.text());
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.querySelector('main').replaceWith(doc.querySelector('main'));
  document.title = doc.title;
  history.pushState(null, '', url);
  window.scrollTo(0, 0);
  initPage();                                        // ⭐ 别忘了这一句
}
window.addEventListener('popstate', () => location.reload());  // 处理后退的最简可靠做法
```

## ⚠️ file:// 那道守卫要不要写

以前站点自检走 `file://`，`fetch` 必然被 CORS 拒，所以这类脚本里常见一条
「`location.protocol` 不是 http 就关掉路由、退回原生跳转」的守卫。

**现在 `screenshot_canvas` 已经走 http（跟用户预览同源），自检时路由是活的。**
但导出的 zip 用户在本地双击打开仍然是 `file://` —— 所以这条守卫**还是要写**，
它保护的是那个场景：

```js
const routerOk = location.protocol === 'http:' || location.protocol === 'https:';
if (routerOk) document.addEventListener('click', onLinkClick);
```

不写的话导出包里点任何链接都是白屏。

## 帘幕/遮罩转场的两个易错点

- **静止态要藏在视口外**（`position:fixed; inset:0; transform:translateY(100%)`），
  别用 `display:none` 切 —— 那样没有过渡可言
- ⚠️ **`fullPage` 截图会把它画在页面中段**：视口被撑成整页高，`translateY(100%)`
  就是往下推一整个展开视口。看起来像一大块盖住内容的色块，而它其实是正常的。
  要看它的真实位置用 `screenshot_canvas` 的 `scrollTo` 参数（真滚视口再抓一帧）
