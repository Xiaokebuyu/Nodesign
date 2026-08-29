/**
 * 触屏上的阅读导航 —— 开局取景 + 翻件（2026-08-28 移动端第二轮）
 *
 * 这个文件装着一件事的两半：`useReadingNav` 决定「镜头该看哪」，
 * `ReadingPager` 是它露在屏幕上的那对箭头。两半共用同一份阅读序，所以住一起。
 *
 * ## 为什么手机上需要这整套
 *
 * 无限画布在桌面上不需要导航：1600 宽的屏在 100% 下一眼看得见好几件，眼睛自己
 * 会挑。手机上一屏装不下一件（390 宽的屏 vs 450 宽的板书），画布退化成**透过
 * 纸筒看画** —— 而纸筒必须有把手，否则用户在一张无限大的纸上凭手指盲滑找东西，
 * 找不到就以为"东西没了"。
 *
 * 真跑量到的起点（exp 上一个 17 件的板，iPhone 13 模拟）：**只有 3 件在视野内**，
 * 而且相机停在世界原点，那儿通常什么都没有。
 *
 * ## 开局取景：等内容到齐，对准最近写出来的那件
 *
 * BoardCanvas 里那条「开局框一次景」在手机上等于没有 —— 它在挂载那一刻跑、
 * 那时内容还没到（这是**有意的**，见那边的注释：等第一批就框会把文件夹顶出
 * 视口）。触屏档另走一条：不设死线地等，等到有东西了再对准。
 *
 * ⚠️ 内容分两批到（文件夹一批、产物一批）。这条不怕它：我们框的是**一件**不是
 * 并集，第二批到货只可能让"最近那件"换个人，换过去仍然是对的。所以开一个
 * settle 窗口（首次取景后 2.5s）允许改主意，窗口一过彻底交还镜头。
 *
 * ⚠️ **开局这一镜不写 force**：flyToBox 自带「用户接管后 8s 内不抢镜头」那道门，
 * 而触屏手势本来就在 noteTakeover。用户一落手指我们就该闭嘴，哪怕这一镜还没来
 * 得及。翻件那两下则要 force —— 那是用户自己按的。
 *
 * ## 形态：**并进工具栏，不另起一条**
 *
 * 第一版是块浮在底部居中的纸片 —— 真机上当场撞车：工具栏也在底部居中，两条
 * 各画各的，翻页器整个被压在工具栏底下（量到 y 605-652，工具栏占 524-646）。
 * ⭐ 两条底部居中的条撞在一起是**版面问题不是位置问题**，挪几个像素只是把撞车
 * 推迟到下一次有人往工具栏里加东西。所以走工具栏自带的 `node` 组逃生口（漏斗和
 * 站点「上线」控件走的同一条），配色一律 INK_SURFACE —— 一条工具栏上两种物料
 * 看着就是没做完，那条规矩记在 FloatingToolbar 的 ToolGroup 头上。
 *
 * ⚠️ 命中区 40px 宽 —— 08-21 记过「按钮一律不缩，30px 是触屏下限」，翻页是高频
 * 动作，给到 40（再宽这一格就把工具栏挤折行了，那是这一轮正在消灭的东西）。
 */
import { useMemo, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { INK_SURFACE } from '../../lib/paper.js';
import { TOOL_BTN } from '../ui/ToolbarButton.jsx';
import { objectRects } from '../../lib/board-rects.js';
import { useDeviceEnv, isTouchLane } from '../../lib/device-class.js';
import { latestItem, readingOrder, readFocusOpts, stepItem, currentIndex } from '../../lib/board-reading.js';

/**
 * 开局取景的「改主意」窗口。短了会框到只有一半内容的板上，长了会在用户已经开始
 * 滑的时候把镜头抢回去 —— 后者更难受，所以宁可偏短。
 */
const OPENING_SETTLE_MS = 2500;

const HIT = 40;

export function useReadingNav({ camApiRef, camera, cam, visibleObjects, layout, sheets = null }) {
  const deviceEnv = useDeviceEnv();
  const touchLane = isTouchLane(deviceEnv.class);

  /** 阅读序：开局取景和翻件共用一份（桌面不算，省一次遍历）。
   *  纸范式（2026-08-29）：板上有纸就**翻纸**（一张纸 = 一页，纸≈一屏正是页的
   *  定义），没有纸才逐件翻（旧板/散件兜底）。 */
  const readOrder = useMemo(() => {
    if (!touchLane) return [];
    const sheetRects = Object.entries(sheets || {})
      .map(([id, s]) => ({ id: `sheet:${id}`, x: s.x, y: s.y, w: s.w, h: s.h, at: s.at || '' }));
    return readingOrder(sheetRects.length ? sheetRects : objectRects(visibleObjects));
  }, [touchLane, visibleObjects, sheets]);

  // readStep 要是个稳定引用（工具栏那族 memo 靠它别每帧换身份），所以走 ref 转手
  const readOrderRef = useRef(readOrder);
  readOrderRef.current = readOrder;
  const deviceClassRef = useRef(deviceEnv.class);
  deviceClassRef.current = deviceEnv.class;

  const openingRef = useRef({ done: false, aimed: '', firstAt: 0 });
  useEffect(() => {
    if (!touchLane || !camera.viewport.w) return;
    const st = openingRef.current;
    if (st.done) return;
    // 有纸对准最新铺的那张（登记时间），没纸对准最新写出的那件
    const sheetIds = Object.keys(sheets || {});
    const target = sheetIds.length
      ? readOrder.filter(r => String(r.id).startsWith('sheet:'))
        .sort((a, b) => String(a.at).localeCompare(String(b.at))).pop() || null
      : latestItem(Object.keys(layout), readOrder);
    if (!target) return;                        // 内容还没到，继续等（不设死线）
    if (target.id === st.aimed) return;
    if (st.firstAt && Date.now() - st.firstAt > OPENING_SETTLE_MS) { st.done = true; return; }
    st.aimed = target.id;
    st.firstAt = st.firstAt || Date.now();
    camApiRef.current?.flyToBox(target, readFocusOpts(deviceEnv.class));
  }, [touchLane, readOrder, layout, camera.viewport.w, deviceEnv.class, camApiRef]);

  /** 读到第几件（翻页器印的那个数）—— 跟着相机走，飞行途中也在变 */
  const readIndex = useMemo(() => (touchLane && readOrder.length
    ? currentIndex(readOrder, {
      x: camera.viewport.w / 2 / cam.z - cam.x,
      y: camera.viewport.h / 2 / cam.z - cam.y,
    })
    : -1), [touchLane, readOrder, cam, camera.viewport.w, camera.viewport.h]);

  const readStep = useCallback((dir) => {
    const api = camApiRef.current;
    const vp = api?.viewport;
    if (!api || !vp?.w) return;
    const c = api.camRef.current;
    const center = { x: vp.w / 2 / c.z - c.x, y: vp.h / 2 / c.z - c.y };
    const next = stepItem(readOrderRef.current, center, dir);
    if (!next) return;
    api.noteTakeover();
    api.flyToBox(next, { force: true, ...readFocusOpts(deviceClassRef.current) });
  }, [camApiRef]);

  /**
   * 直接当一个工具栏组递出去（`node` 逃生口）。桌面 / 只有一件时回 null，
   * 而 FloatingToolbar 的组判据本来就在过滤空组。
   */
  const readGroup = useMemo(() => (touchLane && readOrder.length > 1
    ? { id: 'reading', node: <ReadingPager index={readIndex} total={readOrder.length} onStep={readStep} /> }
    : null), [touchLane, readOrder.length, readIndex, readStep]);

  return { deviceEnv, touchLane, readOrder, readIndex, readStep, readGroup };
}

function Arrow({ dir, disabled, onClick, label }) {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-board-action
      data-reading-pager={dir < 0 ? 'prev' : 'next'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        width: HIT, height: TOOL_BTN.height, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: 'none', padding: 0,
        borderRadius: TOOL_BTN.radiusIcon,
        color: disabled ? INK_SURFACE.textDim : INK_SURFACE.text,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon size={20} />
    </button>
  );
}

export default function ReadingPager({ index, total, onStep }) {
  const at = index >= 0 ? index + 1 : 1;
  return (
    <div data-reading-pager="bar" style={{ display: 'flex', alignItems: 'center' }}>
      <Arrow dir={-1} disabled={at <= 1} onClick={() => onStep(-1)} label="上一件" />
      <span style={{
        minWidth: 38, textAlign: 'center',
        fontSize: TOOL_BTN.fontSize, letterSpacing: '0.02em',
        color: INK_SURFACE.text, whiteSpace: 'nowrap', userSelect: 'none',
      }}>{at}/{total}</span>
      <Arrow dir={1} disabled={at >= total} onClick={() => onStep(1)} label="下一件" />
    </div>
  );
}
