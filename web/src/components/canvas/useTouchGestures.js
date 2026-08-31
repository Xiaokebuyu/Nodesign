import { useEffect, useRef } from 'react';
import { ZOOM_MIN, ZOOM_MAX, screenToWorld } from '../../lib/board-camera.js';

/**
 * 画布的触屏手势（2026-08-21）—— 双指捏合缩放 + 双指平移。
 *
 * ## 之前是什么样
 *
 * 桌面那五条平移路（滚轮 / Ctrl+滚轮 / 拖空白 / 中键 / 空格）在手机上一条都用不上：
 * 没有滚轮、没有中键、没有键盘。真机档量过 —— **单指拖空白确实能平移**（走的是
 * 跟鼠标同一条 pointer 路），但缩放完全没有，而且画布一满，空白就没了，
 * 单指落在卡上就是拖卡。所以用户的话是"确认无手势可用"。
 *
 * ## 现在的约定
 *
 * - 单指拖空白    → 平移（老路，没动）
 * - **单指拖卡片  → 也平移**（触屏上"拖卡"这条路整条撤掉，见下）
 * - **双指捏合    → 以两指中点为锚缩放**
 * - **双指拖      → 平移（任何位置）**
 *
 * 合起来等于把桌面上"空格 + 拖"那条万能平移路给了手指：一根手指按在哪儿都能推画面。
 *
 * ## 为什么触屏上不许拖卡，以及怎么关掉的
 *
 * 不只是"手指按不准"。真跑抓到的是：两根手指落在同一张卡上想捏合，第一根手指已经
 * 把拖卡起手了，**捏合结束时那张卡横移了 19px 并且落盘**（PATCH /board 带着新坐标）。
 * 补 `pointercancel` 救不回来 —— 画布那条收尾路是"提交这次拖拽"，不是"当没发生过"。
 *
 * ⛔ 试过在捕获阶段 `stopPropagation()` 掉那次 pointerdown：**没用**，卡照样被挪走
 * 并落盘（对照组：同样的捏合落在空地上，一次写盘都没有）。别再往那条路上修。
 *
 * ✅ 用仓库里现成的那个开关：**抓手态**（`isHandMode()`，本来是"按住空格"）。
 * 拖卡（BoardCanvas 的 onObjectPointerDown）、工作区手势（useZoneGestures）、相机
 * 三方都已经在问这一句了 —— 手指一落下就把它置真，于是拖卡自己让路、相机接管平移，
 * 一行新的平移代码都不用写。**点一下**照旧（click 是浏览器另外生成的），点开卡片没受影响。
 *
 * ⭐ 2026-08-31：`handRef` 置真这件事本身没变，**变的是相机认不认它** ——
 * 只有手机认（useBoardCamera 的 fingerPansAnywhere）。平板上单指归当前工具，
 * 相机走两指那条路。这里一个字都不用改，因为两指那条路从来不问抓手态。
 *
 * ## 两个必须这么写的地方
 *
 * 1. ⭐**监听挂在捕获阶段的原生事件上，不走 React 的 props。**
 *    画布那边 pointerdown 是按优先级分派的（工具 → 框选 → 相机），相机常常压根
 *    收不到第二根手指（比如它落在卡片上）。要认出"现在有两根手指"，只能在所有人
 *    之前看一眼。捕获阶段 `stopPropagation()` 同时也把这次 move 从 React 那条路上
 *    摘掉了 —— 手势期间画布不该再同时拖卡。
 *
 * 2. ⭐**第二根手指落下时，给已经在进行的那一下补一个 `pointercancel`。**
 *    第一根手指可能已经起了一笔涂鸦 / 一个框选 / 一次拖卡。画布本来就接着
 *    `onPointerCancel`（一条现成的收尾路，四个收尾各自都在里面），补一条合成事件
 *    就够了 —— 不用为这件事再开一个新接口，也不用往 BoardCanvas 里加代码。
 *    自己发的事件 `isTrusted` 是 false，下面每个处理器都靠它把自己发的那份排掉。
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 手势结束之后这么久内的 click 一律吞掉（松手那下会补一个 click 到手指底下那张卡上） */
const CLICK_MUTE_MS = 350;

/**
 * @param {object} handRef 手指按着的时候置真 —— 相机那边**可能**把它并进"抓手态"
 *   （手机认、平板不认，见 useBoardCamera 的 fingerPansAnywhere），
 *   拖卡/工作区手势看见抓手态就让路。⚠️ 必须在**捕获阶段**置：画布那些
 *   handler 是 React 委托在根节点上的冒泡回调，比这里晚一步，才读得到。
 */
export function useTouchGestures({ paneRef, camRef, apply, noteTakeover, handRef, enabled = true }) {
  const ref = useRef(null);
  if (!ref.current) ref.current = { pts: new Map(), gesture: null, swallow: false, muteClickUntil: 0 };

  useEffect(() => {
    const el = paneRef.current;
    if (!el || !enabled) return undefined;
    const S = ref.current;

    const rectOf = () => el.getBoundingClientRect();
    /** 给某根手指补一条收尾事件（画布的 onPointerCancel 会把工具/框选/拖卡都收干净） */
    const cancelPointer = (id) => {
      el.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: id, pointerType: 'touch', bubbles: true, cancelable: false,
      }));
    };
    /** 取当前的前两根手指 */
    const twoPoints = () => {
      const it = S.pts.values();
      return [it.next().value, it.next().value];
    };

    const onDown = (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch') return;
      S.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // 第一根手指按在卡上：吞掉，改由这里推画面（理由见文件头"为什么触屏上不许拖卡"）
      // 手指落下 = 进抓手态（拖卡让路、相机接管），抬完最后一根才退出
      if (handRef) handRef.current = true;
      if (S.pts.size !== 2 || S.gesture) return;
      const [a, b] = twoPoints();
      const r = rectOf();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const cam = camRef.current;
      S.gesture = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: cam.z,
        // 中点底下那个世界点：全程钉住它，捏合和平移就是同一个公式
        world: screenToWorld(mid, cam),
      };
      noteTakeover();
      for (const id of S.pts.keys()) cancelPointer(id);
    };

    const onMove = (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch') return;
      if (!S.pts.has(e.pointerId)) return;
      S.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // 捏完还剩一根手指没松：它不该接着变成平移
      if (S.swallow) { e.stopPropagation(); return; }
      if (!S.gesture || S.pts.size < 2) return;
      const [a, b] = twoPoints();
      const r = rectOf();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const g = S.gesture;
      const z = clamp(g.z0 * (dist / g.dist), ZOOM_MIN, ZOOM_MAX);
      // 世界点 g.world 要落回屏幕上的 mid：screen = (world + cam) * z ⇒ cam = mid/z - world
      apply({ z, x: mid.x / z - g.world.x, y: mid.y / z - g.world.y });
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };

    const onUp = (e) => {
      if (!e.isTrusted || e.pointerType !== 'touch') return;
      if (!S.pts.has(e.pointerId) && !S.gesture) return;
      S.pts.delete(e.pointerId);
      const inGesture = !!S.gesture || S.swallow;
      if (S.gesture) {
        S.gesture = null;
        S.swallow = S.pts.size > 0;
        for (const id of S.pts.keys()) cancelPointer(id);
      }
      if (S.pts.size === 0) { S.swallow = false; if (handRef) handRef.current = false; }
      if (inGesture) {
        // 抬手这一下不能再当成"点了画布"（会取消选中，或者点开手指底下那张卡）
        S.muteClickUntil = performance.now() + CLICK_MUTE_MS;
        e.stopPropagation();
      }
    };

    const onClick = (e) => {
      if (performance.now() > S.muteClickUntil) return;
      e.stopPropagation();
      e.preventDefault();
    };

    const opts = { capture: true, passive: false };
    el.addEventListener('pointerdown', onDown, opts);
    el.addEventListener('pointermove', onMove, opts);
    el.addEventListener('pointerup', onUp, opts);
    el.addEventListener('pointercancel', onUp, opts);
    el.addEventListener('click', onClick, opts);
    return () => {
      el.removeEventListener('pointerdown', onDown, opts);
      el.removeEventListener('pointermove', onMove, opts);
      el.removeEventListener('pointerup', onUp, opts);
      el.removeEventListener('pointercancel', onUp, opts);
      el.removeEventListener('click', onClick, opts);
      S.pts.clear(); S.gesture = null; S.swallow = false;
      if (handRef) handRef.current = false;
    };
  }, [paneRef, camRef, apply, noteTakeover, handRef, enabled]);
}
