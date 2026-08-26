import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import { useGlobalStore } from './stores/globalStore.js';
import './styles/globals.css';
import { lockZoom } from './lib/lock-zoom.js';

/**
 * 分片拉不动 → 自动刷一次（2026-08-03）
 *
 * 站点是构建产物直接被 nginx 托管的，`npm run build` 会清空 dist/assets 再写入，
 * 文件名带内容指纹。于是开着页面的人手里那份 index.js 记着的是**上一次构建**的
 * 分片名，重新部署之后那个文件已经不在磁盘上了 —— 懒加载（DeckWindow /
 * SiteWindow）到这一刻才去取，拿到 404，React Router 直接把整页换成崩溃页。
 * 而且浏览器会把这次失败的动态导入**记住不再重试**，光等是等不回来的。
 *
 * 部署侧已经改成「新分片加进去、旧分片留着」（见 scripts/deploy.sh），这里是
 * 第二道：真撞上了就重载，用户看到的只是闪一下而不是一张报错页。
 *
 * 只允许刷一次：sessionStorage 打标，刷完还失败就说明不是版本问题（网络断了、
 * 文件真丢了），这时候该让报错页出来，不能陷进无限重载。
 */
const RELOAD_FLAG = 'nd:chunk-reloaded';
function recoverFromStaleChunk(reason) {
  if (sessionStorage.getItem(RELOAD_FLAG)) return false;   // 已经刷过一次，放行报错
  sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  console.warn('[nd] 分片失效，重载一次：', reason);
  window.location.reload();
  return true;
}
// 进来就清标记：能跑到这一行说明这次的 index.js 是好的
window.addEventListener('load', () => {
  setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000);
});
// Vite 自己的预加载失败事件（<link rel=modulepreload> 那条路）
window.addEventListener('vite:preloadError', (e) => {
  if (recoverFromStaleChunk(e.payload?.message || 'preloadError')) e.preventDefault();
});
// lazy() 真正 import() 时失败走这条：Promise 被拒，冒到 unhandledrejection
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason?.message || e.reason || '');
  if (/dynamically imported module|Importing a module script failed|Failed to fetch/i.test(msg)) {
    if (recoverFromStaleChunk(msg)) e.preventDefault();
  }
});

// 手机上关掉整页缩放（桌面无效果，见 lib/lock-zoom.js）
lockZoom();

/**
 * 换语言 = 整棵树重挂（2026-08-26 i18n）
 *
 * `t()` 是模块级函数不是 hook（纯数据模块 canvas-menus / board-kinds 在 React 之外
 * 也要用它），所以 React 不知道它的返回值变了。靠"每个组件自己订阅 locale"是不行的
 * —— 126 个文件的纪律必然漏，而且漏了的表现是**半棵树还是旧语言**，很难发现。
 *
 * 用 key 强制重挂：一行覆盖全站，不需要任何组件配合。代价是切语言时丢组件内 state
 * （展开的面板、没提交的输入框）—— 换语言本来就是个罕见的、明确的动作，可以接受。
 */
function Root() {
  const locale = useGlobalStore((s) => s.locale);
  return (
    <AuthGate key={locale}>
      <App />
    </AuthGate>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
