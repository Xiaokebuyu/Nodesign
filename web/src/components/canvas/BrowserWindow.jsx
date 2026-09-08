import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ArrowLeft, RotateCw, Hand, Play, Loader2, Globe, PowerOff, FolderOpen, ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import { COLOR, CANVAS, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { INK_SURFACE } from '../../lib/paper.js';

/** 地址读数：百分号编码的中日文解回来给人看（tower.jp/search/item/%E7%9B… 没人读得了）；解不动就原样 */
function displayUrl(u) { try { return decodeURI(u); } catch { return u; } }
import ArtifactWindow from './ArtifactWindow.jsx';
import { Browse, Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * 桌面版画面走哪条路 —— **09-08 站主拍板改走 CDP 连续帧，这里关掉原生视图**。
 *
 * ## 为什么换
 *
 * 原生视图（Electron 的 `WebContentsView`）**永远画在所有 HTML 之上**，这是合成器
 * 架构不是配置项：它根本不在 DOM 里，任何 z-index 都够不着它。于是它会盖住 AI 侧边栏、
 * 盖住确认弹窗（用户点删除"没反应"其实是框被盖住了）、盖住右键菜单和浮动面板 ——
 * 每加一个浮层就得手动为它报一次矩形，是打地鼠。
 *
 * 换成 CDP 截图流之后：画面是个普通 `<canvas>`，老实吃 z-index，**网页版和桌面版
 * 并成同一条代码路径**，"只有桌面版有"的那一整类 bug 直接消失。
 *
 * 代价（localhost 抹不平的那部分）：JPEG 编解码的 CPU、负载下丢帧、输入要合成事件
 * 绕一圈。站主的判断是"都本地了，质量不会比原生差多少"。
 *
 * ## 为什么留成一个常量而不是删干净
 *
 * 有一个还没实测的未知数：**屏外停车（PARK）的视图会不会持续产帧**。
 * `Page.captureScreenshot`（单张）在 park 状态可用是已知的（`browser-host.cjs` 的
 * PARK 机制就是为它留的），但 `Page.startScreencast`（连续帧）对被遮挡/离屏的视图
 * 会不会被 chromium 节流，没在真 Windows 上量过。
 *
 * 万一不产帧 —— 把这个常量翻回 `true` 就退回原生视图，一行的事。别把这条路拆了。
 *
 * ## 09-08 晚：翻回 `true`（0.1.23 真机实报）
 *
 * 不是节流，比节流更早一步：视图停在屏外时**可见视口为空**，Chromium 对它的
 * `Page.captureScreenshot` 直接拒绝——桌面报的原话是
 * `Cannot take screenshot with 0 width`，agent 的 browser_screenshot / browser_computer
 * 五次全挂，画面流首帧也是这张截图，所以用户什么都看不到。0.1.21 之前每次截图时
 * 浏览器卡都开着、视图在屏内，从没撞过这条。
 *
 * 结论：**只要视图不在屏内就没有截图，而 CDP 路线的前提正是视图不在屏内**——这两条在
 * 原生视图上互斥。CDP 路线要成立得换成 Electron 的离屏渲染（`webPreferences.offscreen`），
 * 视图根本不挂进窗口、靠 OSR 自己产帧，那时才能把这个常量翻回 false。没在真机验之前别翻。
 */
const DESKTOP_NATIVE_VIEW = true;
/** 缩略图档的宽度上限 */
const THUMB_W = 480;
/** 原生视图四周那圈框的内边距（px）：视图是壳画的矩形，圆角和阴影都做不到它身上，只能画在它外面 */
const FRAME_PAD = 6;
/** 压在画布上、原生视图要让位的浮层：聊天卡（悬浮 / 固定都算）+ 任何标了 data-nd-overlay 的东西；隐藏的不算 */
function overlayRects() {
  const out = [];
  for (const el of document.querySelectorAll('[data-chat-card], [data-nd-overlay]')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  }
  return out;
}
const nativeView = () => (DESKTOP_NATIVE_VIEW && typeof window !== 'undefined' && window.nodesignDesktop?.browserView) || null;

/**
 * BrowserWindow —— 播放 agent 当前的浏览器画面，必要时你接手（2026-08-18）
 *
 * ## 它跟另外三扇窗的根本区别
 *
 * deck / 站点 / word 都是**产物**：落盘的文件、进 kinds 注册表。这扇窗背后
 * 不是文件，是一只**可能不在**的 chromium（空闲 5 分钟就回收）。所以它不进
 * kinds 注册表、没有导出、不能加入上下文。
 *
 * ⚠️ **这里原来写着「你不会想在桌面上永久摆着一张'某次浏览'的卡片」，
 * 用户 2026-08-18 拍反了**，而理由比我那句判断硬：agent 逛站这件事用户要能
 * **随时进去看、随时接手**。只由 `run.browser_opened` 事件开窗意味着"错过就没了"
 * —— 刷新一下、切个项目回来，这扇窗和它背后正等着人的 agent 就都找不见了。
 * 所以现在桌面上有一张 `browse` 卡（`lib/board-kinds.js` + `engine/browse/card.js`），
 * 双击它进这扇窗；没有活实例时下面那颗按钮把浏览器起回上次那一页。
 *
 * ## 它是「工具卡」的窗，所以装两样东西（2026-08-18 下午）
 *
 * 用户定的类别：「工具存放工具采集到的内容，**以及**可互动工具的显示」。所以这扇窗
 * 上半是**活的画面**（能接手操作），下半是**它采回来的东西**（按站分组，一站一
 * 文件夹 —— 存放格式按站点产物那条范式）。两样在一扇窗里，因为它们是同一件东西的
 * 两面：你逛完一个站顺手采下来，回头找的时候也是从"我在哪逛过"想起的。
 *
 * ## 画面怎么来
 *
 * 专用 WS `/ws/projects/:pid/browser`，**二进制帧**（JPEG）直接 `createImageBitmap`
 * 画到 canvas。不走主 WS：那条是纯下行 + EventBus 广播 + 2000 条重放缓冲，
 * 高频帧灌进去会冲爆重放缓冲、混进 hydrate 回放，而且 base64 + zlib 白压一遍。
 *
 * ⭐ **不看就不订阅**：窗关掉、或者浏览器标签切走（`document.hidden`）就发
 * unsubscribe，服务端立刻 `stopScreencast`。这不是省流量，是省那台 1 vCPU 机器的核。
 */

/** 接手时鼠标坐标要转成 0..1 的比例发给服务端 —— 它比我们清楚页面的设备像素 */
function relPos(canvasEl, evt) {
  const r = canvasEl.getBoundingClientRect();
  return {
    rx: Math.min(1, Math.max(0, (evt.clientX - r.left) / r.width)),
    ry: Math.min(1, Math.max(0, (evt.clientY - r.top) / r.height)),
  };
}

export default function BrowserWindow({ projectId, url, help, onClose, onToolbarGroups }) {
  const [status, setStatus] = useState('connecting');   // connecting|live|idle|error|closed
  const [note, setNote] = useState(null);
  const [addr, setAddr] = useState(url || '');
  const [takeover, setTakeover] = useState(false);
  const [gotFrame, setGotFrame] = useState(false);
  // 刷新后 hello 帧补回来的求助文案（prop 那份来自一次性事件，刷新即失传）
  const [liveHelp, setLiveHelp] = useState(null);
  const [opening, setOpening] = useState(false);
  // 采到的东西（按站分组）。跟画面同一个端点来的（`GET /browse` 就是那张卡的载荷）
  const [sites, setSites] = useState([]);
  const [openSite, setOpenSite] = useState(null);
  const [shelfOpen, setShelfOpen] = useState(true);
  /**
   * 画面尺寸档（09-08 站主：agent 一开浏览器就展开大屏怼脸，默认先给缩略图）。
   * 改走 CDP 之后这件事变得很便宜 —— 原生视图那套 16:9 硬契约
   * （`zoom = 矩形宽 / 1366`，agent 坐标要 1:1）没有了，画面就是张图，缩放随便。
   */
  const [expanded, setExpanded] = useState(false);
  const canvasRef = useRef(null);
  const hostRef = useRef(null);      // 共视：原生视图要摆的那块（16:9）
  const native = nativeView();
  const activeRun = useGlobalStore(s => s.activeRun);
  const agentBusy = !!activeRun && activeRun.pid === projectId;
  // 全局弹窗（confirm / prompt）开着时原生视图让位：它画在所有 HTML 之上，会把「确定删除？」整个盖住（09-08 站主实报）
  const overlayOpen = useGlobalStore(s => !!(s.confirmDialog || s.promptDialog));
  const wsRef = useRef(null);
  const takeoverRef = useRef(false);
  takeoverRef.current = takeover;
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current = overlayOpen;

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, []);

  /**
   * 用户主动把浏览器起回来（空闲回收之后走这条）。
   * 起完**重新订阅**：WS 还连着，但服务端那边当时 peek 是空的，得再问一次。
   */
  const openBrowser = useCallback(async () => {
    setOpening(true);
    setNote(null);
    try {
      const r = await Browse.open(projectId);
      setAddr(r.url || '');
      setStatus('connecting');
      send({ type: 'subscribe' });
    } catch (err) {
      // 常驻名额满了（503）是**要如实说**的一档：这台机器上限是硬的
      setStatus('error');
      setNote(err?.message || '打不开');
    } finally { setOpening(false); }
  }, [projectId, send]);

  // ── WS 生命周期 ──
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/projects/${encodeURIComponent(projectId)}/browser`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => { setStatus('connecting'); ws.send(JSON.stringify({ type: 'subscribe', native: !!nativeView() })); };
    ws.onclose = (e) => { setStatus(e.code === 4401 ? 'error' : 'closed'); if (e.code === 4401) setNote('没有权限'); };
    ws.onerror = () => setStatus('error');
    ws.onmessage = async (e) => {
      if (typeof e.data !== 'string') {
        // 二进制 = 一帧 JPEG
        const cv = canvasRef.current;
        if (!cv) return;
        try {
          const bmp = await createImageBitmap(new Blob([e.data], { type: 'image/jpeg' }));
          if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
          cv.getContext('2d')?.drawImage(bmp, 0, 0);
          bmp.close?.();
          setGotFrame(true);
          setStatus('live');
        } catch { /* 坏帧丢掉，下一帧就好 */ }
        return;
      }
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'subscribed') { setStatus('live'); if (msg.url) setAddr(msg.url); }
      // hello 带着「agent 是不是正举着手」—— 刷新后 banner 靠它回来（一次性事件已经过去了）
      if (msg.type === 'hello' && msg.help) setLiveHelp(msg.help);
      if (msg.type === 'released') setLiveHelp(null);
      if (msg.type === 'idle') { setStatus('idle'); setNote(msg.reason); }
      if (msg.type === 'error') { setStatus('error'); setNote(msg.reason); }
      if (msg.type === 'closed') { setStatus('closed'); setNote(msg.reason); }
      if (msg.type === 'url') setAddr(msg.url || '');
    };

    // ⭐ 切走标签页就退订：省的是服务器那颗核，不是流量
    const onVis = () => send({ type: document.hidden ? 'unsubscribe' : 'subscribe' });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      try { ws.send(JSON.stringify({ type: 'unsubscribe' })); } catch { /* */ }
      ws.close();
      wsRef.current = null;
    };
  }, [projectId, send]);

  useEffect(() => { if (url) setAddr(url); }, [url]);

  // 采集清单：进窗拉一次。**不跟着帧刷** —— 采集是低频动作（agent 主动调
  // browser_capture 才有），跟着画面刷等于每秒问一遍磁盘。
  useEffect(() => {
    let alive = true;
    Browse.state(projectId)
      .then(r => { if (alive) setSites(Array.isArray(r?.sites) ? r.sites : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  // ── 接手：鼠标/键盘 → WS ──
  useEffect(() => {
    if (!takeover) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const onClick = (e) => { e.preventDefault(); send({ type: 'input', kind: 'click', ...relPos(cv, e) }); };
    const onWheel = (e) => { e.preventDefault(); send({ type: 'input', kind: 'wheel', ...relPos(cv, e), dx: e.deltaX, dy: e.deltaY }); };
    const onKey = (e) => {
      // ⚠️ Phase 1 不接输入法：中文输入要按 composer 那套 isIme 判定处理，
      // 现在按下去只会把半成品拼音塞过去。要输中文请在自己浏览器里做。
      if (e.isComposing) return;
      if (e.key.length === 1) { e.preventDefault(); send({ type: 'input', kind: 'key', text: e.key }); return; }
      if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        send({ type: 'input', kind: 'key', key: e.key });
      }
    };
    cv.addEventListener('click', onClick);
    cv.addEventListener('wheel', onWheel, { passive: false });
    // ⚠️ **挂在画面上，不是 window 上**。挂 window 的话接手一开，用户自己的聊天
    // 输入框就打不出字了 —— 每一次击键都被 preventDefault 掉送进第三方页面。
    // canvas 拿得到键盘事件的前提是它可聚焦（tabIndex）+ 真的被聚焦，所以下面
    // 顺手 focus() 一下：接手时焦点本来就该在这块画面上。
    cv.addEventListener('keydown', onKey);
    cv.focus?.();
    return () => {
      cv.removeEventListener('click', onClick);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('keydown', onKey);
    };
  }, [takeover, send]);

  /**
   * 共视·摆位：把 hostRef 的矩形（页面 CSS px）报给壳，壳把原生视图钉在那儿；收窗就 place(null)（视图停到屏外，agent 照用）。
   *
   * 09-08 晚改成 **rAF 逐帧跟随**：侧边栏收放、顶栏出现、画布平移缩放这些位移大多没有事件
   * （ResizeObserver 只看尺寸不看位置，CSS transition 期间更是一个事件都没有），原来靠 1 秒一次的
   * 兜底轮询，视图会先留在原地再跳过去。现在每帧量一次矩形，**变了才发 IPC**，没变一个字节都不发；
   * 量一次 getBoundingClientRect 的开销可以忽略。
   */
  useEffect(() => {
    if (!native) return undefined;
    let raf = 0;
    let last = '';
    let lastShot = 0;
    let lastSent = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const el = hostRef.current;
      const wrap = el?.parentElement;
      if (!el || !wrap) return;
      if (overlayOpenRef.current) {   // 弹窗期间停到屏外，弹窗关了下一帧就回来
        if (last !== 'null') { last = 'null'; native.place(projectId, null).catch(() => {}); }
        return;
      }
      const box = wrap.parentElement?.getBoundingClientRect();
      if (!box) return;
      // 可用区 = 容器 减去 压在它上面的浮层（聊天卡 data-chat-card 是绝对定位的悬浮卡，不推挤画布）。
      // 原生视图画在所有 HTML 之上，不让位就把聊天卡盖住；让位 = 在剩下的空地里重新摆一块最大的 16:9，
      // zoom 跟着宽度走（壳里 zoom = 宽 / 1366），页面不重排只缩放，agent 的坐标契约不变。
      let free = { left: box.left + 8, right: box.right - 8, top: box.top + 8, bottom: box.bottom - 64 - 8 };
      for (const ob of overlayRects()) {
        if (ob.right <= free.left || ob.left >= free.right || ob.bottom <= free.top || ob.top >= free.bottom) continue;
        const cutLeft = ob.right - free.left;   // 浮层在左边时要让出的宽
        const cutRight = free.right - ob.left;  // 浮层在右边时要让出的宽
        if (cutLeft < cutRight) free = { ...free, left: ob.right + 8 }; else free = { ...free, right: ob.left - 8 };
      }
      const freeW = Math.max(0, free.right - free.left - FRAME_PAD * 2);
      const freeH = Math.max(0, free.bottom - free.top - FRAME_PAD * 2);
      const w = Math.floor(Math.max(0, Math.min(freeW, freeH * 16 / 9)));
      const h = Math.floor(w * 9 / 16);
      const ws = `${w}px`; const hs = `${h}px`;
      if (el.style.width !== ws) el.style.width = ws;
      if (el.style.height !== hs) el.style.height = hs;
      // 框居中在可用区里：容器本身是居中排版，用 transform 把差值补上（不改布局，不引发重排）
      const cur = wrap.getBoundingClientRect();
      const wantCx = (free.left + free.right) / 2; const wantCy = (free.top + free.bottom) / 2;
      const curCx = (cur.left + cur.right) / 2; const curCy = (cur.top + cur.bottom) / 2;
      const dx = Math.round((wantCx - curCx) + (parseFloat(wrap.dataset.dx || '0'))); const dy = Math.round((wantCy - curCy) + (parseFloat(wrap.dataset.dy || '0')));
      if (dx !== Number(wrap.dataset.dx || 0) || dy !== Number(wrap.dataset.dy || 0)) {
        wrap.dataset.dx = String(dx); wrap.dataset.dy = String(dy);
        wrap.style.transform = (dx || dy) ? `translate(${dx}px, ${dy}px)` : '';
      }
      const r = el.getBoundingClientRect();
      const rect = r.width > 8 && r.height > 8 ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null;
      const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'null';
      // 变了立刻发；没变也每秒补发一次 —— 壳那头 setZoomFactor 在页面没就绪时会静默不生效，补发是自愈的路
      if (key !== last || Date.now() - lastSent > 1000) { last = key; lastSent = Date.now(); native.place(projectId, rect).catch(() => {}); }
      // 画布上那张浏览器卡的缩略图靠 /browse/preview 现拍；视图停到屏外就拍不了（可见视口为空），
      // 所以趁它在屏内时每 8 秒刷一张，收窗前最后再刷一张
      if (rect && Date.now() - lastShot > 8000) { lastShot = Date.now(); Assets.preview(projectId).catch(() => {}); }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      Assets.preview(projectId).catch(() => {});
      setTimeout(() => native.place(projectId, null).catch(() => {}), 400);   // 先让最后一张缩略图拍完再停到屏外
    };
  }, [native, projectId]);
  /** 共视·打断即接手：回合在飞且没接手 = agent 在操作，盖遮罩；人先按停（或 agent 举手求助）才能接手 */
  useEffect(() => {
    if (!native) return undefined;
    const blocked = agentBusy && !takeover && !(help || liveHelp);
    native.block(projectId, blocked).catch(() => {});
    return undefined;
  }, [native, projectId, agentBusy, takeover, help, liveHelp]);

  const groups = useMemo(() => [
    // 地址是**读数不是输入框**：给人一个能敲 URL 的地方等于给一条绕过出网闸的
    // 错觉（闸在网络层照样拦，但不如不提供这个入口）。
    {
      id: 'addr',
      node: (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: `0 ${GAP.sm}px`, maxWidth: 420, fontFamily: FONT_MONO,
          // 工具栏是墨面（INK_SURFACE.bg），字必须用面上的纸色 —— 原来写成纸上的墨色
          // COLOR.text2，墨字压墨底，整格看着就是一条空的长块（2026-08-22 用户截图报）
          fontSize: FONT_SIZE.xs, color: INK_SURFACE.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'text',
        }} title={addr || ''}>
          <Globe size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
          {addr ? displayUrl(addr) : '（还没打开页面）'}
        </span>
      ),
    },
    {
      id: 'nav',
      items: [
        { id: 'back', icon: ArrowLeft, title: '后退', onClick: () => send({ type: 'nav', action: 'back' }) },
        { id: 'reload', icon: RotateCw, title: '刷新', onClick: () => send({ type: 'nav', action: 'reload' }) },
      ],
    },
    {
      id: 'end',
      items: [{
        id: 'end',
        icon: PowerOff,
        // 「关掉这扇窗」和「不逛了」是两件事：前者只是不看，卡片和实例都还在。
        // 没有这颗按钮的话，桌面上那张卡一旦出现就永远赶不走（判据是痕迹在不在）。
        title: '不逛了 —— 关掉浏览器并把桌面上那张卡收走（在站点上的登录留着）',
        onClick: async () => {
          try { await Browse.end(projectId); } catch { /* 关不掉也照样收窗 */ }
          onClose?.();
        },
      }],
    },
    {
      // 画面大小（09-08）：默认缩略图，这颗按钮把它展开。
      // ⭐ 双击画面也能切，但**光有双击不够** —— 收起来的东西必须有一个看得见的
      // 展开入口，不然它对没试过双击的人就等于不存在。
      id: 'size',
      items: [{
        id: 'zoom',
        icon: expanded ? Minimize2 : Maximize2,
        title: expanded ? '缩小 —— 让画面回到缩略图大小' : '放大 —— 铺满这扇窗',
        onClick: () => setExpanded(v => !v),
      }],
    },
    {
      id: 'takeover',
      items: [{
        id: 'hand',
        icon: takeover ? Play : Hand,
        title: takeover
          ? '好了继续 —— 把控制权交回 agent（它正等着）'
          : (native && agentBusy && !(help || liveHelp))
            ? 'agent 正在操作 —— 先按停这一轮，才能接手'
            : '我来接手 —— 点击/滚动/打字会直接发到那个浏览器里',
        active: takeover,
        disabled: !!(native && agentBusy && !takeover && !(help || liveHelp)),
        onClick: () => {
          if (native && agentBusy && !takeover && !(help || liveHelp)) return;
          if (takeover) { send({ type: 'release' }); setTakeover(false); }
          else { setTakeover(true); native?.focus?.(projectId)?.catch?.(() => {}); }
        },
      }],
    },
  ], [addr, takeover, send, projectId, onClose, native, agentBusy, help, liveHelp, expanded]);

  const stateLine = {
    connecting: '连接中…',
    live: null,
    idle: note || 'agent 还没开始浏览',
    error: note || '出错了',
    closed: note || '浏览器已经关了',
  }[status];

  return (
    <ArtifactWindow
      kind="browse"
      title="agent 的浏览器"
      subtitle={takeover ? '你在接手' : (status === 'live' ? '实时' : null)}
      onClose={onClose}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      banner={(help || liveHelp) ? (
        <span>
          <b>agent 需要你帮个手</b>：{help || liveHelp}
          　—— 点工具栏上的<b>手形按钮</b>接手，弄完再点一次（变成 ▶）把控制权交回去。
          它正停在那儿等你。
        </span>
      ) : null}
      contentStyle={{ background: CANVAS.paper }}
    >
      {/* ⚠️ `flex:1 + minHeight:0` 不是 `height:100%` —— 内容区是 flex 列，
          下面还有一条"采到的东西"的架子；写 100% 会把它挤出窗外看不见。 */}
      <div style={{
        flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: GAP.md, boxSizing: 'border-box', position: 'relative',
      }}>
        {native && (
          // 原生视图钉在 hostRef 上（壳按这个矩形摆）。16:9 = 视图 zoom 后正好 1366×768 CSS px，agent 坐标 1:1。
          // 底下留 64px 给浮动工具栏：视图是壳画的，压在 DOM 之上，工具栏躲不开它。
          // 外面那层是「框」：视图本身是壳里一块硬边矩形，圆角、阴影、接手时的描边都只能画在它外面 ——
          // 一圈纸色的衬边 + 软阴影，让它看起来是贴在桌面上的一张纸，不是浮在界面上的一块屏。
          <div style={{
            margin: '0 auto 64px', padding: FRAME_PAD, borderRadius: 8, boxSizing: 'content-box',
            background: takeover ? (COLOR.accent || '#8a4b2d') : 'rgba(43,33,23,0.08)',
            boxShadow: status === 'live'
              ? '0 1px 0 rgba(255,255,255,.5) inset, 0 6px 22px rgba(43,39,35,.22), 0 1px 3px rgba(43,39,35,.18)'
              : 'none',
            transition: 'background 160ms ease',
          }}>
            <div ref={hostRef} style={{
              borderRadius: 2,
              background: status === 'live' ? 'transparent' : 'rgba(43,33,23,0.03)',
            }} />
          </div>
        )}
        {!native && <canvas
          ref={canvasRef}
          tabIndex={takeover ? 0 : -1}
          onDoubleClick={() => setExpanded(v => !v)}
          title={takeover
            ? '接手中：点一下这块画面再打字（键盘只在这里生效）'
            : (expanded ? '双击缩小' : '双击放大')}
          style={{
            // 缩略图档：宽度封在 THUMB_W，双击或点工具栏那颗按钮展开
            maxWidth: expanded ? '100%' : THUMB_W, maxHeight: '100%',
            display: gotFrame ? 'block' : 'none',
            transition: 'max-width 220ms cubic-bezier(0.32,0.72,0,1)',
            background: '#fff', borderRadius: 2,
            boxShadow: '0 2px 12px rgba(43,39,35,.18)',
            cursor: takeover ? 'pointer' : 'default',
            outline: takeover ? `2px solid ${COLOR.accent || '#8a4b2d'}` : 'none',
            outlineOffset: 3,
          }}
        />}
        {/* 空白态提示（下面那块）与画面共用这块容器。共视下没有帧：live 就是有画面 */}
        {((native ? status !== 'live' : !gotFrame) || stateLine) && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: GAP.sm,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, textAlign: 'center',
          }}>
            {status === 'connecting' && <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />}
            <span>{stateLine || '等第一帧…'}</span>
            {(status === 'idle' || status === 'closed') && (
              <>
                {addr && (
                  <button
                    type="button"
                    disabled={opening}
                    onClick={openBrowser}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: `${GAP.xs}px ${GAP.md}px`, cursor: opening ? 'default' : 'pointer',
                      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
                      color: COLOR.text, background: CANVAS.paper,
                      border: `1px solid ${COLOR.border}`, borderRadius: 3,
                      opacity: opening ? 0.6 : 1,
                    }}
                  >
                    {opening ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                    {opening ? '正在打开…' : '打开上次那一页'}
                  </button>
                )}
                <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs, maxWidth: 360, lineHeight: 1.7 }}>
                  {addr
                    ? '浏览器空闲 5 分钟会自己休息（登录态留着）。打开之后你可以直接接手操作，agent 下次也接着用这一页。'
                    : '让 agent 去看一个站（它有 browser_navigate），这里就会亮起来。'}
                  <br />
                  静止的页面不会一直传帧 —— 画面不动是正常的，不是卡住了。
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── 它采回来的东西：一站一文件夹（存放格式按站点产物那条范式）── */}
      {!!sites.length && (
        <div style={{
          flexShrink: 0, borderTop: `1px solid ${COLOR.border}`,
          background: COLOR.bgCard, maxHeight: shelfOpen ? 220 : 30, overflow: 'hidden',
          transition: 'max-height .18s ease',
        }}>
          <button
            type="button"
            onClick={() => setShelfOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              padding: `4px ${GAP.md}px`, cursor: 'pointer', background: 'transparent',
              border: 0, color: COLOR.text2, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            }}
          >
            <FolderOpen size={12} />
            采到的东西 · {sites.length} 个站 · {sites.reduce((n, x) => n + x.count, 0)} 件
            <ChevronDown size={12} style={{
              marginLeft: 'auto', opacity: 0.6,
              transform: shelfOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .18s ease',
            }} />
          </button>
          {shelfOpen && (
            <div style={{ display: 'flex', gap: GAP.sm, padding: `0 ${GAP.md}px ${GAP.sm}px`, overflowX: 'auto' }}>
              {sites.map(st => (
                <div key={st.site} style={{ flexShrink: 0, width: 150 }}>
                  <button
                    type="button"
                    title={`${st.dir}（${st.count} 件）`}
                    onClick={() => setOpenSite(openSite === st.site ? null : st.site)}
                    style={{
                      display: 'block', width: '100%', padding: 0, cursor: 'pointer',
                      background: CANVAS.paper, border: `1px solid ${openSite === st.site ? COLOR.text : COLOR.border}`,
                      borderRadius: 2, overflow: 'hidden',
                    }}
                  >
                    {st.cover ? (
                      <img
                        alt=""
                        loading="lazy"
                        // ⚠️ 这里**不能**加 `?w=`：响应式档只认 png/jpg 源
                        // （`image-variant.js` 的 TRANSCODABLE），而采集的截图是
                        // webp（走感知层那条归一化）。加了是个静默无效的参数，
                        // 看起来像做了优化其实没有。封面 ~60KB，靠 lazy + 折叠够了。
                        src={Assets.artifactFileUrl(projectId, st.cover)}
                        style={{ width: '100%', height: 84, objectFit: 'cover', objectPosition: 'top center', display: 'block' }}
                      />
                    ) : (
                      <div style={{
                        height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                      }}>没有截图</div>
                    )}
                    <div style={{
                      padding: '3px 5px', textAlign: 'left',
                      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.text2,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{st.site}</div>
                  </button>
                  {openSite === st.site && (
                    <div style={{
                      paddingTop: 3, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                      color: COLOR.sub, lineHeight: 1.6,
                    }}>
                      {/* 路径给出来就够了：文件在工作区里，agent 下个会话直接引用它 */}
                      <span style={{ fontFamily: FONT_MONO }}>{st.dir}/</span>
                      <br />
                      {st.count} 件（截图 / 调色板 / 字体 / 结构 / CSS，类别在文件名里）
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ArtifactWindow>
  );
}
