import { useState, useEffect } from 'react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { describeStyles, getElementRole } from '../../lib/element-semantics.js';

/**
 * DirectEditModal — Inspect "直接改属性" 弹的小 form
 *
 * P2 简化版：覆盖最常用 6 维度（颜色、字号、字重、对齐、行高、字距）
 * 应用 → 直接写 iframe DOM 的 element.style，并把 patch 丢给父 onApply 落 state
 *
 * P5：升级到完整可调维度（按 describeAdjustables 列表自动渲染 form）+ AI 协助
 */
export default function DirectEditModal({ show, onClose, anchor, iframeDoc, onApply }) {
  const el = anchor && iframeDoc ? findElementByAnchor(anchor, iframeDoc.body) : null;
  const [color, setColor]           = useState('');
  const [fontSize, setFontSize]     = useState('');
  const [fontWeight, setFontWeight] = useState('');
  const [textAlign, setTextAlign]   = useState('');
  const [lineHeight, setLineHeight] = useState('');
  const [letterSpacing, setLetterSpacing] = useState('');

  // 打开时从元素当前样式读初值
  useEffect(() => {
    if (!show || !el) return;
    const view = el.ownerDocument?.defaultView;
    const cs = view?.getComputedStyle(el);
    if (!cs) return;
    setColor(rgbToHex(cs.color) || '');
    setFontSize(cs.fontSize || '');
    setFontWeight(cs.fontWeight || '');
    setTextAlign(cs.textAlign && cs.textAlign !== 'start' ? cs.textAlign : '');
    setLineHeight(cs.lineHeight && cs.lineHeight !== 'normal' ? cs.lineHeight : '');
    setLetterSpacing(cs.letterSpacing && cs.letterSpacing !== 'normal' ? cs.letterSpacing : '');
  }, [show, el]);

  if (!show) return null;
  if (!el) return null;

  const role = getElementRole(el);
  const styles = describeStyles(el);

  const apply = () => {
    const changes = {};
    if (color)           { el.style.color = color;                     changes.color = color; }
    if (fontSize)        { el.style.fontSize = fontSize;               changes.fontSize = fontSize; }
    if (fontWeight)      { el.style.fontWeight = fontWeight;           changes.fontWeight = fontWeight; }
    if (textAlign)       { el.style.textAlign = textAlign;             changes.textAlign = textAlign; }
    if (lineHeight)      { el.style.lineHeight = lineHeight;           changes.lineHeight = lineHeight; }
    if (letterSpacing)   { el.style.letterSpacing = letterSpacing;     changes.letterSpacing = letterSpacing; }

    onApply?.({ anchor, changes });
    onClose?.();
  };

  return (
    <Modal show={show} onClose={onClose} title={`直接改属性：${role}`} width={520}>
      <div style={{ padding: GAP.xl, display: 'flex', flexDirection: 'column', gap: GAP.lg }}>
        <div style={{
          padding: `${GAP.sm}px ${GAP.md}px`,
          background: COLOR.bgCard,
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: 6,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          &lt;{el.tagName.toLowerCase()}&gt; "{(el.textContent || '').trim().slice(0, 40)}"
        </div>

        <Field label="颜色">
          <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center' }}>
            <input
              type="color"
              value={color || '#000000'}
              onChange={e => setColor(e.target.value)}
              style={{ width: 36, height: 28, borderRadius: 4, border: `1px solid ${COLOR.borderMd}`, cursor: 'pointer' }}
            />
            <input
              type="text"
              value={color}
              onChange={e => setColor(e.target.value)}
              placeholder="#3a2a18"
              style={inputStyle}
            />
          </div>
        </Field>

        <Field label="字号">
          <input type="text" value={fontSize} onChange={e => setFontSize(e.target.value)} placeholder="20px" style={inputStyle} />
        </Field>

        <Field label="字重">
          <Segmented
            value={fontWeight}
            options={[
              { id: '300', label: '细' },
              { id: '400', label: '常规' },
              { id: '500', label: '中' },
              { id: '600', label: '半粗' },
              { id: '700', label: '粗' },
            ]}
            onChange={setFontWeight}
          />
        </Field>

        <Field label="对齐">
          <Segmented
            value={textAlign}
            options={[
              { id: 'left',    label: '左' },
              { id: 'center',  label: '居中' },
              { id: 'right',   label: '右' },
              { id: 'justify', label: '两端' },
            ]}
            onChange={setTextAlign}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP.lg }}>
          <Field label="行高">
            <input type="text" value={lineHeight} onChange={e => setLineHeight(e.target.value)} placeholder="1.5 / 24px" style={inputStyle} />
          </Field>
          <Field label="字距">
            <input type="text" value={letterSpacing} onChange={e => setLetterSpacing(e.target.value)} placeholder="0 / -0.02em" style={inputStyle} />
          </Field>
        </div>

        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5 }}>
          ⓘ 改动直接写到 iframe DOM 的 inline style；P3 后端起来后会同步到 source HTML。
        </div>
      </div>

      <ModalFooter onCancel={onClose} onConfirm={apply} confirmLabel="应用" />
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: GAP.xs + 1,
      }}>{label}</div>
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: 'inline-flex', background: 'rgba(0,0,0,0.04)', borderRadius: 6, padding: 2 }}>
      {options.map(opt => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(active ? '' : opt.id)}
            style={{
              padding: `${GAP.xs}px ${GAP.md}px`,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
              color: active ? COLOR.text : COLOR.sub,
              background: active ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: `${GAP.sm}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
  color: COLOR.text,
  background: '#fff',
  border: `1px solid ${COLOR.borderMd}`,
  borderRadius: 6,
  outline: 'none',
};

function rgbToHex(rgb) {
  if (!rgb) return '';
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '';
  return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}
