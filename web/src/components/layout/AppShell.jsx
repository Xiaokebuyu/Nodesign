import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { COLOR } from '../../lib/theme.js';
import EdgeTab, { TAB_LEN } from '../ui/EdgeTab.jsx';
import { useMedia, COARSE } from '../../lib/use-media.js';
import { useDeviceClass, isTouchLane } from '../../lib/device-class.js';
import { useKeyboardInset, useKeepFocusAboveKeyboard } from '../../lib/use-keyboard-inset.js';
import TopBar from './TopBar.jsx';
import { MobileTopBar } from './MobileShell.jsx';

/**
 * AppShell — 整站外壳：顶栏 + 主内容
 *
 * 两种排布：
 *
 * - **默认（首页 / 橱窗 / 控制台）**：顶栏占一行，内容在它下面。这些页面
 *   本来就是从上往下读的，顶栏是版面的一部分。
 *
 * - **`overlayTop`（工作台）**：顶栏**浮在内容之上**，内容吃满整个视口高度，
 *   鼠标离开顶部就淡出。工作台的内容是一整块画布，横带越少越好。
 *
 *   为什么必须是"浮在上面"而不是"收起时高度变 0"：顶栏一旦参与布局，
 *   收起/展开就会改变画布容器的高度 —— 相机的可视区跟着变，contain 约束
 *   重算，**画面会跳**。浮起来之后画布高度是恒定的 100vh，顶栏来去只是
 *   一层透明度，画布一个像素都不动。
 */

/**
 * 鼠标进到离顶部这么近就唤出顶栏。
 *
 * **只留很薄一条（10px）**：一开始给的是 56（顶栏自己的高度），结果是画布最上面
 * 那一条被顶栏偷走了 —— 那儿要是摆着一个文件夹，鼠标一凑过去顶栏就浮出来盖住它，
 * 点下去点到的是 logo。「接近」应该是"贴到屏幕边上"这个明确动作，不是"往上面走"。
 */
const REVEAL_ZONE = 10;
/** 移开之后再等这么久才淡出（免得贴着边界抖动） */
const HIDE_DELAY = 600;
/**
 * 右上角让路的宽度。文件夹窗的关闭叉钉在那儿（窗 inset 8/10 + 30px 顶栏，
 * 叉子落在 y 8~38），鼠标去够它的路上会扫过顶部那条感应带，顶栏浮出来正好
 * 盖住它 —— 2026-08-17 试用反馈 issue #1 第 4 条。
 *
 * 产物窗走的是 `topSuppressed`（整条不浮现），文件夹窗不能那么办：顶栏上的
 * 面包屑**只在文件夹窗开着时才有内容**，收掉顶栏等于把换层的那个入口一起删了。
 * 所以这里只让开右边这一段。
 */
const CORNER_SAFE_W = 160;

export default function AppShell({
  breadcrumb, actions, children, overlayTop = false,
  /**
   * 有东西铺满屏幕时（产物窗开着），顶栏**连浮现都不要**。
   *
   * 感应带只有 10px，本来不该碍事 —— 但产物窗的关闭钮就在右上角，鼠标去够它
   * 的路上必然扫过顶部那条，顶栏浮出来正好盖住它（2026-08-13 用户报的）。
   * 顶栏管的是"这个项目"，窗开着的时候那一层根本不是当前上下文。
   */
  topSuppressed = false,
  /** 右上角有别人的关闭钮：感应带在那一段让路（顶栏本身照旧可用） */
  topRightSafe = false,
  /** 触屏档那颗 ‹ 的动作。给了就盖过「面包屑上一级」（调用方知道哪一层在最里面） */
  onBack = null,
}) {
  /**
   * 触屏档走另一条（2026-08-29 外壳第一刀）：**常驻窄条，没有 hover 这回事**。
   *
   * 下面那整套（10px 感应带 / 600ms 自动收 / 顶缘小舌头）都是为鼠标写的。
   * 08-21 给手指补了枚小舌头当权宜，但「要先找到并点开一个 26px 的贴纸，才能
   * 看见自己在哪」不是设计。手机上不该有要唤出的东西 —— 它只有 44px 高，
   * 比桌面那条还省 12px，本来就没必要藏。
   *
   * ⚠️ 提前 return 在所有 hook 之后 —— 这条 return 上面不许再加 hook。
   */
  const deviceClass = useDeviceClass();
  /**
   * 键盘覆盖模式的兜底那一层（2026-08-31）：正在打字的框被键盘压住了就滚出来。
   * 挂在这儿是因为三条 return 都经过它，而且它对桌面是纯 no-op（没有 visualViewport
   * 变化就永远 inset = 0）。抽屉那种自己知道该抬多少的容器不吃这条，各抬各的。
   */
  const { inset: keyboardInset } = useKeyboardInset();
  useKeepFocusAboveKeyboard(keyboardInset);
  // 回首页那一步由这层给：版面件不认识路由（MobileShell 的契约），而这层本来就活在路由里
  const navigate = useNavigate();
  const touch = isTouchLane(deviceClass);
  const [revealed, setRevealed] = useState(true);
  /**
   * 小舌头钉住的（2026-08-21）。
   *
   * 顶栏原来只认 hover 屏顶 10px —— 触屏上没有 hover，等于面包屑/导出/登出/换项目
   * 全都够不着（真机档实测：怎么点都不出来）。于是顶缘正中长一枚同族的贴纸，
   * 点一下把顶栏拉下来。**必须是独立的一个状态**：只把 revealed 置 true 的话，
   * 600ms 的自动收计时器立刻把它收回去，点了等于没点。
   */
  const [stuck, setStuck] = useState(false);
  /** 小舌头只长在手指设备上：桌面 hover 屏顶就出来，不需要一个常驻小块 */
  const coarse = useMedia(COARSE);
  const hostRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!overlayTop || touch) return undefined;   // 触屏档没有 hover 可听
    if (topSuppressed) { clearTimeout(timerRef.current); setRevealed(false); return undefined; }
    const schedule = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setRevealed(false), HIDE_DELAY);
    };
    /**
     * 指针是不是落在顶栏自己（或它撑开的菜单）身上。菜单都是顶栏的后代，
     * 所以这一条同时管住了"菜单开着别把顶栏收走"。
     */
    const overTopBar = (t) => !!t?.closest?.('[data-top-bar]');
    const inSafeCorner = (e) => topRightSafe && e.clientX >= window.innerWidth - CORNER_SAFE_W;
    const onMove = (e) => {
      // 手就在顶栏上：清掉计时器。少这一条的话，鼠标停在顶栏上不动满 600ms，
      // 它会被计时器从手底下收走 —— 原来那版的判据只有 clientY<=10，
      // 于是"指针在顶栏上"和"该收起来了"是同一个分支。
      if (overTopBar(e.target)) {
        clearTimeout(timerRef.current);
        setRevealed(true);
        return;
      }
      if (e.clientY <= REVEAL_ZONE && !inSafeCorner(e)) {
        clearTimeout(timerRef.current);
        setRevealed(true);
      } else {
        schedule();
      }
    };
    // 键盘 tab 进顶栏也得看得见（收起态只是透明，里面的元素仍然可聚焦）
    const onFocusIn = (e) => {
      if (!overTopBar(e.target)) return;
      clearTimeout(timerRef.current);
      setRevealed(true);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('focusin', onFocusIn);
    schedule();
    return () => {
      clearTimeout(timerRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [overlayTop, topSuppressed, topRightSafe, touch]);

  if (!overlayTop) {
    /*
     * ⭐ 顶栏在滚动容器**外面**：这一层 100dvh 定高，顶栏占掉自己那 56，剩下的
     * 全给下面那个 overflow:auto 的容器 —— 页面滚的从来不是文档，是它。所以
     * 顶栏不参与滚动，也就不存在"滑着滑着顶栏没了"。
     *
     * ⚠️ 高度必须是 **100dvh 不是 100vh**（2026-08-31 改）。vh 取的是**地址栏
     * 收起时**那个最大高度，手机上地址栏展开时 100vh 比看得见的部分高 60-90px，
     * 底部那一截长期落在屏幕外。触屏工作台那条 08-29 就用了 dvh，这条漏了。
     * ⛔ 08-31 给 html/body 上了 overflow:hidden 之后这条从"能滑出来看"变成
     *    "永远看不到"，两条必须一起改。
     */
    return (
      <div className="nd-shell" style={{ display: 'flex', flexDirection: 'column', background: COLOR.bg, overflow: 'hidden' }}>
        <TopBar breadcrumb={breadcrumb} actions={actions} />
        {/* overscrollBehavior: contain —— 滚到头那下回弹留在这个容器里，不往文档传
            （文档那层还有 body position:fixed 兜底，这条是让回弹发生在**对的地方**） */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
      </div>
    );
  }

  /**
   * 触屏档：窄条参与布局（不浮起）。
   *
   * ⚠️ 桌面那条必须浮起来是因为「顶栏一参与布局，收展就改画布容器高度 → 相机
   * 可视区变 → 画面跳」。这儿不犯那个病的前提是**它永不收展** —— 所以触屏档
   * 里 `topSuppressed` 一律不认：
   *
   *   ① 认了它，产物窗一开条就没了、画布长高 44、相机当场跳，正是桌面那版
   *      费劲绕开的病；
   *   ② 手机上这条**就是退路**。桌面收掉顶栏无所谓（窗自己右上角有叉，鼠标够
   *      得到），手机上把唯一的返回入口跟着窗一起收掉，用户就困在那扇窗里了。
   *
   * 不冲突：窗渲染在下面那个 flex 子里，跟条是上下关系不是叠压关系，条压不着
   * 它的关闭钮 —— 桌面那条让路的理由（CORNER_SAFE_W / topRightSafe）在这儿
   * 整个不成立。
   *
   * 高度用 100dvh 不是 100vh：移动浏览器的地址栏收展会改可视高度，vh 是「最大
   * 那个」，用它会让底部 60-90px 长期落在屏幕外（工具栏和抽屉都在那儿）。
   */
  if (touch && overlayTop) {
    return (
      <div className="nd-shell" style={{ display: 'flex', flexDirection: 'column', background: COLOR.bg, overflow: 'hidden' }}>
        <MobileTopBar breadcrumb={breadcrumb} actions={actions} onBack={onBack} onHome={() => navigate('/')} />
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{children}</div>
      </div>
    );
  }

  const shown = !topSuppressed && (revealed || stuck);

  return (
    <div ref={hostRef} className="nd-shell" style={{ position: 'relative', background: COLOR.bg, overflow: 'hidden' }}>
      {/* 内容吃满整屏。顶栏来去不改它一个像素 —— 这是整件事的重点 */}
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>

      {/*
        外层只做**位移**，透明度和吃不吃指针交给两个孩子各自声明。
        这样小舌头才能挂在 `top:100%` 上：外层平移 -100%（= 顶栏高度）时，
        舌头正好落在 y=0 贴着屏顶；顶栏落下来它就跟着长在顶栏下沿。
        ⭐ 一个数都不用量 —— 顶栏多高，舌头就跟着走多远。
      */}
      <div
        data-top-bar
        onPointerEnter={() => setRevealed(true)}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          // 顶栏之上还有浮窗层（聊天栏 z≈120）；顶栏要压得住它，
          // 否则唤出来的顶栏被聊天栏盖掉一半
          zIndex: 900,
          transform: shown ? 'translateY(0)' : 'translateY(-100%)',
          pointerEvents: 'none',
          transition: 'transform 260ms cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        <div style={{
          opacity: shown ? 1 : 0,
          // 收起时整条不吃指针，否则画布顶部一条永远点不到
          pointerEvents: shown ? 'auto' : 'none',
          transition: 'opacity 220ms ease',
        }}>
          <TopBar breadcrumb={breadcrumb} actions={actions} />
        </div>
        {coarse && !topSuppressed && (
          <EdgeTab
            edge="top"
            open={shown}
            title={shown ? '收起顶栏' : '打开顶栏'}
            onClick={() => setStuck(s => !s)}
            style={{ top: '100%', left: '50%', marginLeft: -TAB_LEN / 2, pointerEvents: 'auto' }}
          />
        )}
      </div>

      {/* 收起时贴顶的一条感应带：鼠标扫到就唤出（pointermove 已经能唤，
          这层是给"从窗口外面直接滑进来"那种不产生 move 事件的情况兜底）。
          右端跟 onMove 一样让开关闭钮那一段，否则这层会把让路绕过去。 */}
      {!shown && !topSuppressed && (
        <div
          onPointerEnter={() => setRevealed(true)}
          style={{
            position: 'absolute', top: 0, left: 0,
            right: topRightSafe ? CORNER_SAFE_W : 0,
            height: REVEAL_ZONE, zIndex: 899,
          }}
        />
      )}
    </div>
  );
}
