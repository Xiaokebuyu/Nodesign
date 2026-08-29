import { useEffect, useRef, useState } from 'react';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import EdgeTab, { TAB_LEN } from '../ui/EdgeTab.jsx';
import { useViewportWidth, useMedia, COARSE } from '../../lib/use-media.js';
import { useDeviceClass } from '../../lib/device-class.js';
import { MobileSheet, TalkFab } from './MobileShell.jsx';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * ChatDock —— 悬浮 AI 卡（2026-08-13，第三形态）。
 *
 * 第一代是 react-rnd 浮窗（能拖到任何地方），第二代是钉死右缘的侧边栏
 * （常驻 380px + 收起后还剩 44px 窄轨）。用户对第二代的话是：
 * 「边缘不该有任何常驻遮挡」「它看起来就像是一个漂浮起来的卡片，
 * 鼠标靠近侧边来唤出它，卡片上需要有一个固定按钮，左右都能呼出」。
 *
 * 于是这一代是**召唤式**：
 *   - 关着的时候什么都不渲染 —— 零常驻遮挡，窄轨删了。
 *   - 鼠标贴到左/右屏缘（10px 带）停 150ms → 卡片从那一侧滑出。
 *     热区是 window mousemove 算出来的，不是一条 DOM 条 —— DOM 条本身
 *     就是常驻遮挡（会吃掉贴边元素的点击），跟这次要解决的问题同罪。
 *   - 未固定：鼠标离卡 300ms 后自动收；输入框还握着焦点就不收
 *     （正在打字，鼠标歇在哪不重要）。
 *   - 固定（图钉按钮，记 localStorage）：不自动收，只有手动收起。
 *
 * ## 皮
 *
 * 一张漂浮的纸（参考产物窗）：纸底 + 颗粒 + 直角 + 影子（不描边）。
 * 图钉不只是按钮 —— **卡面顶沿正中那枚钉纽扣只在固定态出现**：钉住的纸
 * 才有钉子，浮着的纸没有。影子跟着走：固定 = mid（贴板上），
 * 悬浮 = near（浮得高）。这是全站「纸的物理」的一部分，不是装饰。
 *
 * ## 层
 *
 * 还是画布 section 的 absolute 兄弟（section 有 isolation:'isolate'），
 * z 120 —— 产物窗的 500 被关在隔离层里出不来，卡永远浮在产物窗之上，
 * 开着 deck 也能跟 agent 说话。这个结构 2026-08-07 就定了，别动。
 */

const MIN_W = 320;
const MAX_W = 720;
const DEFAULT_W = 380;
const KEY = 'nd:chatdock';

/** 屏缘热区宽（px）。比它宽会误触，比它窄要贴得太准。 */
const HOT_W = 10;
/** 热区避开顶部这一段：产物窗的关闭按钮、顶栏按钮都住在上面 */
const HOT_TOP_GUARD = 100;
/** 贴边停留多久才召唤（防路过误触） */
const DWELL_MS = 150;
/** 鼠标离卡多久后收（未固定时） */
const HIDE_MS = 300;
/** 卡到屏缘的缝。比热区（10px）窄 —— 召唤成功时卡直接长在指针底下，
 *  pointerenter 立刻接管，自动收的兜底计时器基本用不上。 */
const EDGE_GAP = 8;
/**
 * 留给贴纸的那一条（2026-08-21）。卡再宽也不许吃掉它 —— 手机上卡是铺满的，
 * 不留这一条贴纸就被卡压出屏外，用户既看不见"这层是从哪拉出来的"，也没地方点收起。
 * 顺带这一条也是「点外面收起」的落点。8 缝 + 15 贴纸 + 15 富余。
 */
const TAB_LANE = 38;

/**
 * 配置版本（2026-08-17）。
 *
 * 出厂默认从「固定展开」翻成「不固定」—— 因为顶栏改成了「卡显示时不浮现」
 * （issue #1 第 1、4 条），两层界面轮流占屏。默认要是还固定着，顶栏就等于
 * 永远唤不出来，面包屑 / 导出 / 登出全都够不着。
 *
 * **必须带版本号**：这份配置是**挂载即落盘**的（下面那条 effect），所以每个
 * 来过的人本地都写着 `pinned:true` —— 那不是他们选的，是上一版默认的残影。
 * 只改默认值对他们零效果，正好落进"卡开着 + 顶栏不出来"那个最坏组合。
 * 没有 v 的旧配置一律按新默认重置这一项（side / width 是真选择，留着）。
 * 代价：真的手动钉过的人会被解一次钉，钉回去就记住了。
 */
const CFG_V = 2;

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY)) || {};
    return {
      v: CFG_V,
      // 默认不固定：贴右缘唤出，鼠标离开自动收，屏幕交回画布和顶栏
      pinned: c.v === CFG_V ? c.pinned === true : false,
      side: c.side === 'left' ? 'left' : 'right',
      width: Number.isFinite(c.width) ? Math.min(MAX_W, Math.max(MIN_W, c.width)) : DEFAULT_W,
    };
  } catch { return { v: CFG_V, pinned: false, side: 'right', width: DEFAULT_W }; }
}

export default function ChatDock({
  title, children,
  /**
   * 卡的开合上报给外层（2026-08-17）。顶栏据此**不浮现** —— 卡贴着右缘从
   * 屏顶铺到屏底，顶栏一浮出来就压住它顶沿那排按钮（折叠 / 图钉）。
   * 跟产物窗那条 `topSuppressed` 同一个道理：那一层不是当前上下文。
   */
  onOpenChange,
}) {
  void title; // 标题在 ChatPanel 的 header 里，这层不再画（保留 prop 兼容调用方）
  const [cfg, setCfg] = useState(loadCfg);
  const [open, setOpen] = useState(() => loadCfg().pinned);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef(null);
  const hideTimer = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const draggingRef = useRef(false);
  draggingRef.current = dragging;
  /**
   * 这一次是**贴边召唤**出来的吗（2026-08-21）。
   * 召唤出来的卡要留一条兜底：万一鼠标没进卡，1.2s 后自己收回去（不然一次误召唤会永远开着）。
   * 但**点贴纸打开**和**程序化唤出**是明确动作，不能被那条兜底收走 —— 触屏上指针永远不会
   * "进卡"，不分开的话点一下贴纸，卡 1.2 秒后自己没了。
   */
  const summonedRef = useRef(false);

  /** 视口宽：窄屏上卡要铺满（留出舌头那一条），所以要的是真像素不是一个布尔 */
  const vw = useViewportWidth();
  /**
   * 舌头**只长在手指设备上**。桌面维持 2026-08-13 那条：「边缘不该有任何常驻遮挡」，
   * 鼠标贴边停 150ms 就能唤出来，不需要一个常驻的小块占着屏缘。
   */
  const coarse = useMedia(COARSE);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* 隐私模式 */ }
  }, [cfg]);

  /**
   * 真正落地的宽度：窄屏上按视口铺满，但**永远给贴纸留出 TAB_LANE 那一条**。
   * 用户拖出来的 cfg.width 原样存着（换回宽屏还是他调的那个数），这里只钳显示值。
   * ⚠️ 算在这么靠上是因为下面那条 onOpenChange 要报它，而报的那条不能挪到
   * 手机档那个提前 return 之后（hook 不许有条件地跑）。
   */
  const width = Math.min(cfg.width, Math.max(240, vw - (coarse ? TAB_LANE : EDGE_GAP * 2)));

  /**
   * 报「开没开」的同时报「占了多宽」（2026-08-29 外壳第四刀）。
   * 平板上调用方要靠这个数把画布区让出来 —— 810 宽的屏上卡一开就压住工具栏
   * 右半边（真机量到：卡从 x=422 起，工具栏占 113-697）。桌面屏够宽不犯，
   * 所以让不让位由调用方按设备档决定，这儿只负责把数报准。
   */
  useEffect(() => { onOpenChange?.(open, open ? width : 0); }, [open, width, onOpenChange]);

  // ── 程序化唤出：就地标注/圈选发送（openChatDock）、要把光标放进输入框
  //   （focusComposer —— 对着收起的卡聚焦是空操作，所以它隐含"先出来"）。
  //   首帧不触发：计数器是全局的，换项目再挂载时残值不该把卡弹出来。
  const openTick = useGlobalStore(s => s.chatDockOpenTick);
  const focusTick = useGlobalStore(s => s.composerFocusTick);
  /**
   * 记住的是**上一次的计数值**，不是"跑过没有"的布尔。
   * ⛔ 布尔版会被 StrictMode 打穿：开发模式下 effect 是 mount→unmount→mount 跑两遍，
   * 而 ref 跨这次假重挂是**留着的** —— 第二遍进来 `已跑过` 已是 true，于是每次进项目
   * 卡都自己弹出来。以前没人发现是因为 1.2s 兜底计时器又把它收了回去（08-21 把兜底
   * 收窄成"只管贴边召唤"之后，这个老毛病当场露出来）。比值就没这问题。
   */
  const seenTicks = useRef(null);
  useEffect(() => {
    const sig = `${openTick}:${focusTick}`;
    if (seenTicks.current === null || seenTicks.current === sig) { seenTicks.current = sig; return; }
    seenTicks.current = sig;
    clearHide();
    summonedRef.current = false;   // 明确动作，不吃 1.2s 兜底
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTick, focusTick]);

  // ── 召唤：window mousemove 热区（rAF 节流）。只在关着时监听。
  useEffect(() => {
    if (open) return undefined;
    let raf = 0;
    let dwell = null;
    const cancelDwell = () => { if (dwell) { clearTimeout(dwell); dwell = null; } };
    const onMove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 按着键的移动是拖拽（拖卡、圈选、画涂鸦）—— 手滑到屏缘不是在召唤
        if (e.buttons !== 0 || e.clientY < HOT_TOP_GUARD) { cancelDwell(); return; }
        // 贴纸自己那一段不召唤：它是**点**的目标，路过就自动打开的话，接下来那一下
        // 点击反而把卡关了
        if (e.target?.closest?.('[data-edge-tab]')) { cancelDwell(); return; }
        const nearRight = window.innerWidth - e.clientX <= HOT_W;
        const nearLeft = e.clientX <= HOT_W;
        if (nearRight || nearLeft) {
          if (!dwell) {
            const side = nearRight ? 'right' : 'left';
            dwell = setTimeout(() => {
              dwell = null;
              setCfg(c => (c.side === side ? c : { ...c, side }));
              summonedRef.current = true;
              setOpen(true);
            }, DWELL_MS);
          }
        } else cancelDwell();
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf) cancelAnimationFrame(raf);
      cancelDwell();
    };
  }, [open]);

  // ── 自动收（未固定）。armHide 走同一条 300ms 路，三个触发源：
  //   1. 鼠标离开卡（pointerleave）
  //   2. 召唤后鼠标从没进过卡（卡比热区缩进 8px，正常会立刻 enter；万一没有，
  //      这条兜底 —— 不然一次误召唤会永远开着）
  //   3. 点了卡外面（pointerdown 时焦点还没搬家，等 300ms 后再验 activeElement）
  const clearHide = () => { clearTimeout(hideTimer.current); hideTimer.current = null; };
  const armHide = (delay = HIDE_MS) => {
    if (cfgRef.current.pinned || draggingRef.current) return;
    clearHide();
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      const el = rootRef.current;
      // 输入框还握着焦点 = 正在打字，不收。只认**真输入元素** —— 点过的
      // 按钮也会握着焦点（图钉、收起都在卡里），按"卡内有焦点就不收"判，
      // 点一下按钮自动收就永远失效（真跑抓出来的）。
      const a = document.activeElement;
      if (el && a && el.contains(a)
        && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.getAttribute?.('contenteditable') === 'true')) return;
      if (el && el.matches(':hover')) return;   // 鼠标其实还在卡上（快速抖动）
      setOpen(false);
    }, delay);
  };

  useEffect(() => {
    if (!open || cfg.pinned) return undefined;
    // 触发源 2：**贴边召唤**成功但鼠标一直没进卡。点贴纸/程序化打开的不算 ——
    // 触屏上指针永远不会"进卡"，一视同仁的话点一下贴纸卡就 1.2 秒后自己没了
    if (summonedRef.current) armHide(1200);
    // 触发源 3：点外面
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) armHide();
    };
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('pointerdown', onDown); clearHide(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cfg.pinned]);

  useEffect(() => () => clearHide(), []);

  // ── 宽度把手：监听挂 window（鼠标很容易甩出 6px 的把手）
  useEffect(() => {
    if (!dragging) return undefined;
    const move = (e) => {
      const w = cfgRef.current.side === 'right'
        ? window.innerWidth - e.clientX - EDGE_GAP
        : e.clientX - EDGE_GAP;
      setCfg(c => ({ ...c, width: Math.min(MAX_W, Math.max(MIN_W, w)) }));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging]);

  const { side, pinned } = cfg;
  const togglePin = () => setCfg(c => ({ ...c, pinned: !c.pinned }));

  /**
   * ── 手机档：换一层皮，内容一行不动（2026-08-29 外壳第二刀）──
   *
   * 上面那整套（贴屏缘 10px 停 150ms 召唤 / 300ms 离开自动收 / 宽度把手 /
   * 图钉）都是为鼠标和宽屏写的。手机上它们各自的坏法：
   *   召唤   没有 hover，只能靠 08-21 补的那枚边缘贴纸
   *   位置   贴右缘 = 离拇指最远，而窄屏上它已经被钳成几乎满宽，「卡」名存实亡
   *   图钉   "不自动收"在没有 hover 的地方本来就没有对立面
   *
   * 换成：底部抽屉（从拇指的方向来）+ 一颗「跟它说话」的钮。
   * ⭐ children 是 render prop，内容（ChatPanel 那 20 个入参）全在调用方手里 ——
   * 这一刀只换容器，**一份逻辑照旧只有一份**。pinned 传 true / onTogglePin 传
   * null：手机上没有"自动收"这回事，那颗图钉没有对立面，ChatPanel 见 null 自然不画。
   */
  const phone = useDeviceClass() === 'phone';
  if (phone) {
    return (
      <>
        <TalkFab onClick={() => setOpen(true)} hidden={open} />
        <MobileSheet open={open} onClose={() => setOpen(false)} label={title || '对话'}>
          {typeof children === 'function'
            ? children({ collapse: () => setOpen(false), pinned: true, onTogglePin: null })
            : children}
        </MobileSheet>
      </>
    );
  }

  // 收起 ≠ 卸载：草稿在 ChatComposer 的本地 state 里（滚动位置、子代理 tab
  // 同理），卸载 = 用户没发出去的话被吹掉。所以关着的时候是**平移出屏**：
  // visibility 走 220ms 延迟，滑出动画放完才真正隐身；pointerEvents 立刻断，
  // 屏缘那 8px 缝里露不出任何可点的东西 —— 视觉与交互上都是零常驻遮挡。
  const OFF = width + EDGE_GAP + 30;   // +30 让影子也完全出屏

  return (
    <>
      {/* 舌头：合着时贴在屏缘，拉开后长在卡的内沿上。位移跟卡同一条曲线、同一个
          时长，看起来才是"被卡带出来的"而不是两个东西各走各的。
          它是卡的**兄弟节点**：卡关着的时候整张纸 pointerEvents:none 且平移出屏，
          舌头长在里面就跟着一起没了。 */}
      {coarse && <EdgeTab
        edge={side}
        open={open}
        title={open ? '收起对话' : '打开对话'}
        onClick={() => {
          clearHide();
          summonedRef.current = false;
          setOpen(o => !o);
        }}
        style={{
          top: '50%', [side]: 0, marginTop: -TAB_LEN / 2, zIndex: 121,
          transform: open
            ? `translateX(${side === 'right' ? -(width + EDGE_GAP) : width + EDGE_GAP}px)`
            : 'none',
          transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />}
      <div
        ref={rootRef}
        data-chat-card
        onPointerEnter={clearHide}
        // 只认鼠标：触屏的 pointerleave 在**手指抬起**时也会发，一视同仁的话
        // 在卡里划一下消息就把卡收了
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') armHide(); }}
        style={{
          position: 'absolute',
          top: 14, bottom: 14, [side]: EDGE_GAP, width,
          display: 'flex', flexDirection: 'column',
          background: PAPER.paper,
          backgroundImage: GRAIN,
          // 固定 = 钉在板上（mid，贴得平）；悬浮 = 刚拿起来的纸（浮得高）
          boxShadow: pinned ? PAPER_SHADOW.mid : PAPER_SHADOW.near,
          borderRadius: 0,
          zIndex: 120,
          transform: open ? 'none' : `translateX(${side === 'right' ? OFF : -OFF}px)`,
          opacity: open ? 1 : 0,
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: open ? 'auto' : 'none',
          transition: open
            ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms, visibility 0s'
            : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms 60ms, visibility 0s 220ms',
        }}
      >

        {/* 钉纽扣：只在固定态出现 —— 钉住的纸才有钉子（同产物窗/首页卡那枚：
            同一段渐变、同一个光向）。纯装饰不吃事件；固定/取消在 header 的图钉按钮。 */}
        {pinned && (
          <span aria-hidden style={{
            position: 'absolute', left: '50%', top: 6, marginLeft: -4.5,
            width: 9, height: 9, borderRadius: '50%', pointerEvents: 'none', zIndex: 3,
            background: 'radial-gradient(circle at 35% 30%, #8a7a62, #453a2c 65%)',
            boxShadow: '-1px 2px 3px rgba(43,33,23,0.45)',
          }} />
        )}

        {/* 宽度把手：贴内侧缘的一条 6px 热区（卡在右就在左缘，反之亦然） */}
        <div
          data-no-pan
          onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
          style={{
            position: 'absolute', [side === 'right' ? 'left' : 'right']: -3,
            top: 0, bottom: 0, width: 6,
            cursor: 'col-resize', zIndex: 2,
            background: dragging ? PAPER.kraft : 'transparent',
          }}
        />
        {/* 不自己画标题栏 —— ChatPanel 的 header 已经有会话标题和那排按钮，
            收起/图钉作为动作也属于那排。render prop 把控制递进去。 */}
        {typeof children === 'function'
          ? children({ collapse: () => setOpen(false), pinned, onTogglePin: togglePin })
          : children}
      </div>
    </>
  );
}
