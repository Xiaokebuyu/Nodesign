import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Check } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SANS, FONT_SIZE, alpha } from '../../lib/theme.js';
import { PAPER } from '../../lib/paper.js';
import { BINDING_STYLES, BINDING_MATERIALS } from '../../lib/board-bindings.js';
import { isImeEnter } from '../../lib/helpers.js';

/**
 * LinkPopover —— 关系线的建线/改线浮层（2026-08-14，手动连线上线）。
 *
 * 两个入口共用一张纸：
 *   - create：右键「连线到…」拾取目标之后弹出。选类型 chip（默认「关联」）+
 *     可选写一句含义，Enter / ✓ 落线。
 *   - edit：点画布上任何一条线弹出。改词、换类型、删除都在这儿 ——
 *     BindingLayer 的 onSelect 之前空挂了一周，线画上去就没人能动它。
 *
 * 类型 chips 直接读 BINDING_STYLES（视觉真相表，与服务端词汇表有 parity
 * 断言对齐）——加语义不用改这儿。「关联」排第一当默认档：五种预定义都
 * 不合身时，含义由那句 label 定义，agent 逐字读。
 *
 * 位置/portal/关闭规则照 ContextMenu：屏幕坐标 fixed、portal 到 body
 * （画布 section 的 isolation 会把 z-index 关在里面）、贴边翻转、
 * Esc / 点别处关掉（Esc 捕获阶段拦住，别顺手换了画布层级）。
 */

const POP_W = 300;
const CHIP_ORDER = ['link', 'derives-from', 'annotates', 'flow', 'ref', 'contrast'];

export default function LinkPopover({
  x, y,
  mode = 'create',            // 'create' | 'edit'
  fromTitle, toTitle,
  initialType = 'link', initialLabel = '',
  initialMaterial = 'ink',
  onSubmit,                   // ({ type, label, material }) => void
  onDelete = null,            // edit 才给
  onClose,
}) {
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [type, setType] = useState(BINDING_STYLES[initialType] ? initialType : 'link');
  const [label, setLabel] = useState(initialLabel);
  // 材质轴（2026-08-23 黑板）：语义之外的第二个轴，墨线/手绘/丝线
  const [material, setMaterial] = useState(BINDING_MATERIALS[initialMaterial] ? initialMaterial : 'ink');
  const [flip, setFlip] = useState({ x: false, y: false });

  useEffect(() => {
    setFlip({ x: x + POP_W + 8 > window.innerWidth, y: y + 224 + 8 > window.innerHeight });
  }, [x, y]);

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const submit = () => {
    onSubmit?.({ type, label: label.trim(), material });
    onClose();
  };

  const ell = (s) => {
    const t = String(s || '');
    return t.length > 18 ? `${t.slice(0, 17)}…` : t;
  };

  return createPortal((
    <div
      ref={ref}
      data-no-pan
      onContextMenu={(e) => e.preventDefault()}
      // 兜底 Enter：不管焦点落在哪个子元素上，Enter 都提交
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !isImeEnter(e)) { e.stopPropagation(); submit(); }
      }}
      style={{
        position: 'fixed',
        left: flip.x ? undefined : x,
        right: flip.x ? window.innerWidth - x : undefined,
        top: flip.y ? undefined : y,
        bottom: flip.y ? window.innerHeight - y : undefined,
        width: POP_W, zIndex: 9000,
        background: COLOR.bg,
        borderRadius: RADIUS.lg,
        boxShadow: SHADOW.menu,
        padding: GAP.base,
        fontFamily: FONT_SANS,
        animation: 'ndPopIn 120ms cubic-bezier(0.32, 0.72, 0, 1)',
        display: 'flex', flexDirection: 'column', gap: GAP.sm,
      }}
    >
      {/* 两端是谁。方向感交给选中类型的箭头语义，标题只报身份 */}
      <div style={{
        fontSize: FONT_SIZE.xs, color: COLOR.sub,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {ell(fromTitle)} <span style={{ color: COLOR.text }}>⟶</span> {ell(toTitle)}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {CHIP_ORDER.filter(id => BINDING_STYLES[id]).map((id) => {
          const on = id === type;
          return (
            <button
              key={id}
              // 不抢输入框焦点：点完 chip 直接 Enter 就能落线（真机踩过——
              // 焦点跑到按钮上，Enter 变成再点一次 chip，线永远落不下去）
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setType(id)}
              style={{
                padding: '3px 10px', borderRadius: RADIUS.pill,
                border: `1px solid ${on ? COLOR.text : COLOR.borderLt}`,
                background: on ? alpha(COLOR.text, 0.08) : 'transparent',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                color: COLOR.text, cursor: 'pointer',
              }}
            >
              {BINDING_STYLES[id].label}
            </button>
          );
        })}
      </div>

      {/* 材质：同一条语义可以是安静的墨线、顺手的手绘，或侦探板上的丝线 */}
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginRight: 2 }}>材质</span>
        {Object.keys(BINDING_MATERIALS).map((id) => {
          const on = id === material;
          return (
            <button
              key={id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMaterial(id)}
              style={{
                padding: '2px 9px', borderRadius: RADIUS.pill,
                border: `1px solid ${on ? COLOR.text : COLOR.borderLt}`,
                background: on ? alpha(COLOR.text, 0.08) : 'transparent',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                color: id === 'yarn' ? PAPER.red : COLOR.text, cursor: 'pointer',
              }}
            >
              {BINDING_MATERIALS[id].label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center' }}>
        <input
          ref={inputRef}
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !isImeEnter(e)) submit();
          }}
          placeholder="写一句含义（可选，agent 逐字读）"
          maxLength={60}
          style={{
            flex: 1, minWidth: 0, padding: '6px 8px',
            border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            color: COLOR.text, background: COLOR.bgWhite, outline: 'none',
          }}
        />
        <button
          onClick={submit}
          title={mode === 'edit' ? '保存' : '落线'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: RADIUS.md,
            border: 'none', background: COLOR.text, color: COLOR.bg, cursor: 'pointer',
          }}
        >
          <Check size={15} strokeWidth={2} />
        </button>
        {mode === 'edit' && onDelete && (
          <button
            onClick={() => { onDelete(); onClose(); }}
            title="删掉这条线"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: RADIUS.md,
              border: `1px solid ${COLOR.borderLt}`, background: 'transparent',
              color: COLOR.error, cursor: 'pointer',
            }}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  ), document.body);
}
