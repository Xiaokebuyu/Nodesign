import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ArrowLeft, RotateCw, Hand, Play, Loader2, Globe, PowerOff, FolderOpen, ChevronDown } from 'lucide-react';
import { COLOR, CANVAS, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { INK_SURFACE } from '../../lib/paper.js';

/** 地址读数：百分号编码的中日文解回来给人看（tower.jp/search/item/%E7%9B… 没人读得了）；解不动就原样 */
function displayUrl(u) { try { return decodeURI(u); } catch { return u; } }
import ArtifactWindow from './ArtifactWindow.jsx';
import { Browse, Assets } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/** 桌面版共视（09-08）：页面是壳里的原生视图，这里只负责说它摆在哪 */
const nativeView = () => (typeof window !== 'undefined' && window.nodesignDesktop?.browserView) || null;

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
  const canvasRef = useRef(null);
  const hostRef = useRef(null);      // 共视：原生视图要摆的那块（16:9）
  const native = nativeView();
  const activeRun = useGlobalStore(s => s.activeRun);
  const agentBusy = !!activeRun && activeRun.pid === projectId;
  const wsRef = useRef(null);
  const takeoverRef = useRef(false);
  takeoverRef.current = takeover;

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
   * 矩形随窗口大小 / 滚动 / 布局变化而变，ResizeObserver + resize/scroll 兜住，rAF 合并。
   */
  useEffect(() => {
    if (!native) return undefined;
    let raf = 0;
    const report = () => {
      raf = 0;
      const el = hostRef.current;
      if (!el) return;
      // 先把自己撑成容器里最大的 16:9（底下留 64px 给浮动工具栏），再把矩形报给壳
      const box = el.parentElement?.getBoundingClientRect();
      if (box) {
        const w = Math.max(0, Math.min(box.width - 16, (box.height - 64 - 16) * 16 / 9));
        el.style.width = `${Math.floor(w)}px`;
        el.style.height = `${Math.floor(w * 9 / 16)}px`;
      }
      const r = el.getBoundingClientRect();
      native.place(projectId, r.width > 8 && r.height > 8 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null).catch(() => {});
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(report); };
    const ro = new ResizeObserver(schedule);
    if (hostRef.current?.parentElement) ro.observe(hostRef.current.parentElement);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();
    const tick = setInterval(schedule, 1000);   // 兜底：CSS 动画 / 顶栏收放这类没有事件的位移
    return () => {
      ro.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      clearInterval(tick); if (raf) cancelAnimationFrame(raf);
      native.place(projectId, null).catch(() => {});
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
          else setTakeover(true);
        },
      }],
    },
  ], [addr, takeover, send, projectId, onClose, native, agentBusy, help, liveHelp]);

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
          // 原生视图钉在这块上（壳按这个矩形摆）。16:9 = 视图 zoom 后正好 1366×768 CSS px，agent 坐标 1:1。
          // 底下留 64px 给浮动工具栏：视图是壳画的，压在 DOM 之上，工具栏躲不开它
          <div ref={hostRef} style={{
            margin: '0 auto 64px', borderRadius: 2,
            boxShadow: status === 'live' ? '0 2px 12px rgba(43,39,35,.18)' : 'none',
            background: status === 'live' ? 'transparent' : 'rgba(43,33,23,0.03)',
          }} />
        )}
        {!native && <canvas
          ref={canvasRef}
          tabIndex={takeover ? 0 : -1}
          title={takeover ? '接手中：点一下这块画面再打字（键盘只在这里生效）' : undefined}
          style={{
            maxWidth: '100%', maxHeight: '100%', display: gotFrame ? 'block' : 'none',
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
