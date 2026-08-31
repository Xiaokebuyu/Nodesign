/**
 * MobileShell —— 手机 / 平板的版面件（2026-08-29 移动端第二轮 · 外壳）
 *
 * ## 契约：只管摆位，不持有业务 state
 *
 * ⭐⭐ **逻辑只有一份**。工作台那 2398 行里只有 53 行在决定东西摆在屏幕哪儿，
 * 剩下全是句柄、effect、接线 —— 复刻一份「移动版工作台」等于为了改 53 行版面
 * 复制 2300 行逻辑，而两份逻辑分叉是这个仓库里最贵的一种债。
 *
 * 所以这个文件里的件**一律只收 props、只持有纯版面状态**（哪个面在前台、抽屉
 * 开多高）。凡是「这个项目叫什么」「这条消息发出去没有」这类问题，答案永远在
 * 调用方手里，这儿一个字都不许存。判据在 mobile-shell.lint.test.js。
 *
 * ## 为什么桌面那套在手指上不成立
 *
 * 真身是 AppShell（顶栏 hover 浮起）+ 全屏画布 + ChatDock（贴右缘滑进来的浮卡）。
 * 三件在手机上各有各的坏法：
 *
 *   顶栏   靠 hover 屏顶 10px 唤出 —— 手指没有 hover。08-21 在顶缘正中贴了一枚
 *          小舌头当权宜（点一下拉下来），但「要先找到并点开一个 26px 的贴纸，
 *          才能看见自己在哪」不是设计，是补丁。手机上不该有要唤出的东西。
 *   聊天卡 从右缘滑进来、按 cfg.width 排 —— 而手机上它已经被钳成几乎满宽，
 *          "卡"的形态名存实亡，而且右上角离拇指最远。
 *   一次一面 手机上「退回上一层」是系统级习惯，整站没有。
 *
 * ## 三档怎么分工
 *
 *   手机   常驻窄条 + 一次一面 + 底部抽屉（拇指区）
 *   平板   常驻窄条 + 抽屉不盖满（810 宽放得下画布和抽屉同框）
 *   桌面   原样，一个像素不动
 */
import { useState, useRef, useEffect } from 'react';
import { CANVAS } from '../../lib/theme.js';
import { ChevronLeft, MoreHorizontal, MessageSquare } from 'lucide-react';
import { CHROME, COLOR, GAP, FONT_SIZE, RADIUS } from '../../lib/theme.js';
import { useKeyboardInset } from '../../lib/use-keyboard-inset.js';
import { GRAIN, PAPER, PAPER_SHADOW } from '../../lib/paper.js';

/** 常驻窄条的高度。比桌面顶栏（56）矮 —— 手机上每一行像素都得挣来 */
export const MOBILE_BAR_H = 44;

/**
 * 手机 / 平板的常驻顶条。
 *
 * 收的还是 AppShell 那两个通用入参（breadcrumb / actions），所以它对首页、
 * 工作台、橱窗一视同仁 —— 版面件不认识业务。
 *
 *   ‹      面包屑倒数第二级（有就画，等于「上一层」）
 *   位置   面包屑最后一级（你现在在哪）
 *   ⋯      把 actions 整包收进去 —— 「隐藏复杂操作」在版面上的落点就是这一颗
 *
 * ⚠️ 这条**不许加 overflow: hidden**。actions 里那些下拉全是绝对定位挂在条里的，
 * 一裁就整条看不见（08-21 在桌面顶栏上踩过，表现为「点了没反应」）。
 */
export function MobileTopBar({ breadcrumb = [], actions, onMore = null, onBack = null, onHome = null }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const away = (e) => { if (!moreRef.current?.contains(e.target)) setMoreOpen(false); };
    // 捕获阶段：菜单里的按钮点完自己会关，这层只管点在别处
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [moreOpen]);

  const crumbs = breadcrumb.filter(Boolean);
  const here = crumbs[crumbs.length - 1] || null;
  const upCrumb = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  /**
   * ‹ 的动作，从里往外退：
   *   ① onBack（调用方给的，它知道有没有窗开着 —— 那是最里面那一层）
   *   ② 面包屑上一级
   *   ③ **回首页**
   *
   * ⛔ 08-29 用户报「返回键不可点」时才发现漏了第 ③ 层，而且比"不可点"更糟：
   * 桌面顶栏靠左上角那个 Nodesign 字标回首页，移动条上我把它砍了 —— 于是手机上
   * **进了项目就没有任何回首页的路**（整条只剩 ⋯ 一个能点的）。
   * ⚠️ 退到尽头该是"离开这一页"，不是"灰掉"。手机上一颗永远灰着的返回键，
   * 读起来就是坏了。
   *
   * ⚠️ 这儿**不判断**哪层在最里面、也不认识路由：两者都由调用方递进来
   * （见文件头那条契约）。
   */
  const back = onBack || upCrumb?.onClick || onHome || null;
  const backLabel = onBack ? '返回'
    : upCrumb ? `回到${upCrumb.label}`
      : onHome ? '回到项目列表' : '上一层';

  return (
    <header
      data-top-bar
      data-mobile-bar
      style={{
        height: MOBILE_BAR_H,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        boxSizing: 'content-box',
        flexShrink: 0,
        background: CHROME.bg,
        backgroundImage: GRAIN,
        borderBottom: `1px solid ${CHROME.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `0 8px`,
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 4px rgba(93,74,44,0.10)',
        position: 'relative',
        zIndex: 3,
      }}
    >
      <button
        type="button"
        aria-label={backLabel}
        title={backLabel}
        disabled={!back}
        onClick={() => back?.()}
        style={{
          width: 36, height: 36, flexShrink: 0, borderRadius: RADIUS.md,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', padding: 0,
          color: CHROME.ink2, opacity: back ? 1 : 0.28,
          cursor: back ? 'pointer' : 'default',
        }}
      >
        <ChevronLeft size={20} />
      </button>

      <span style={{
        flex: 1, minWidth: 0,
        fontFamily: 'inherit', fontSize: FONT_SIZE.lg, fontWeight: 700,
        color: COLOR.text,
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{here?.label || ''}</span>

      <div ref={moreRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          aria-label="更多"
          title="更多"
          onClick={() => (onMore ? onMore() : setMoreOpen((v) => !v))}
          style={{
            width: 36, height: 36, borderRadius: RADIUS.md,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: moreOpen ? 'rgba(43,33,23,0.07)' : 'transparent',
            border: 'none', padding: 0, color: CHROME.ink2, cursor: 'pointer',
          }}
        >
          <MoreHorizontal size={20} />
        </button>
        {moreOpen && actions && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6,
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: GAP.xs,
            padding: GAP.sm,
            background: CHROME.bg,
            backgroundImage: GRAIN,
            border: `1px solid ${CHROME.border}`,
            borderRadius: RADIUS.lg,
            boxShadow: '0 6px 24px rgba(93,74,44,0.22)',
            zIndex: 40,
            // 动作里那些按钮本来是横着排的，收进抽屉后一件一行
            whiteSpace: 'nowrap',
          }}>
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

/** 抽屉的两个停靠档：半开（读得见画布）/ 全开（专心说话） */
export const SHEET_SNAPS = [0.62, 0.94];

/**
 * 底部抽屉 —— 手机上「跟它说话」那一层的容器（2026-08-29）。
 *
 * ## 为什么是从下往上，不是从右边滑进来
 *
 * 桌面那张聊天卡贴右缘、按 hover 贴边召唤。手机上这两条都不成立：右上角离
 * 拇指最远，而卡在窄屏上已经被钳成几乎满宽 —— "卡"的形态名存实亡，实际就是
 * 一层盖住整屏的东西，只是从错误的方向进来。从下往上推才是拇指的方向。
 *
 * ## 拖把手：位移直接跟手，不做惯性
 *
 * 两个停靠档（62% / 94%）。拖过半程就换档，松手回弹到最近的档。
 * ⛔ 不做 fling/惯性：这层里装的是**会滚的消息列表**，抽屉自己再吃一层惯性，
 * 手指往上一滑到底是滚消息还是拉抽屉就成了猜谜。判据放在**起手位置**上 ——
 * 只有把手那 28px 高的区域起手才算拉抽屉，别处一律交给里面滚。
 *
 * ⚠️ 高度用 dvh：地址栏收展改可视高度，用 vh 抽屉底沿会长期落在屏幕外。
 */
export function MobileSheet({ open, onClose, children, label = '对话' }) {
  const [snap, setSnap] = useState(0);
  const dragRef = useRef(null);
  const [dragDy, setDragDy] = useState(0);

  // 关上时回到半开档：下次拉开是个熟悉的高度，而不是上次碰巧停的地方
  useEffect(() => { if (!open) { setSnap(0); setDragDy(0); } }, [open]);

  /**
   * 键盘弹出时把抽屉整个抬到键盘上面（2026-08-31）。
   *
   * ⭐ 抽屉底沿本来贴着屏幕底，而输入框就在抽屉最下面 —— 覆盖模式下键盘直接压在
   * 它身上，而 body 是 position: fixed，浏览器**没法**像以前那样滚一下把它露出来。
   * 所以这里自己抬：`bottom` 让开键盘那一截，高度改按**键盘之上剩多少**算。
   *
   * ⚠️ 没键盘时**照旧走 dvh 那条原路**（一个字都没动）—— 只在 inset > 0 时换算法，
   * 免得为了一个边缘情况把常态也改了。
   */
  const { inset: kb, visibleH } = useKeyboardInset();
  const h = kb > 0
    ? `${Math.round(SHEET_SNAPS[snap] * visibleH)}px`
    : `${SHEET_SNAPS[snap] * 100}dvh`;
  const onDown = (e) => {
    dragRef.current = { y: e.clientY, snap };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragRef.current) return;
    setDragDy(e.clientY - dragRef.current.y);
  };
  const onUp = () => {
    const d = dragRef.current; const dy = dragDy;
    dragRef.current = null; setDragDy(0);
    if (!d) return;
    // 往下拖过 120px：关掉（半开档时）或降一档
    if (dy > 120) { if (d.snap === 0) onClose?.(); else setSnap(d.snap - 1); return; }
    if (dy < -60 && d.snap < SHEET_SNAPS.length - 1) setSnap(d.snap + 1);
  };

  return (
    <>
      {/* 幕：点它收起。抽屉盖住大半屏时，「点外面关掉」是手机上唯一还剩的退路 */}
      <div
        aria-hidden
        onPointerDown={() => open && onClose?.()}
        style={{
          position: 'absolute', inset: 0, zIndex: 119,
          background: 'rgba(24,18,12,0.28)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 220ms ease',
        }}
      />
      <div
        data-mobile-sheet
        role="dialog"
        aria-label={label}
        style={{
          position: 'absolute', left: 0, right: 0, bottom: kb,
          height: h,
          display: 'flex', flexDirection: 'column',
          background: PAPER.paper,
          backgroundImage: GRAIN,
          borderRadius: '14px 14px 0 0',
          boxShadow: PAPER_SHADOW.near,
          zIndex: 120,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          transform: open ? `translateY(${Math.max(0, dragDy)}px)` : 'translateY(101%)',
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: open ? 'auto' : 'none',
          // 拖的时候不要过渡（不然位移追不上手指）；松手和开关走同一条曲线
          transition: dragRef.current
            ? 'none'
            : `transform 240ms cubic-bezier(0.22, 1, 0.36, 1), height 240ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s ${open ? '' : '240ms'}`,
        }}
      >
        {/* 把手：拉抽屉的**唯一**起手区（别处起手一律交给里面滚）。点一下也换档。 */}
        <div
          data-sheet-handle
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onClick={() => setSnap((s) => (s + 1) % SHEET_SNAPS.length)}
          style={{
            height: 28, flexShrink: 0, cursor: 'grab',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            touchAction: 'none',
          }}
        >
          <span style={{
            width: 44, height: 4, borderRadius: 2,
            background: 'rgba(43,33,23,0.22)',
          }} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </>
  );
}

/**
 * 「跟它说话」那颗钮 —— 手机上指挥主 agent 的主入口。
 *
 * 位置在画布工具栏**上方**靠右：工具栏 322 宽居中（390 屏上左右各余 34），
 * 一颗 52 的圆钮塞不进那两条缝，只能上移一行。⚠️ 别往下挪去跟工具栏抢那一行 ——
 * 底部两条东西横向撞车这件事今晚已经踩过一次（翻页器）。
 */
export function TalkFab({ onClick, busy = false, hidden = false }) {
  if (hidden) return null;
  return (
    <button
      type="button"
      data-talk-fab
      aria-label="跟它说话"
      title="跟它说话"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        position: 'absolute', right: 12, zIndex: 118,
        bottom: `calc(66px + env(safe-area-inset-bottom, 0px))`,
        width: 52, height: 52, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: COLOR.btn, color: COLOR.btnText,
        border: 'none', cursor: 'pointer',
        boxShadow: '0 3px 10px rgba(24,18,12,0.28), 0 10px 26px rgba(24,18,12,0.22)',
      }}
    >
      <MessageSquare size={22} />
      {busy && (
        // 在跑：钮上挂一点，不用另开一处状态显示
        <span aria-hidden style={{
          position: 'absolute', top: 6, right: 6,
          width: 8, height: 8, borderRadius: '50%',
          background: CANVAS.brass, boxShadow: '0 0 0 2px rgba(24,18,12,0.35)',
        }} />
      )}
    </button>
  );
}
