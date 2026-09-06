// web/src/components/settings/ui.jsx — 设置页的一套件（09-07 重做，站主：「设置页太草率，按 C 端 SaaS 打磨」）。
//
// 语言还是这套纸：楷体、纸色、直角。但设置页是**表单**不是台面 —— 它要的是对齐、
// 层级和一眼能读的行：左边说这是什么，右边是控件；卡片有标题和一句话说明；
// 状态用小标签说，不用红字堆。工程细节（路径、pid、环境变量名）一律折进「开发者选项」。
import { useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_KAI, FONT_MONO, RADIUS } from '../../lib/theme.js';
import { PAPER_SHADOW } from '../../lib/paper.js';
import { t } from '../../lib/i18n.js';

const HAIR = 'rgba(43,33,23,0.08)';

/** 一张卡：标题 + 一句说明 + 若干行 */
export function Panel({ title, desc, aside, children, style }) {
  return (
    <section style={{ background: COLOR.bgWhite, borderRadius: RADIUS.md, boxShadow: PAPER_SHADOW.far, marginBottom: GAP.xl, ...style }}>
      {(title || desc || aside) && (
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: GAP.md, padding: `${GAP.xl}px ${GAP.xxl}px ${GAP.md}px` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.xl, fontWeight: 600, color: COLOR.text }}>{title}</div>}
            {desc && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: COLOR.text3, marginTop: 2, lineHeight: 1.6 }}>{desc}</div>}
          </div>
          {aside}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

/**
 * 一行设置：左边「这是什么 + 一句说明」，右边控件。行与行之间一根发丝线。
 * `stack` = 控件太宽（表单）放到说明下面一整行。
 */
export function Row({ label, desc, children, stack = false, first = false }) {
  return (
    <div style={{
      display: 'flex', flexDirection: stack ? 'column' : 'row', alignItems: stack ? 'stretch' : 'center', gap: stack ? GAP.md : GAP.xl,
      padding: `${GAP.lg}px ${GAP.xxl}px`, borderTop: first ? 0 : `1px solid ${HAIR}`,
    }}>
      <div style={{ flex: stack ? 'none' : 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{label}</div>
        {desc && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4, marginTop: 2, lineHeight: 1.6 }}>{desc}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexShrink: 0, ...(stack ? {} : { maxWidth: '60%' }) }}>{children}</div>
    </div>
  );
}

/** 卡片里的自由区（表格、图表、表单）：跟 Row 同一套内边距 */
export function Block({ children, first = false, style }) {
  return <div style={{ padding: `${GAP.lg}px ${GAP.xxl}px`, borderTop: first ? 0 : `1px solid ${HAIR}`, ...style }}>{children}</div>;
}

/** 分段选择（字体 / 缩放 / 语言这类 2~5 档） */
export function Segmented({ options, value, onChange }) {
  return (
    <div role="radiogroup" style={{ display: 'inline-flex', background: 'rgba(43,33,23,0.06)', borderRadius: RADIUS.pill, padding: 2 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} role="radio" aria-checked={on} onClick={() => onChange(o.value)} style={{
            padding: `4px ${GAP.lg}px`, border: 0, borderRadius: RADIUS.pill, cursor: 'pointer',
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, lineHeight: 1.5,
            background: on ? COLOR.bgWhite : 'transparent', color: on ? COLOR.text : COLOR.text3,
            boxShadow: on ? '0 1px 3px rgba(43,33,23,0.14)' : 'none', transition: 'background .15s',
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

/** 开关 */
export function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => !disabled && onChange(!checked)} style={{
      width: 36, height: 20, borderRadius: RADIUS.pill, border: 0, padding: 2, cursor: disabled ? 'default' : 'pointer',
      background: checked ? COLOR.btn : 'rgba(43,33,23,0.18)', opacity: disabled ? 0.45 : 1, transition: 'background .15s', flexShrink: 0,
    }}>
      <span style={{ display: 'block', width: 16, height: 16, borderRadius: '50%', background: COLOR.bgWhite, boxShadow: '0 1px 2px rgba(43,33,23,0.25)', transform: `translateX(${checked ? 16 : 0}px)`, transition: 'transform .15s' }} />
    </button>
  );
}

/** 单选点（默认模型那种一列里只能选一个） */
export function Radio({ checked, onChange, disabled = false, label }) {
  return (
    <button role="radio" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => !disabled && !checked && onChange()} style={{
      width: 18, height: 18, borderRadius: '50%', padding: 0, cursor: disabled ? 'default' : 'pointer', flexShrink: 0,
      border: `1.5px solid ${checked ? COLOR.btn : 'rgba(43,33,23,0.3)'}`, background: COLOR.bgWhite, opacity: disabled ? 0.45 : 1,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {checked && <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLOR.btn }} />}
    </button>
  );
}

/** 小标签：状态（已安装 / 必需 / Pro）、档位 */
export function Badge({ tone = 'neutral', children }) {
  const tones = {
    neutral: { bg: 'rgba(43,33,23,0.07)', fg: COLOR.text3 },
    ok: { bg: 'rgba(58,110,70,0.12)', fg: COLOR.success },
    warn: { bg: 'rgba(160,110,30,0.14)', fg: COLOR.warn },
    bad: { bg: 'rgba(160,50,40,0.12)', fg: COLOR.error },
    ink: { bg: COLOR.btn, fg: COLOR.btnText },
  };
  const c = tones[tone] || tones.neutral;
  return <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: RADIUS.pill, background: c.bg, color: c.fg, fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, lineHeight: 1.7, whiteSpace: 'nowrap' }}>{children}</span>;
}

/** 按钮：primary（墨块）/ secondary（描边）/ ghost（只字）/ danger */
export function Button({ variant = 'secondary', size = 'md', disabled = false, onClick, children, title, style }) {
  const pad = size === 'sm' ? `3px ${GAP.lg}px` : `6px ${GAP.xl}px`;
  const fs = size === 'sm' ? FONT_SIZE.md : FONT_SIZE.base;
  const v = {
    primary: { bg: COLOR.btn, fg: COLOR.btnText, border: COLOR.btn },
    secondary: { bg: 'transparent', fg: COLOR.text, border: 'rgba(43,33,23,0.28)' },
    ghost: { bg: 'transparent', fg: COLOR.text3, border: 'transparent' },
    danger: { bg: 'transparent', fg: COLOR.error, border: 'rgba(160,50,40,0.35)' },
  }[variant];
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding: pad, fontFamily: FONT_KAI, fontSize: fs, lineHeight: 1.5, whiteSpace: 'nowrap',
      color: v.fg, background: v.bg, border: `1px solid ${v.border}`, borderRadius: RADIUS.sm,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1, ...style,
    }}>{children}</button>
  );
}

/** 进度条（安装 / 额度） */
export function Progress({ value, max = 1, tone = 'ink', height = 6, width }) {
  const pct = Math.max(0, Math.min(100, (Number(value) || 0) / (Number(max) || 1) * 100));
  const fill = tone === 'warn' ? COLOR.warn : tone === 'bad' ? COLOR.error : COLOR.btn;
  return (
    <div style={{ height, borderRadius: RADIUS.pill, background: 'rgba(43,33,23,0.09)', overflow: 'hidden', width: width || '100%' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: fill, transition: 'width .3s' }} />
    </div>
  );
}

/** 机器写的东西（路径 / id）：等宽、可换行、带一键复制 */
export function Mono({ children, copy = false }) {
  const [done, setDone] = useState(false);
  const text = String(children ?? '');
  const doCopy = async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* 剪贴板不可用就算了 */ } };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.sm, minWidth: 0 }}>
      <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, color: COLOR.text2, wordBreak: 'break-all' }}>{text}</span>
      {copy && text && (
        <button onClick={doCopy} style={{ border: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: done ? COLOR.success : COLOR.text4, padding: 0, flexShrink: 0 }}>{done ? t('已复制') : t('复制')}</button>
      )}
    </span>
  );
}

/** 折叠区（开发者选项 / 自己的 API Key）：整块卡片里最后一节，标题行常驻 */
export function Disclosure({ title, desc, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderTop: `1px solid ${HAIR}` }}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: GAP.md, textAlign: 'left', cursor: 'pointer',
        padding: `${GAP.lg}px ${GAP.xxl}px`, border: 0, background: 'transparent',
      }}>
        <span style={{ display: 'inline-block', width: 10, fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text4, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{title}</span>
          {desc && <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4, marginLeft: GAP.md }}>{desc}</span>}
        </span>
      </button>
      {open && <div style={{ padding: `0 ${GAP.xxl}px ${GAP.xl}px` }}>{children}</div>}
    </div>
  );
}

/** 空态 / 读取中 / 出错 三种一句话 */
export function Note({ tone = 'neutral', children }) {
  const fg = tone === 'bad' ? COLOR.error : tone === 'warn' ? COLOR.warn : COLOR.text4;
  return <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: fg, lineHeight: 1.6 }}>{children}</div>;
}
