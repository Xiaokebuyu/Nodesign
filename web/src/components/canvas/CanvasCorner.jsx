import { useEffect, useRef, useState } from 'react';
import Minimap, { MAP_W } from './Minimap.jsx';
import { SHORTCUTS, SHORTCUT_GROUPS, ACTION_TOKENS, isMacPlatform } from '../../lib/canvas-shortcuts.js';
import { useIsDesktop } from '../../lib/device-class.js';
import { t } from '../../lib/i18n.js';
import { COLOR, GAP, FONT_MONO, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, INK_EDGE } from '../../lib/paper.js';

/**
 * CanvasCorner —— 画布左下角那一组：小地图 + 快捷键提示（2026-09-12）。
 *
 * 站主：「找个地方常态显示画布的各种键盘快捷操作」。此前只有工具按钮的 title 里写着
 * 字母，空格拖动、Shift+1、`/` 这些哪儿都看不到。常驻只放最常用的四条，其余点开看。
 *
 * - 显隐跟着小地图走（BoardCanvas 那一处条件），这里不再判第二遍；
 * - 只在电脑上出：手机、平板没有键盘，印了也按不了；
 * - **竖列摆在小地图右侧**（站主 09-12 定）。⛔ 别改回横条摆在小地图上方或下方：
 *   底边正中那条工具栏（宽度随工具多少变）在 1600 宽的画布上左端落在 557，横条会跟它叠；
 *   竖列右端只到 360 上下，让得开。画布窄过 COMPACT_BELOW 就只留一颗小钮。
 * - 收起后留那颗小钮：入口必须同时是出口，不能只剩一个快捷键（Ctrl/⌘+/ 两头切）。
 * 表和判据在 lib/canvas-shortcuts.js。
 */
/** 画布比这窄就只留一颗小钮：竖列右端约 360，底边工具栏左端 = 画布宽/2 − 243 */
const COMPACT_BELOW = 1200;
/** 收放状态（'0' = 只留小钮）。跟工具栏一样是用户的一次表态，刷新还记得 */
const OPEN_KEY = 'nd:keys-open';

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
      position: 'absolute', left: 0, bottom: '100%', marginBottom: GAP.sm, width: 340,
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
  const [sheet, setSheet] = useState(false);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
  });
  const ref = useRef(null);
  const mac = isMacPlatform();
  const modLabel = mac ? '⌘' : 'Ctrl';
  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* 记不住就算了 */ }
      if (!next) setSheet(false);
      return next;
    });
  };
  // Ctrl/⌘ + / 收放这一列（登记在 lib/canvas-shortcuts.js）。斜杠单按是唤出 agent，所以带修饰键
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'Slash') return;
      const tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      e.preventDefault();
      toggleOpen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!sheet) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setSheet(false); };
    const esc = (e) => { if (e.key === 'Escape') setSheet(false); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  }, [sheet]);

  const shown = open && !compact;
  const paper = {
    background: PAPER.paper, boxShadow: PAPER_SHADOW.far,
    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2, userSelect: 'none',
  };
  const linkBtn = {
    border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
    fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub, whiteSpace: 'nowrap',
  };

  return (
    <div
      ref={ref}
      data-no-pan
      data-canvas-keys
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'absolute', left: GAP.md + MAP_W + GAP.sm, bottom: GAP.md, zIndex: 40 }}
    >
      {sheet && <Sheet mac={mac} />}
      {shown ? (
        <div style={{ ...paper, display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 9px' }}>
          <button
            type="button"
            onClick={toggleOpen}
            title={`${t('收起快捷键提示')}（${modLabel}+/）`}
            style={{ ...linkBtn, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
          >
            <span>{t('快捷键')}</span><span aria-hidden>⌃</span>
          </button>
          {SHORTCUTS.filter((s) => s.pin).map((s) => (
            <span key={s.id} title={t(s.label)} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <Combo keys={s.keys[0]} mac={mac} />
              <span>{t(s.pin)}</span>
            </span>
          ))}
          <button
            type="button"
            aria-expanded={sheet}
            onClick={() => setSheet((v) => !v)}
            style={{ ...linkBtn, textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 3 }}
          >{sheet ? t('收起') : t('全部快捷键')}</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={compact ? () => setSheet((v) => !v) : toggleOpen}
          title={compact ? t('画布快捷键') : `${t('展开快捷键提示')}（${modLabel}+/）`}
          style={{ ...paper, display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', border: 'none', cursor: 'pointer' }}
        >
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{t('快捷键')}</span>
          <span aria-hidden style={{ color: COLOR.sub }}>⌄</span>
        </button>
      )}
    </div>
  );
}
