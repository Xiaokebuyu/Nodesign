/**
 * 语言切换器（2026-08-26 i18n）
 *
 * 两个地方要用：登录墙（门外）和站内。**门外那个是硬需求** —— 一个英文用户
 * 读不懂登录表单的话，站内做得再好也没机会被看到。所以这个组件不依赖登录态。
 *
 * 落盘分两层：
 *   localStorage  永远写（这台机器上这个人的偏好，跟 canvasFont / followAgent 同族）
 *   账号          登录了才写（PUT /api/auth/locale），没登录静默跳过
 *
 * 没登录时账号那层写不进去是**正常路径不是错误**，不弹 toast、不禁用控件。
 */
import { useState, useRef, useEffect } from 'react';
import { Languages, Check } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { LOCALES, getLocale } from '../../lib/i18n.js';
import { COLOR, FONT_SANS } from '../../lib/theme.js';

/**
 * @param {'wall'|'chrome'} variant 门外用 wall（纸上的一枚小签），站内用 chrome（跟其他图标钮一排）
 */
export default function LanguageSwitcher({ variant = 'chrome' }) {
  // 订阅 store 的 locale 只为重渲染；真值读 getLocale()（见 globalStore 注释）
  useGlobalStore((s) => s.locale);
  const setLocale = useGlobalStore((s) => s.setLocale);
  const current = getLocale();
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const pick = (id) => {
    setOpen(false);
    if (id === current) return;
    setLocale(id);
    // 账号那层：登录了才有意义，401 是正常路径（门外切语言），不报错
    fetch('/api/auth/locale', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: id }),
    }).catch(() => { /* 离线 / 没登录：localStorage 那层已经生效了 */ });
  };

  const label = LOCALES.find((l) => l.id === current)?.label || current;

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: variant === 'wall' ? '5px 10px' : '4px 8px',
          border: 'none',
          borderRadius: 8,
          background: variant === 'wall' ? COLOR.bgWhite : 'transparent',
          boxShadow: variant === 'wall' ? '0 1px 3px rgba(43,33,23,0.12)' : 'none',
          color: COLOR.text5,
          font: `13px ${FONT_SANS}`,
          cursor: 'pointer',
        }}
      >
        <Languages size={14} />
        {label}
      </button>

      {open && (
        <ul
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
            margin: 0, padding: 4, listStyle: 'none', minWidth: 132,
            background: COLOR.bgModal, borderRadius: 10,
            boxShadow: '0 8px 32px rgba(43,33,23,0.14), 0 2px 8px rgba(43,33,23,0.08)',
          }}
        >
          {LOCALES.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                role="option"
                aria-selected={l.id === current}
                onClick={() => pick(l.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 9px', border: 'none', borderRadius: 7,
                  background: l.id === current ? COLOR.bgCard : 'transparent',
                  color: l.id === current ? COLOR.text : COLOR.text3,
                  font: `13px ${FONT_SANS}`, textAlign: 'left', cursor: 'pointer',
                }}
              >
                <Check size={13} style={{ opacity: l.id === current ? 1 : 0, flexShrink: 0 }} />
                {l.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
