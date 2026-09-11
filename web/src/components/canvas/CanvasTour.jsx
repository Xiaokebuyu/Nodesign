import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOUR_STEPS, CARD, TOUR_DONE_KEY, TOUR_PENDING_KEY, placeCard, usable } from '../../lib/canvas-tour.js';
import { t } from '../../lib/i18n.js';
import { COLOR, GAP, FONT_MONO, FONT_SANS, FONT_READ, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, pinFill, PIN_SHADOW } from '../../lib/paper.js';
import { PORTAL_Z } from '../../lib/z-layers.js';

/**
 * 新手引导：在真画布上走五步（2026-09-12）。步骤表和摆位算法在 lib/canvas-tour.js。
 *
 * ## 什么时候跑
 *
 *   ① 刚领到示例项目 —— 首页领到之后写下 `nd:tour-pending = <项目 id>`，进这个项目就跑；
 *   ② 地址栏带 `?tour=1` —— 重看，也是我改它时唯一的入口；
 *   ③ 左下角快捷键那一列里的「重看新手引导」（派 `nd:tour-replay` 事件）。
 *
 * 走完或者跳过都写 `nd:tour-done`，同一个人不再自动跑第二遍。
 *
 * ## 不压暗画布
 *
 * 整块变灰的引导把人挡在玻璃外面，而这五步恰恰是要他看清画布上有什么。这里只用朱砂圈出
 * 正在说的那一件（同登录页那套红笔线），卡片落在它旁边 —— 画布照常能拖能点。
 *
 * ⚠️ 目标元素找不到就跳过那一步（比如这个项目没有产物卡）：引导指着空气比不引导更糟。
 */
const NUM = ['①', '②', '③', '④', '⑤', '⑥'];
/** 朱砂：跟登录页的红笔线、画布上的红头钉同一支笔 */
const RED = '#9E3B2E';
/** 圈往外放这么多，别贴着目标的边 */
const PAD = 6;
/** 圈中点那一版的直径（关系线那种：外框是一大片空白） */
const SPOT = 120;

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 记不住就算了 */ } };

/**
 * 按 anchor 里的顺序一条条试，返回第一个**圈得出来**的（太小＝还没画，太大＝整层铺满屏）。
 * 顺序有意义：第三步先找线上的那句字，没有字才退回整条线。
 */
function findTarget(step) {
  const { anchor: anchors, ring } = step;
  const view = { w: window.innerWidth, h: window.innerHeight };
  for (const sel of anchors) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const box = { x: r.x, y: r.y, w: r.width, h: r.height };
      if (!usable(box, view)) continue;
      // 圈中点的那种（关系线）：中点得真的在屏幕里，不然圈跑到视口外边去了（09-12 实测）
      if (ring === 'spot') {
        const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
        if (cx < 60 || cy < 60 || cx > view.w - 60 || cy > view.h - 60) continue;
      }
      /**
       * ⛔ 还得**真的看得见**：在视口里不等于没被盖住。钉住的聊天卡浮在画布上，
       * 它底下的关系线照样量得出坐标，圈上去就是圈了一圈盖着的东西（09-12 实测）。
       * 拿中心点做一次命中测试；打不中就换下一个候选。
       */
      const hit = document.elementFromPoint(
        Math.min(Math.max(box.x + box.w / 2, 1), view.w - 1),
        Math.min(Math.max(box.y + box.h / 2, 1), view.h - 1),
      );
      if (hit && (el.contains(hit) || hit.contains(el))) return box;
    }
  }
  return null;
}

/**
 * 能用的那块屏：钉住的聊天卡浮在画布上，圈和卡片都不该压在它身上（09-12 截图看出来的）。
 * 卡自己是第四步要圈的东西，所以只在"目标不在卡里"的时候躲。
 */
function freeArea() {
  const view = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const dock = document.querySelector('[data-chat-dock]');
  if (!dock) return view;
  const r = dock.getBoundingClientRect();
  if (r.width < 40) return view;
  if (dock.getAttribute('data-chat-dock') === 'left') return { ...view, x: r.right, w: view.w - r.right };
  return { ...view, w: r.left };
}

/** 圈别越到聊天卡上（第四步圈的就是卡本身，不裁） */
function clipToArea(box, area, step) {
  if (step.id === 'chat') return box;
  const x = Math.max(box.x, area.x);
  const right = Math.min(box.x + box.w, area.x + area.w);
  return { ...box, x, w: Math.max(24, right - x) };
}

export default function CanvasTour({ projectId }) {
  const [step, setStep] = useState(-1);          // -1 = 没在跑
  const [rect, setRect] = useState(null);
  const startedRef = useRef(false);

  const start = useCallback(() => { startedRef.current = true; setStep(0); }, []);
  const stop = useCallback(() => {
    setStep(-1);
    write(TOUR_DONE_KEY, '1');
    write(TOUR_PENDING_KEY, null);
  }, []);

  // 该不该自动跑：刚领到的那个项目，或者地址栏点名
  useEffect(() => {
    if (startedRef.current || !projectId) return;
    const asked = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tour') === '1';
    const pending = read(TOUR_PENDING_KEY) === projectId && read(TOUR_DONE_KEY) !== '1';
    if (asked || pending) {
      // 等画布把卡片真的画出来再开讲（第一步圈的就是其中一张）
      const timer = setTimeout(start, 1200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [projectId, start]);

  // 「重看新手引导」（左下角那一列）
  useEffect(() => {
    const on = () => { startedRef.current = false; setStep(0); };
    window.addEventListener('nd:tour-replay', on);
    return () => window.removeEventListener('nd:tour-replay', on);
  }, []);

  // 跟着目标走：画布能拖能缩，卡片和圈每 200ms 对一次账（比监听一堆事件省心，也不会漏）
  useEffect(() => {
    if (step < 0) return undefined;
    const tick = () => {
      const s = TOUR_STEPS[step];
      setRect(s ? findTarget(s) : null);
    };
    tick();
    const id = setInterval(tick, 200);
    window.addEventListener('resize', tick);
    return () => { clearInterval(id); window.removeEventListener('resize', tick); };
  }, [step]);

  // 跑之前先把目标找一遍：这个项目要是没有产物卡，直接跳到下一步（别指着空气讲）
  useEffect(() => {
    if (step < 0 || step >= TOUR_STEPS.length) return;
    if (findTarget(TOUR_STEPS[step])) return;
    const timer = setTimeout(() => {
      if (findTarget(TOUR_STEPS[step])) return;
      if (step + 1 >= TOUR_STEPS.length) stop(); else setStep(step + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [step, stop]);

  if (step < 0 || step >= TOUR_STEPS.length || typeof document === 'undefined') return null;

  const s = TOUR_STEPS[step];
  const view = freeArea();
  const box = clipToArea(rect || { x: view.x + view.w / 2 - 1, y: view.y + view.h / 2 - 1, w: 2, h: 2 }, view, s);
  // 圈中点那种：卡片要躲开的是**那个圈**，不是曲线那一大片外框（不然卡会压在圈上）
  const around = s.ring === 'spot'
    ? { x: box.x + box.w / 2 - SPOT / 2, y: box.y + box.h / 2 - SPOT / 2, w: SPOT, h: SPOT }
    : box;
  const at = placeCard(around, CARD, view);
  const last = step === TOUR_STEPS.length - 1;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: PORTAL_Z.POPOVER, pointerEvents: 'none' }}>
      {rect && (s.ring === 'spot' ? (
        /* 曲线这类东西的外框是一大片空白：圈它的中点 */
        <div aria-hidden style={{
          position: 'fixed', left: box.x + box.w / 2 - SPOT / 2, top: box.y + box.h / 2 - SPOT / 2,
          width: SPOT, height: SPOT,
          border: `2px solid ${RED}`, borderRadius: '50%', pointerEvents: 'none',
        }} />
      ) : (
        <div aria-hidden style={{
          position: 'fixed', left: box.x - PAD, top: box.y - PAD,
          width: box.w + PAD * 2, height: box.h + PAD * 2,
          border: `2px solid ${RED}`, borderRadius: 4, pointerEvents: 'none',
        }} />
      ))}
      <div
        role="dialog"
        aria-label={t('新手引导')}
        style={{
          position: 'fixed', left: at.x, top: at.y, width: CARD.w,
          background: PAPER.paper, boxShadow: PAPER_SHADOW.near,
          fontFamily: FONT_SANS, pointerEvents: 'auto',
        }}
      >
        {/* 钉子：这张卡也是钉在画布上的一张纸 */}
        <span aria-hidden style={{
          position: 'absolute', left: '50%', top: -5, marginLeft: -5,
          width: 10, height: 10, borderRadius: '50%',
          background: pinFill(true), boxShadow: PIN_SHADOW,
        }} />
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          height: 26, padding: `0 ${GAP.sm}px`, background: '#E3D8C0',
          borderBottom: '1px solid #C7B79A',
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.text2,
        }}>
          <span>{NUM[step]} {t(s.title)}</span>
          <span>{step + 1} / {TOUR_STEPS.length}</span>
        </div>
        <div style={{
          padding: `${GAP.md}px ${GAP.md}px ${GAP.xs}px`,
          fontFamily: FONT_READ, fontSize: FONT_SIZE.md, lineHeight: 1.75, color: COLOR.text2,
        }}>{t(s.body)}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${GAP.xs}px ${GAP.sm}px ${GAP.md}px` }}>
          <button type="button" onClick={stop} style={{
            border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 6px',
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
            textDecoration: 'underline', textUnderlineOffset: 3,
          }}>{t('跳过')}</button>
          <button type="button" onClick={() => (last ? stop() : setStep(step + 1))} style={{
            border: 'none', borderRadius: 0, cursor: 'pointer', padding: '6px 16px',
            background: COLOR.btn, color: COLOR.btnText,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          }}>{last ? t('开始吧') : t('下一步')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
