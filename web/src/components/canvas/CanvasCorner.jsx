import { useEffect, useRef, useState } from 'react';
import Minimap, { MAP_H } from './Minimap.jsx';
import { SHORTCUTS, SHORTCUT_GROUPS, ACTION_TOKENS, isMacPlatform } from '../../lib/canvas-shortcuts.js';
import { useIsDesktop } from '../../lib/device-class.js';
import { t } from '../../lib/i18n.js';
import { COLOR, GAP, FONT_MONO, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, INK_EDGE } from '../../lib/paper.js';

/**
 * CanvasCorner —— 画布左下角那一组：小地图 + 快捷键条（2026-09-12）。
 *
 * 站主：「找个地方常态显示画布的各种键盘快捷操作」。此前只有工具按钮的 title 里写着
 * 字母，空格拖动、Shift+1、`/` 这些哪儿都看不到。常驻只放最常用的四个，其余点开看。
 *
 * - 显隐跟着小地图走（BoardCanvas 那一处条件），这里不再判第二遍；
 * - 快捷键条只在电脑上出：手机、平板没有键盘，印了也按不了；
 * - 画布窄了只留「全部快捷键」一颗，不去压右边的东西（钉住的聊天卡浮在画布上）。
 * - ⛔ 摆在小地图**正上方**，不摆在它右边：底边正中那条工具栏（鼠标靠近底边才浮出来，
 *   宽度跟着工具多少变）在 1600 宽的画布上左端落在 557，摆右边的话条子右端 666，
 *   两者叠在一起（09-12 截图量出来的）。
 * 表和判据在 lib/canvas-shortcuts.js。
 */
const STRIP_H = 30;
/** 画布比这窄就只留「全部快捷键」：条子右端约 500，钉住的聊天卡还要占四百五十多 */
const COMPACT_BELOW = 1080;

export default function CanvasCorner(props) {
  const desktop = useIsDesktop();
  return (
    <>
      <Minimap {...props} />
      {desktop && <KeyStrip compact={(props.viewport?.w || 0) < COMPACT_BELOW} />}
    </>
  );
}

function Cap({ children }) {
  return (
    <span style={{
      display: 'inline-block', minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box',
      border: `1px solid ${INK_EDGE}`, borderBottomWidth: 2, borderRadius: 2,
      background: COLOR.bgCard, color: COLOR.text,
      fontFamily: FONT_MONO, fontSize: 11, lineHeight: '15px', textAlign: 'center', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

/** 一组按法：键帽之间用「+」连，滚轮 / 拖动这类动作印成字 */
function Combo({ keys, mac }) {
  const word = { Mod: mac ? '⌘' : 'Ctrl', Space: t('空格'), wheel: t('滚轮'), drag: t('拖动') };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      {keys.map((k, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {i > 0 && <span style={{ color: COLOR.sub }}>+</span>}
          {ACTION_TOKENS.has(k) ? <span>{word[k]}</span> : <Cap>{word[k] || k}</Cap>}
        </span>
      ))}
    </span>
  );
}

function Sheet({ mac }) {
  return (
    <div role="dialog" aria-label={t('画布快捷键')} style={{
      position: 'absolute', left: 0, bottom: STRIP_H + GAP.sm, width: 340,
      padding: '12px 14px 10px', background: PAPER.paper, boxShadow: PAPER_SHADOW.mid,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text,
    }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub, letterSpacing: 1 }}>
        {t('画布快捷键')}
      </div>
      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.id} style={{ marginTop: 10 }}>
          <div style={{
            fontSize: FONT_SIZE.xxs, color: COLOR.sub,
            borderBottom: `1px solid ${PAPER.hair}`, paddingBottom: 3, marginBottom: 2,
          }}>{t(g.label)}</div>
          {SHORTCUTS.filter((s) => s.group === g.id).map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
              <span style={{ color: COLOR.text2 }}>{t(s.label)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {s.keys.map((c, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <span style={{ color: COLOR.sub }}>/</span>}
                    <Combo keys={c} mac={mac} />
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function KeyStrip({ compact }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const mac = isMacPlatform();
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div
      ref={ref}
      data-no-pan
      data-canvas-keys
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: GAP.md, bottom: GAP.md + MAP_H + GAP.sm, zIndex: 40 }}
    >
      {open && <Sheet mac={mac} />}
      <div style={{
        height: STRIP_H, display: 'flex', alignItems: 'center', gap: 14,
        padding: `0 ${GAP.sm}px 0 10px`,
        background: PAPER.paper, boxShadow: PAPER_SHADOW.far,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2, userSelect: 'none',
      }}>
        {!compact && SHORTCUTS.filter((s) => s.pin).map((s) => (
          <span key={s.id} title={t(s.label)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Combo keys={s.keys[0]} mac={mac} />
            <span>{t(s.pin)}</span>
          </span>
        ))}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{
            border: 'none', background: 'transparent', padding: '0 2px', cursor: 'pointer',
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
            textDecoration: 'underline', textUnderlineOffset: 3, whiteSpace: 'nowrap',
          }}
        >{open ? t('收起') : t('全部快捷键')}</button>
      </div>
    </div>
  );
}
