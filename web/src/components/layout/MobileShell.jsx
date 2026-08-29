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
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import { CHROME, COLOR, GAP, FONT_SIZE, RADIUS } from '../../lib/theme.js';
import { GRAIN } from '../../lib/paper.js';

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
export function MobileTopBar({ breadcrumb = [], actions, onMore = null }) {
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
  const up = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;

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
        aria-label={up ? `回到${up.label}` : '上一层'}
        title={up ? `回到${up.label}` : '上一层'}
        disabled={!up?.onClick}
        onClick={() => up?.onClick?.()}
        style={{
          width: 36, height: 36, flexShrink: 0, borderRadius: RADIUS.md,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', padding: 0,
          color: CHROME.ink2, opacity: up?.onClick ? 1 : 0.28,
          cursor: up?.onClick ? 'pointer' : 'default',
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
