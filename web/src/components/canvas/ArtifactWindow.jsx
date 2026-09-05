import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDeviceClass } from '../../lib/device-class.js';
import { PAPER, PAPER_SHADOW, GRAIN, INK_SURFACE, pinFill } from '../../lib/paper.js';
import { COLOR, GAP, FONT_SANS, FONT_SIZE, RADIUS } from '../../lib/theme.js';
import { POP_IN } from '../../lib/board-geometry.js';
import { exportItemsFor } from '../../lib/export-formats.js';

/**
 * ArtifactWindow —— 三种产物共用的那扇窗（2026-08-07；2026-08-13 改成装订文件）
 *
 * 在这之前 deck / 站点 / 世界 是三个各长各样的东西：deck 是压暗背景 + 内缩的
 * 最大化窗、顶着一条 44px 的 CanvasToolbar；站点是铺满、40px 窗口头 + 30px
 * 地址栏 + 提示条三层；世界压根不是窗，只是画布卡片展开后内嵌的一块地图。
 * 同一个动作（打开一件产物看/改）长出三种外观，用户每换一种形态就要重新找
 * 一遍「关闭在哪、模式切换在哪、刷新在哪」。
 *
 * 现在的外壳 —— **一张钉在板上的大纸**，跟首页那些项目卡是同一套物料
 * （纸色 + 颗粒 + 单光向影子 + 直角）：
 *
 *   压暗层（点=关）
 *   └ 纸（inset 8/10，几乎铺满）
 *     ├ 顶栏（30px）：钉纽扣 · 这是什么 · 关闭
 *     ├ 固定条（headerExtra / banner）
 *     └ 内容区
 *       └ children
 *
 * 工具栏不在这里 —— 全项目只有一条，活在 CanvasFrame，内容跟焦点走。
 *
 * ## 为什么工具要浮起来
 *
 * 固定工具栏是按"最宽的那一种"占高度的：deck 44px + 站点 40+30+提示条，
 * 内容区被永久切掉一条，而那些按钮大部分时候你并不在用。浮起来之后
 * 内容拿到整扇窗，工具想放哪放哪（挡住了就拖开），三种窗共用同一个容器组件。
 *
 * ## 2026-08-13 的两次改动，第二次推翻了第一次的一半
 *
 * 先把 34px 的名牌条整个拆了（工具搬走之后它只剩身份和关闭，不值一整条），
 * 窗做成左缘带订口的"装订文件"。用户看完的评价是**丑，而且跟设计语言不合**
 * —— 全站是直角纸质卡片，装订那套线迹是另一个物料世界的东西。
 *
 * 所以回到纸：外壳照首页项目卡那张纸做（纸色 + 颗粒 + PAPER_SHADOW + 直角），
 * 顶上留一条**很窄**的顶栏装身份和关闭，正中钉一枚纽扣。inset 保持 8/10 ——
 * "内容吃满"那半是对的，留下了。
 *
 * ## 关闭钮为什么不跟着工具条跑
 *
 * 它是唯一一个"必须永远在同一个地方"的控件 —— 找不到关闭的窗口是能把人
 * 困住的。所以它钉死在顶栏右端，只有工具进浮动工具栏。
 *
 * ⚠️ 放右边是用户 2026-08-13 拍的板（聊天栏之后要改位置）。在聊天栏挪走
 * 之前，右上角**可能被它压住** —— ESC 和点压暗层是活的退路。原来在左的
 * 理由记在这儿备查：聊天栏默认贴右浮在窗上面，左边是唯一一块浮窗默认
 * 不去的地方。
 */

/**
 * 窗在画布之上、浮窗层之下。
 *
 * 「之下」是刻意的：聊天栏要能压在打开的产物上面，不然看着 deck 就没法跟
 * agent 说话，而那是这个工具的全部意义。靠的是 ProjectWorkspace 里画布
 * section 的 `isolation:'isolate'` —— 窗关在那个层叠上下文里出不来，
 * 外面的浮窗层永远在上。
 */
export const ARTIFACT_WINDOW_Z = 500;

/** 顶栏高度。只装身份和关闭，越窄越好 —— 内容才是主角 */
const CHROME_H = 30;
/**
 * 手机（2026-09-06）：窗不再钉在画布 section 里，**portal 到 body、整屏、盖过一切**（顶条 / 对话抽屉 / 工具栏）。
 * 理由：手机上画布只是一根纸筒，窗要是还留在 section 里，8/10 的 inset 和 z=500 会让它被 MobileShell 的抽屉（z 120）
 * 和 AppShell 顶栏压住、四边还漏着一圈画布。站主：「让其在最外层打开，浮于所有内容上方」。板书退役为主要载体之后，
 * 手机上那套限制（不开产物）的前提也没了。顶条 44 高、关闭钮 40 命中（08-21：触屏按钮不缩），吃安全区。
 */
const PHONE_CHROME_H = 44;
const PHONE_Z = 2000;

/**
 * 手机上这扇窗自己的工具条：一条钉在底边、横向可滑的按钮带（外层那条常驻 FloatingToolbar 被盖在窗底下了）。
 * 不浮：浮着会压住窗里自己的输入框（09-06 演出显示器上真撞过）。演出显示器（kind=stage）不画 —— 它的页签 / 皮肤 / 开始
 * 显示器顶栏里本来就有，再画一遍是重复。
 */
function PhoneToolBar({ groups }) {
  const gs = (groups || []).filter(g => g && (g.node || g.items?.length));
  if (!gs.length) return null;
  return (
    <div data-phone-toolbar style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `6px ${GAP.sm}px`,
      borderTop: `1px solid ${PAPER.hair}`, overflowX: 'auto', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch',
    }}>
      {gs.map((g, gi) => (
        <div key={g.id || gi} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, paddingRight: GAP.sm, borderRight: gi < gs.length - 1 ? `1px solid ${PAPER.hair}` : 'none' }}>
          {g.node ? g.node : g.items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button key={it.id || i} title={it.title || it.label} disabled={it.disabled} onClick={it.onClick}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, height: 36, padding: `0 ${Icon && it.label ? 10 : 12}px`,
                  border: 'none', borderRadius: RADIUS.sm, cursor: it.disabled ? 'default' : 'pointer', flexShrink: 0,
                  background: it.active ? 'rgba(43,33,23,0.10)' : 'transparent', color: it.disabled ? COLOR.sub : COLOR.text,
                  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, whiteSpace: 'nowrap',
                }}>
                {Icon ? <Icon size={15} /> : null}{it.label ? <span>{it.label}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function ArtifactWindow({
  /** 'deck' | 'site' —— 决定工具条位置存在哪个槽位 */
  kind,
  title,
  /** 身份牌上标题右边的小字（站点写当前页，世界写地点/角色计数） */
  subtitle = null,
  onClose,
  /** 工具组（形状见 FloatingToolbar）。**这扇窗不自己渲工具栏**，见下 */
  groups = [],
  /**
   * 把工具组交给外层那条常驻工具栏（2026-08-13 范式改造）。
   *
   * 在这之前每扇窗自己挂一条 FloatingToolbar、画布也挂一条，于是同一屏上可能
   * 有两条、各自算落点、各自持久化位置。用户报过的三件事全出在这个结构上：
   * 「工具栏怎么有两套」「位置没对齐」「偏到右下角」—— 修完一个又冒一个，
   * 因为病根是**同一件东西有多个实例**，不是某一处算错。
   *
   * 现在只有一条：活在 CanvasFrame 里、钉底缘正中、永远显示，
   * **内容跟着当前焦点走** —— 没开窗是画布的工具，开了窗是这扇窗的。
   */
  onToolbarGroups,
  /** 内容区顶上的说明条：怎么用 / 警示。说明不是工具，不进工具栏 */
  banner = null,
  /** 固定条：内容区上方那条一直在的横带（deck 的试作切换） */
  headerExtra = null,
  /**
   * ESC 关窗。**自己有 ESC 优先级的窗要关掉它**（deck 和站点都是「先清选中 /
   * 先站内后退，都没有才关」）—— 两边都挂 window 监听的话，先注册的先跑，
   * 而 React 的 effect 是子先父后，这个壳会抢在窗前面把窗关掉。
   */
  escToClose = true,
  children,
  contentStyle,
}) {
  const contentRef = useRef(null);
  const phone = useDeviceClass() === 'phone';

  // 工具组交给外层那条常驻工具栏；窗一关就撤回（否则关了窗还留着这扇窗的工具）。
  // 手机上窗在 body 里、外层工具栏被盖在底下 → 不上报，工具组由这扇窗自己在底边画一条（见下）。
  useEffect(() => {
    onToolbarGroups?.(phone ? null : groups);
  }, [groups, onToolbarGroups, phone]);

  /**
   * 撤销上报**只在窗真的没了的时候**做（依赖里刻意没有 `groups`）。
   *
   * ⚠️ 原来这两件事写在同一条 effect 里：换 groups 时清理函数先报一个 `null`
   * 再报新值。上游那道签名守卫（CanvasFrame 的 `reportWinGroups`）拦得住
   * "同内容新数组"，**但拦不住 null↔groups 来回跳** —— 于是只要哪个窗的
   * `groups` memo 依赖里混进一个每渲染都新的函数，就是一个无限渲染循环，
   * 而且症状（"Maximum update depth"）指不到任何一方。2026-08-18 真踩到了。
   * 拆开之后，不稳定的 memo 最多多报一次，不再是死循环。
   */
  useEffect(() => () => onToolbarGroups?.(null), [onToolbarGroups]);

  useEffect(() => {
    if (!onClose || !escToClose) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (t?.getAttribute?.('contenteditable') === 'true') return;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, escToClose]);

  const chromeH = phone ? PHONE_CHROME_H : CHROME_H;
  const tree = (
    <div style={phone
      ? { position: 'fixed', inset: 0, zIndex: PHONE_Z, overscrollBehavior: 'contain' }
      : { position: 'absolute', inset: 0, zIndex: ARTIFACT_WINDOW_Z }}>
      <style>{'@keyframes ndDimIn{from{opacity:0}to{opacity:1}}'}</style>
      {!phone && <div
        onClick={onClose}
        title="点击回到工作台"
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(32, 26, 14, 0.4)',
          animation: 'ndDimIn 200ms ease',
        }}
      />}

      {/* 窗 = 一张钉在板上的大纸（物料同首页项目卡：纸色 + 颗粒 + 直角）；手机上铺满整屏 */}
      <div style={{
        position: 'absolute', inset: phone ? 0 : '8px 10px',
        background: PAPER.paper, backgroundImage: GRAIN,
        borderRadius: 0, overflow: 'hidden',
        boxShadow: phone ? 'none' : PAPER_SHADOW.near,
        display: 'flex', flexDirection: 'column',
        animation: phone ? 'ndDimIn 160ms ease' : POP_IN,
        ...(phone ? { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' } : {}),
      }}>
        {/* 顶栏：钉纽扣 · 这是什么 · 关闭。只有这三样，越窄越好。 */}
        <div style={{
          height: chromeH, flexShrink: 0, position: 'relative',
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          padding: `0 ${GAP.xs}px 0 ${GAP.md}px`,
          borderBottom: `1px solid ${PAPER.hair}`,
        }}>
          {/* 钉纽扣：跟首页那些卡是同一枚钉子（同一段渐变、同一个光向）。
              纯装饰，不吃事件 —— 它说明的是"这张纸是被钉上去的"。 */}
          <span aria-hidden style={{
            position: 'absolute', left: '50%', top: 6, marginLeft: -4.5,
            width: 9, height: 9, borderRadius: '50%', pointerEvents: 'none',
            background: pinFill(),
            boxShadow: '-1px 2px 3px rgba(43,33,23,0.45)',
          }} />

          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '32%',
          }}>
            {title}
          </span>
          {subtitle && (
            <span style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            }}>
              {subtitle}
            </span>
          )}

          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="关闭（Esc）"
            data-artifact-close
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
              width: phone ? 'auto' : 24, height: phone ? 40 : 24, padding: phone ? '0 12px' : 0,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, borderRadius: RADIUS.sm, flexShrink: 0,
              border: 'none', background: 'transparent', color: COLOR.sub, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.06)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={phone ? 16 : 14} />{phone ? '关闭' : null}
          </button>
        </div>

        {headerExtra}
        {banner}

        <div
          ref={contentRef}
          style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', ...contentStyle }}
        >
          {children}

        </div>
        {/* 手机：这扇窗的工具组自己画在底边（外层那条常驻工具栏被盖在下面了）；演出显示器有自己的顶栏，不画 */}
        {phone && kind !== 'stage' && <PhoneToolBar groups={groups} />}
      </div>
    </div>
  );
  return phone && typeof document !== 'undefined' ? createPortal(tree, document.body) : tree;
}

/**
 * 说明条。窗内容上方那条浅色提示（怎么用 / 这是构建产物 / 拼贴式版面警告）。
 * 各窗自己拼内容，样式统一在这。
 */
export function WindowBanner({ children }) {
  return (
    <div style={{
      flexShrink: 0, padding: `${GAP.xs}px ${GAP.md}px`,
      display: 'flex', alignItems: 'center', gap: GAP.sm,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
      background: '#fdf8ef', borderBottom: `1px solid ${COLOR.borderLt}`,
    }}>
      {children}
    </div>
  );
}

/** 工具条上的墨色小读数（缩放百分比那种），跟 INK_SURFACE 同一套色 */
export const INK_READOUT = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
  color: INK_SURFACE.text,
};

/**
 * 导出组 —— 三扇窗共用的那一小撮按钮（2026-08-13 从顶栏搬进工具栏）。
 *
 * 顶栏那个下拉是"对当前聚焦的任务导出"，而窗开着的时候当前上下文明明白白
 * 就是这一件产物，还要收起窗去顶栏找一遍是绕路。
 *
 * 格式清单由**服务端**给（`/artifacts` 的 `tasks[].exports`，随 focusDeck 一路
 * 传下来），前端不硬编码 —— 第三种形态上线时这里自动跟上。
 *
 *（导出路由 2026-08-13 已随会话收敛项目化：`Exports.download(pid, format)`，
 * 无会话也能导。老的 sid 形式路由服务端永久保留 —— jsonl 里持久化过绝对 URL。）
 */
export function exportToolGroup({ kind, exports: formats, onExport }) {
  if (!onExport) return null;
  const items = exportItemsFor(kind, formats).map(it => ({
    id: it.id,
    icon: it.icon,
    title: `导出 ${it.label} —— ${it.desc}`,
    onClick: () => onExport(it.id),
  }));
  return items.length ? { id: 'export', items } : null;
}
