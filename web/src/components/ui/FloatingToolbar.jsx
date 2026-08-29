import { useState, useRef, useCallback, useEffect } from 'react';
import { Pin } from 'lucide-react';
import { INK_SURFACE } from '../../lib/paper.js';
import ToolbarButton, { TOOL_BTN } from './ToolbarButton.jsx';
import { FONT_SANS, FONT_SIZE, GAP } from '../../lib/theme.js';
import { usePanelState } from '../layout/PanelManager.jsx';
import { useMedia, NARROW, COARSE } from '../../lib/use-media.js';

/**
 * FloatingToolbar —— 浮在内容之上、可拖动的工具条（2026-08-07）
 *
 * 用户要的是「一个能四处应用、盛放所有手动操作工具的容器」：画布有画布的
 * 工具（选择 / 文字 / 笔 / 评论），deck 窗口有 deck 的，站点窗口有站点的，
 * 世界窗口有世界的。以前每种窗口各自长一条固定工具栏，形态一多就各写各的。
 *
 * ## 两种组，这是全部的抽象
 *
 * - **动作组**：按一下做一件事（存档 / 导出 / 刷新）。
 * - **模式组**（`type: 'mode'`）：单选，选中的那个是「当前工具」。
 *   画布的选择/文字/笔/评论就是它，同一时刻只能有一个。
 *
 * 分成两种是因为它们的**反馈语义**根本不同：动作按完就弹回，模式按完要一直
 *亮着告诉你"现在手里拿的是笔"。混在一起做会得到一个既像按钮又像开关的东西。
 *
 * ## 为什么不用 FloatingPanel
 *
 * 那是带标题栏 + 可 resize 的面板壳（浮动 agent 栏该用它）。工具条没有标题栏、
 * 不该 resize、宽度由内容定。共用的只有"能拖 + 记住位置"，那部分走同一个
 * PanelManager，视觉和交互各走各的。
 *
 * ## 拖拽为什么不用 react-rnd
 *
 * Rnd 靠 `dragHandleClassName` 划拖拽区，而这里要的是「整条都能拖，**除了**
 * 按钮」—— 按钮在 handle 内部，Rnd 照样会起拖，一点按钮就把整条拽跑。
 * 指针事件自己写反而更短更准：按下时看 `closest('[data-tool-btn]')`，是按钮
 * 就不起拖。
 */

/** 拖过这么多像素才算拖，否则算点击（防手抖把点按钮变成微拖） */
const DRAG_SLOP = 3;

/** 贴边留白：工具条不要顶死容器边缘 */
const ANCHOR_INSET = 20;

/** dock 到底边时离边缘留多少 */
const DOCK_INSET = 18;
/** 底缘这么高的一条算"要去够工具条了" */
const REVEAL_BAND = 96;
/** 没人理它多久之后收起来 */
const AUTOHIDE_DELAY = 1800;

/**
 * 按 anchor 算首次落点。要等**量到自己多宽**才算得出来，所以在 layout effect 里做。
 * 只在没有存过位置时用一次 —— 存过就听用户的。
 */
function anchoredPosition(anchor, bounds, el) {
  const bw = bounds.clientWidth;
  const bh = bounds.clientHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const cx = Math.max(ANCHOR_INSET, Math.round((bw - w) / 2));
  switch (anchor) {
    case 'bottom-center': return { x: cx, y: Math.max(ANCHOR_INSET, bh - h - ANCHOR_INSET) };
    case 'top-center':    return { x: cx, y: ANCHOR_INSET };
    case 'top-right':     return { x: Math.max(ANCHOR_INSET, bw - w - ANCHOR_INSET), y: ANCHOR_INSET };
    default:              return { x: ANCHOR_INSET, y: ANCHOR_INSET };
  }
}

export default function FloatingToolbar({
  /** 传了就走 PanelManager 持久化位置；不传就是纯局部状态 */
  id,
  groups = [],
  defaultPosition = { x: 24, y: 24 },
  /**
   * 首次落点按容器算（'bottom-center' | 'top-center' | 'top-right' | 'top-left'）。
   * 给了它就压过 defaultPosition —— 「贴着底边居中」这种位置写不成常量，
   * 得知道容器多大、自己多宽。存过位置之后一律听存的。
   */
  anchor = null,
  /**
   * 钉死在容器某条边上（目前只用 'bottom-center'）。给了它就**不能拖**，
   * 位置永远是算出来的 —— 画布那条工具栏要的是"永远在同一个地方"，
   * 拖走了反而找不着。跟 anchor 的区别：anchor 只管第一次落点，之后听用户的。
   */
  dock = null,
  /**
   * 平时收起，需要时才浮现。三种唤醒：鼠标接近它那条边、`wake` 变化
   * （相机缩放 / 换工具这类"正在用它"的信号）、以及指针悬在它身上。
   */
  autoHide = false,
  /**
   * 末尾长一枚图钉（2026-08-14，与 AI 悬浮卡同一套语义）：钉住 = 不自动收，
   * 常驻可见；状态记 localStorage（按 id），换页还记得。只在 autoHide 时有意义。
   */
  pinnable = false,
  /** 值一变就唤出来（传个计数器或状态串） */
  wake = null,
  /** 组之间的堆叠方向。参考图是竖着堆两条，所以默认 column */
  stack = 'column',
  /** 限位容器（不传就不限位）。传 ref 或 DOM 元素都行 */
  boundsRef,
  /** 压在谁上面。常驻工具栏要盖过产物窗（z=500），所以得能显式给 */
  zIndex = null,
  style,
}) {
  const panel = usePanelState(id);
  const [localPos, setLocalPos] = useState(defaultPosition);
  const [dockPos, setDockPos] = useState(null);
  const pos = dock ? (dockPos || { x: -9999, y: -9999 }) : ((panel?.position) || localPos);

  const elRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  // 首帧还没量出落点时先藏着：从 (24,24) 跳到底部居中是能看见的一跳
  const [placed, setPlaced] = useState(() => !anchor || !!panel?.position);

  const commit = useCallback((p) => {
    if (panel?.setPosition) panel.setPosition(p);
    else setLocalPos(p);
  }, [panel]);

  /**
   * 首次落点：量到容器和自己的尺寸之后算一次，之后再不插手。
   *
   * ⚠️ 这里**不能用 useLayoutEffect**：React 提交阶段是子在前父在后，子组件的
   * layout effect 跑的时候，父组件的 ref 还没挂上 —— `boundsRef.current` 是
   * null。而它一旦空跑一次就没有下一次渲染来救（位置没变=没有 setState），
   * 工具条就永远停在 hidden。改成 passive effect（此时父 ref 已挂）+ rAF 重试
   * 兜住"这一帧还没量出来"。
   */
  const anchoredRef = useRef(false);
  /** 用户亲手拖过之后，任何自动落点都不许再动它 */
  const userMovedRef = useRef(false);
  useEffect(() => {
    if (!anchor || anchoredRef.current) return;
    if (panel?.position) {
      // 已经有存过的位置 = 用户自己摆的，**当成拖过**：下面那套"跟着宽度
      // 摆正"再也不许碰它。只置 anchoredRef 的话会把用户的位置改掉。
      anchoredRef.current = true;
      userMovedRef.current = true;
      setPlaced(true);
      return;
    }
    let raf = 0;
    const tryPlace = () => {
      const bounds = boundsRef?.current;
      const el = elRef.current;
      if (!bounds || !el || !el.offsetWidth) { raf = requestAnimationFrame(tryPlace); return; }
      anchoredRef.current = true;
      commit(anchoredPosition(anchor, bounds, el));
      setPlaced(true);
    };
    tryPlace();
    return () => cancelAnimationFrame(raf);
  });

  /** dock 模式：位置全程由容器算，随容器尺寸变化重算 */
  useEffect(() => {
    if (!dock) return undefined;
    const measure = () => {
      const bounds = boundsRef?.current;
      const el = elRef.current;
      if (!bounds || !el || !el.offsetWidth) return;
      const x = Math.max(0, Math.round((bounds.clientWidth - el.offsetWidth) / 2));
      const y = Math.max(0, bounds.clientHeight - el.offsetHeight - DOCK_INSET);
      setDockPos(prev => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
    };
    measure();
    const raf = requestAnimationFrame(measure);   // 首帧可能还没量到自己
    let ro = null;
    try { ro = new ResizeObserver(measure); if (boundsRef?.current) ro.observe(boundsRef.current); } catch { /* 老浏览器 */ }
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [dock, boundsRef, groups]);

  /**
   * 按需浮现。默认收着，三种情况露出来：
   *   ① 鼠标进到容器底缘那一条里（工具条就在那儿，去够它的路上它就出来了）
   *   ② `wake` 变了 —— 相机缩放、换工具这类"你正在用它"的信号
   *   ③ 指针悬在它身上（露出来之后不能因为超时又缩回去）
   * 刚进画布时先亮一会儿再收，否则新用户根本不知道有这么条东西。
   */
  // 图钉：钉住 = 关掉 autoHide。按 id 记 localStorage —— 这是用户的一次性表态，
  // 不是会话状态，刷新页面还得记得。
  const [pinned, setPinned] = useState(() => {
    try { return pinnable && localStorage.getItem(`nd:tb-pin:${id || 'x'}`) === '1'; } catch { return false; }
  });
  const togglePin = useCallback(() => {
    setPinned(prev => {
      const next = !prev;
      try { localStorage.setItem(`nd:tb-pin:${id || 'x'}`, next ? '1' : '0'); } catch { /* 记不住就算了 */ }
      return next;
    });
  }, [id]);
  /**
   * 手机/平板上**不自动收**（2026-08-21）。自动收的唯一唤回路是"指针贴近底缘
   * 96px 那条带"，而触屏根本没有 hover：手指不按下去就没有 pointermove，
   * 于是工具栏在 1.8 秒之后消失、再也叫不回来 —— 等于工具全没了。
   */
  const coarse = useMedia(COARSE);
  /** 窄屏（手机）：一行 420px 排不进 393 的屏，右边直接被切掉。平板宽度够，不用管。 */
  const narrow = useMedia(NARROW);
  const effAutoHide = autoHide && !pinned && !coarse;

  const [revealed, setRevealed] = useState(!effAutoHide);
  const hoverRef = useRef(false);
  const hideTimer = useRef(null);
  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!hoverRef.current) setRevealed(false); }, AUTOHIDE_DELAY);
  }, []);
  useEffect(() => {
    if (!effAutoHide) {
      // 刚钉住（或本来就不自动收）：立刻亮出来，把挂着的收起定时器掐掉
      clearTimeout(hideTimer.current);
      setRevealed(true);
      return undefined;
    }
    setRevealed(true);
    scheduleHide();
    return () => clearTimeout(hideTimer.current);
  }, [effAutoHide, wake, scheduleHide]);
  useEffect(() => {
    if (!effAutoHide) return undefined;
    const onMove = (e) => {
      const bounds = boundsRef?.current;
      if (!bounds) return;
      const r = bounds.getBoundingClientRect();
      const nearEdge = e.clientY >= r.bottom - REVEAL_BAND && e.clientY <= r.bottom
        && e.clientX >= r.left && e.clientX <= r.right;
      if (nearEdge) { clearTimeout(hideTimer.current); setRevealed(true); }
      else if (!hoverRef.current) scheduleHide();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [effAutoHide, boundsRef, scheduleHide]);

  const onPointerDown = useCallback((e) => {
    if (dock) return;               // 钉住的不给拖
    // 按在按钮上不起拖 —— 整条都能拖，除了按钮
    if (e.target.closest?.('[data-tool-btn]')) return;
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: pos.x, originY: pos.y,
      moved: false,
    };
    panel?.bringToFront?.();
  }, [pos.x, pos.y, panel]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
    if (!d.moved) { d.moved = true; setDragging(true); }

    let x = d.originX + dx;
    let y = d.originY + dy;

    // 限位：整条不许拖出容器（否则拖丢了就找不回来，只能清 localStorage）
    const bounds = boundsRef?.current;
    const el = elRef.current;
    if (bounds && el) {
      const bw = bounds.clientWidth; const bh = bounds.clientHeight;
      x = Math.min(Math.max(0, x), Math.max(0, bw - el.offsetWidth));
      y = Math.min(Math.max(0, y), Math.max(0, bh - el.offsetHeight));
    }
    commit({ x, y });
  }, [boundsRef, commit]);

  const endDrag = useCallback(() => {
    if (dragRef.current?.moved) userMovedRef.current = true;   // 拖过就听用户的
    dragRef.current = null;
    setDragging(false);
  }, []);

  /**
   * 落点跟着宽度走 —— **用户拖过就再也不插手**。
   *
   * 锚点原来只在挂载时算一次，而工具栏的内容是会**后到**的：站点窗的
   * 「上线」控件要先请求发布状态，loaded 之前整组返回 null；导出格式、页面
   * 列表也可能迟到一拍。按缺一组的宽度算出 left 之后，那一组到货工具栏就往
   * 右长出去 —— 表现是"工具栏偏到右下角"，越晚到的组偏得越多。
   *
   * 要两条腿走路，缺一条都不够：
   *   ① 每次渲染后对一次账（本组件因为别的原因重渲染时顺手摆正）
   *   ② 一个**只挂一次**的尺寸观察者 —— 迟到的组是它自己内部 setState 变宽的，
   *      工具栏根本不重渲染，光靠 ① 永远等不到
   *
   * ⚠️ 观察者的 effect 必须是空依赖：`commit` 依赖 `panel`，而 `usePanelState`
   * 每次渲染返回新对象 → 带 commit 当依赖的话 effect 每渲染拆装一次，观察者
   * 刚挂上就被拆掉。所以真正的逻辑放在一个每渲染刷新的 ref 里，effect 只负责
   * 把观察者挂上去。
   */
  const reconcileRef = useRef(null);
  reconcileRef.current = () => {
    if (!anchor || dock || userMovedRef.current || !anchoredRef.current) return;
    if (dragRef.current) return;                    // 正拖着，别抢
    const bounds = boundsRef?.current;
    const el = elRef.current;
    if (!bounds || !el || !el.offsetWidth || !bounds.clientWidth) return;
    const want = anchoredPosition(anchor, bounds, el);
    // 收敛：摆正之后 want === pos，不会来回
    if (Math.abs(want.x - pos.x) > 1 || Math.abs(want.y - pos.y) > 1) commit(want);
  };

  useEffect(() => { reconcileRef.current?.(); });

  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => reconcileRef.current?.());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 容器尺寸变了（窗口缩放 / 侧栏开合）要把跑到界外的工具条拉回来
  useEffect(() => {
    const bounds = boundsRef?.current;
    const el = elRef.current;
    if (!bounds || !el) return;
    const fix = () => {
      const maxX = Math.max(0, bounds.clientWidth - el.offsetWidth);
      const maxY = Math.max(0, bounds.clientHeight - el.offsetHeight);
      if (pos.x > maxX || pos.y > maxY) {
        commit({ x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) });
      }
    };
    const ro = new ResizeObserver(fix);
    ro.observe(bounds);
    return () => ro.disconnect();
  }, [boundsRef, pos.x, pos.y, commit]);

  if (!groups.length) return null;

  return (
    <div
      ref={elRef}
      data-floating-toolbar={id || ''}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => { hoverRef.current = true; clearTimeout(hideTimer.current); setRevealed(true); }}
      onPointerLeave={() => { hoverRef.current = false; if (effAutoHide) scheduleHide(); }}
      style={{
        position: 'absolute', left: pos.x, top: pos.y,
        zIndex: zIndex ?? (panel?.zIndex || 400),
        display: 'flex', flexDirection: stack, alignItems: 'center', gap: GAP.xs,
        /**
         * 排不下就折行：**不给横向滚动**（整站在手机上只该上下滑）。
         * 按钮一律不缩 —— 触屏上 30px 已经是下限，再小就点不准了。
         *
         * ⭐ 08-29 从「窄屏才折」改成「dock 着就许折」。病根是判据量错了对象：
         * narrow 问的是**视口**宽不宽，而真正约束它的是**它 dock 进的那个容器**。
         * 平板上聊天卡一开，画布容器收到 422，工具栏 584 宽照旧不折，直接怼出
         * 容器压在卡上（真机量到：容器 0..422，工具栏 0..584）。
         *
         * ⛔ 这条不能用 JS 量：一量就震荡 —— 折行后 offsetWidth 变小 → 判定"不挤了"
         * → 取消折行 → 又变宽 → 再折。所以把判断交给 CSS：maxWidth 卡住容器，
         * flexWrap 只在真放不下时生效，放得下就是个 no-op。桌面因此一个像素不变。
         */
        ...(dock || narrow
          ? { flexWrap: 'wrap', justifyContent: 'center', maxWidth: `calc(100% - ${DOCK_INSET * 2}px)` }
          : null),
        cursor: dock ? 'default' : (dragging ? 'grabbing' : 'grab'),
        userSelect: 'none', touchAction: 'none',
        // 拖拽中略透，让底下的内容还看得见落点
        opacity: dragging ? 0.88 : (revealed ? 1 : 0),
        // 收起时往下沉一点点：出现/消失是"从边上滑出来"，不是硬闪
        transform: revealed ? 'translateY(0)' : `translateY(${dock ? 14 : 0}px)`,
        // 收起时不吃指针，否则画布底部一条永远点不到
        pointerEvents: revealed ? 'auto' : 'none',
        transition: 'opacity 220ms ease, transform 220ms cubic-bezier(0.32,0.72,0,1)',
        visibility: (placed && (dock ? !!dockPos : true)) ? 'visible' : 'hidden',
        ...style,
      }}
    >
      {/* ⚠️ 判据要带上 `node` 组：只看 items.length 的话，`node` 逃生口
          （站点的「上线」控件）会被整个过滤掉 —— 加了工具却不显示，不报错。 */}
      {groups.filter(g => g && (g.node || g.items?.length)).map(g => (
        <ToolGroup key={g.id} group={g} />
      ))}
      {/* 图钉：跟其他组同一种墨面容器，永远排在最末 —— 它管的是这条工具栏
          自己，不跟内容组抢位置 */}
      {/* 触屏上本来就不自动收，图钉没有意义，还白占一格（手机上格外贵） */}
      {pinnable && autoHide && !coarse && (
        <ToolGroup group={{
          id: '_pin',
          variant: 'plain',
          items: [{
            id: 'pin', icon: Pin, active: pinned,
            title: pinned ? '取消固定（贴近底边才浮现）' : '固定工具栏（常驻可见）',
            onClick: togglePin,
          }],
        }} />
      )}
    </div>
  );
}

function ToolGroup({ group }) {
  /**
   * 逃生口：`node` 组直接放一段自己的 JSX（站点的「上线」控件走这条）。
   *
   * 容器跟别的组**一模一样**（墨面 + 同样的圆角内衬）。一度给它单独套过纸色
   * 底，想省下重写配色的功夫 —— 结果一条工具栏上两种物料，看着就是没做完。
   * 内容自己按 INK_SURFACE 配色，这里不给它特殊待遇。
   */
  if (group.node) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center',
        background: INK_SURFACE.bg,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderRadius: 14,
        // 与图标组同高：内衬 4 + 内容撑到一颗按钮的高度（TOOL_BTN.height）。原来只包着文字的
        // 自然高度，地址读数 / 站点「上线」控件那一格比旁边的按钮组矮一截（2026-08-22 用户报）
        padding: `4px ${GAP.sm}px`,
        minHeight: TOOL_BTN.height,
        boxSizing: 'content-box',
        boxShadow: INK_SURFACE.shadow,
      }}>
        {group.node}
      </div>
    );
  }

  const isMode = group.type === 'mode';
  // 有文字的默认给每颗按钮描一圈（参考图上排那样），纯图标的不描
  const boxed = group.variant
    ? group.variant === 'boxed'
    : group.items.some(it => it.label);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: boxed ? GAP.xs : 2,
      background: INK_SURFACE.bg,
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      borderRadius: 14,
      padding: boxed ? `${GAP.xs}px ${GAP.sm}px` : 4,
      boxShadow: INK_SURFACE.shadow,
    }}>
      {group.items.map(it => (
        <ToolbarButton
          key={it.id}
          dataId={it.id}
          btnRef={it.btnRef}
          icon={it.icon}
          label={it.label}
          title={it.title}
          disabled={it.disabled}
          boxed={boxed}
          // 模式组的选中由组的 value 定；动作组里也有"亮着"的（Tweaks 面板开着、
          // 缩放正处于自适应），那种自己报 active
          active={isMode ? group.value === it.id : !!it.active}
          onClick={() => (isMode ? group.onChange?.(it.id) : it.onClick?.())}
        />
      ))}
    </div>
  );
}
