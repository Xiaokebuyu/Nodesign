# 固定画幅页面的缩放骨架（海报 / 笔记图 / 歌词页 / 演示）

**照抄这一份，不要自己改写外层结构。** 画幅像素不变，整块按视口等比缩放，居中，四周留 letterbox。

```html
<div class="deck">
  <section class="slot"><div class="artboard"> …第 1 屏… </div></section>
  <section class="slot"><div class="artboard"> …第 2 屏… </div></section>
</div>
```

```css
html, body { margin: 0; height: 100%; background: #1b221e; }   /* letterbox 色，取作品的深底色 */
.deck { height: 100vh; overflow-y: auto; scroll-snap-type: y mandatory; }
.slot {
  width: 100vw; height: 100vh;
  display: flex; align-items: center; justify-content: center;   /* ⛔ 必须是 flex，不能是 grid */
  overflow: hidden; scroll-snap-align: start;
}
.artboard {
  flex: none;
  width: 1920px; height: 1080px;          /* 画幅：演示 1920×1080，海报 1080×1440，竖版 1080×1920 */
  transform: scale(var(--s, 1)); transform-origin: center center;
  position: relative; overflow: hidden;
}
```

```js
const W = 1920, H = 1080;   // 跟 .artboard 的宽高一致
const fit = () => document.documentElement.style.setProperty('--s', Math.min(innerWidth / W, innerHeight / H));
fit(); addEventListener('resize', fit);
```

只有一屏的海报，去掉 `.deck` 和 scroll-snap，保留一个 `.slot` 即可。

## 为什么外层不能用 grid

`transform: scale()` 只改画出来的样子，**不改元素占的布局尺寸**。1920 宽的画板放进 grid，
自动列宽会被撑到 1920，`place-items: center` 是在这条 1920 宽的列里居中；再以这个盒子的中心缩放，
窗口一窄画面就偏到一边、还会被裁掉。flex 的居中对超出容器的元素也按中心对齐，缩放后正好落在正中。

2026-09-11 实测（grid 写法）：窗口 1100×700 时画板偏右 410px、偏下 190px 并被裁切；只有窗口恰好等于画幅时才正常。
站点预览窗和全屏的宽高都不等于画幅，所以两处都会出问题。

## 自检

做完用 `screenshot_canvas` 在两种宽度下各看一次（例如站点预览窗和全屏），画板都应居中、完整、四周留边。
