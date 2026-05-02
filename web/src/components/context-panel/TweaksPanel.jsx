import { useEffect, useState, useCallback } from 'react';
import { Sliders, RotateCcw, Check, Sparkles } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Spec } from '../../lib/api.js';

/**
 * TweaksPanel — agent 暴露的 deck 专属可调参数控制台（C5）
 *
 * 数据流：
 *   1. agent 调 mcp__nodesign__expose_tweaks 写 spec.tweaks.controls[]
 *   2. 后端 emit run.tweaks_exposed 事件 → ProjectWorkspace bump tweaksReloadKey
 *   3. 本组件读 Spec.read 拿 spec.tweaks，按 schema 渲染控件
 *   4. 拖 slider / 切 color picker → setProperty(--xxx, value) on iframe :root
 *      （实时预览，不落盘）
 *   5. Reset → 移除所有 inline style + 控件值回 default
 *   6. Apply → 触发 chat run "把当前数值固化到 canvas.html 的 :root"
 *
 * Schema (与 expose_tweaks MCP 工具 inputSchema 同构)：
 *   {
 *     id: string,
 *     type: 'slider' | 'color' | 'segmented' | 'toggle' | 'select',
 *     label: string,
 *     description?: string,
 *     target_var?: string,        // CSS custom property (--开头)
 *     target_class_on?: string,   // class 名（toggle / segmented 类）
 *     min?, max?, step?, default,
 *     unit?: string,              // px / % / em
 *     options?: [{ label, value }],
 *   }
 */
export default function TweaksPanel({
  projectId, sessionId, iframeDoc, iframeRef, reloadKey = 0,
  onChat,
}) {
  const [controls, setControls] = useState([]);
  const [values, setValues] = useState({});
  const [meta, setMeta] = useState({ updatedAt: null, version: null });
  const [loading, setLoading] = useState(false);

  // 读 spec.tweaks
  useEffect(() => {
    if (!projectId || !sessionId) {
      setControls([]); setValues({}); return;
    }
    let cancelled = false;
    setLoading(true);
    Spec.read(projectId, sessionId)
      .then((r) => {
        if (cancelled) return;
        const tweaks = r?.spec?.tweaks;
        const arr = Array.isArray(tweaks?.controls) ? tweaks.controls : [];
        setControls(arr);
        setMeta({ updatedAt: tweaks?.updatedAt || null, version: tweaks?.version || null });
        const init = {};
        for (const c of arr) init[c.id] = c.default;
        setValues(init);
      })
      .catch(() => { if (!cancelled) { setControls([]); setValues({}); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, sessionId, reloadKey]);

  // A6.2：scope-aware CSS var 应用。control.target_scope 是 CSS selector，
  // 不传默认 ":root"。用 doc.querySelector(scope) 找 scope 元素在它身上
  // setProperty —— 配合 SKILL.md HTML 规范的 per-page scoped override 让
  // "封面字号"slider 不牵连内页字号。
  const resolveScopeEl = useCallback((doc, scope) => {
    if (!doc) return null;
    const sel = scope || ':root';
    if (sel === ':root') return doc.documentElement;
    try {
      const el = doc.querySelector(sel);
      if (!el) console.warn(`[TweaksPanel] target_scope "${sel}" not found in iframe`);
      return el;
    } catch (err) {
      console.warn(`[TweaksPanel] invalid target_scope selector "${sel}":`, err.message);
      return null;
    }
  }, []);

  const applyToIframe = useCallback((control, value) => {
    const doc = iframeDoc || iframeRef?.current?.contentDocument;
    if (!doc) return;
    const scopeEl = resolveScopeEl(doc, control.target_scope);
    if (!scopeEl) return;  // selector miss → 跳过本次 apply（已 console.warn）
    if (control.target_var) {
      const v = control.unit ? `${value}${control.unit}` : String(value);
      scopeEl.style.setProperty(control.target_var, v);
    } else if (control.target_class_on) {
      scopeEl.classList.toggle(control.target_class_on, !!value);
    }
  }, [iframeDoc, iframeRef, resolveScopeEl]);

  const handleChange = (control, value) => {
    setValues(v => ({ ...v, [control.id]: value }));
    applyToIframe(control, value);
  };

  const handleReset = () => {
    const doc = iframeDoc || iframeRef?.current?.contentDocument;
    if (!doc) return;
    for (const c of controls) {
      const scopeEl = resolveScopeEl(doc, c.target_scope);
      if (!scopeEl) continue;
      if (c.target_var) scopeEl.style.removeProperty(c.target_var);
      else if (c.target_class_on) scopeEl.classList.remove(c.target_class_on);
    }
    const init = {};
    for (const c of controls) init[c.id] = c.default;
    setValues(init);
  };

  const handleApply = () => {
    if (controls.length === 0) return;
    // A6.2：序列化 (target_var, target_scope, value) 让 agent 知道每条该写
    // 哪个 selector 的 CSS rule。不传 scope = :root 全局；其他 selector 写
    // <scope> { --xxx: value; } per-page scoped override（详见 SKILL.md）。
    const summary = controls.map(c => {
      const v = values[c.id];
      const display = c.unit ? `${v}${c.unit}` : v;
      const target = c.target_var || `class:${c.target_class_on}`;
      const scope = c.target_scope || ':root';
      return `- ${c.id} → ${target} = ${display}  @ ${scope}`;
    }).join('\n');
    onChat?.(`把当前 tweaks 的实时数值固化到 canvas.html 对应 CSS rule 里（按下方 @ scope —— ":root" 写到 :root 块；其他 selector 写 \`<scope> { --xxx: value; }\` 加在 design-tokens style 块底部 per-page override 区），不要改其他东西：\n${summary}\n\n固化完后调 mcp__nodesign__expose_tweaks 用更新后的 default 值重新暴露这套 schema。`);
  };

  const handleExposeCTA = () => {
    onChat?.('请基于当前 deck 暴露 5-8 个最有价值的可调参数（hero 字号 / 主色 / 间距密度 / layout variant 等），调 mcp__nodesign__expose_tweaks 写入 spec。');
  };

  if (loading && controls.length === 0) {
    return (
      <div style={{ padding: GAP.lg, textAlign: 'center', color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm }}>
        加载中…
      </div>
    );
  }

  if (controls.length === 0) {
    return <EmptyState onCTA={handleExposeCTA} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: GAP.lg }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          textTransform: 'uppercase', letterSpacing: '0.05em',
          marginBottom: GAP.sm,
          display: 'flex', alignItems: 'center', gap: GAP.xs,
        }}>
          <Sliders size={11} /> 可调参数 ({controls.length})
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.lg }}>
          {controls.map(c => (
            <ControlRow
              key={c.id}
              control={c}
              value={values[c.id]}
              onChange={(v) => handleChange(c, v)}
            />
          ))}
        </div>
      </div>

      <div style={{
        flexShrink: 0,
        padding: `${GAP.md}px ${GAP.lg}px`,
        borderTop: `1px solid ${COLOR.borderLt}`,
        background: 'rgba(255,255,255,0.95)',
        display: 'flex', gap: GAP.sm,
      }}>
        <button
          onClick={handleReset}
          style={btnSecondary}
          title="所有控件回到 default 值，并清掉 iframe :root 的 inline style"
        >
          <RotateCcw size={11} /> Reset
        </button>
        <div style={{ flex: 1 }} />
        <button
          onClick={handleApply}
          style={btnPrimary}
          title="发 chat 让 AI 把当前数值固化进 canvas.html 的 CSS variables 定义"
        >
          <Check size={11} /> Apply
        </button>
      </div>
    </div>
  );
}

function ControlRow({ control, value, onChange }) {
  const labelEl = (
    <div style={{
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
      marginBottom: 4, display: 'flex', alignItems: 'baseline', gap: GAP.xs,
    }}>
      <span style={{ flex: 1 }}>{control.label}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub }}>
        {control.unit ? `${value}${control.unit}` : String(value)}
      </span>
    </div>
  );

  return (
    <div>
      {labelEl}
      {renderControl(control, value, onChange)}
      {control.description && (
        <div style={{
          fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
          marginTop: 2, lineHeight: 1.4,
        }}>{control.description}</div>
      )}
    </div>
  );
}

function renderControl(c, value, onChange) {
  switch (c.type) {
    case 'slider': {
      return (
        <input
          type="range"
          min={c.min ?? 0} max={c.max ?? 100} step={c.step ?? 1}
          value={Number(value) || 0}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: '100%', accentColor: COLOR.btn }}
        />
      );
    }
    case 'color': {
      return (
        <input
          type="color"
          value={String(value || '#000000')}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 64, height: 28, border: `1px solid ${COLOR.borderLt}`, borderRadius: 4, cursor: 'pointer' }}
        />
      );
    }
    case 'segmented': {
      const opts = c.options || [];
      return (
        <div style={{ display: 'inline-flex', background: 'rgba(0,0,0,0.05)', borderRadius: 4, padding: 2 }}>
          {opts.map(opt => {
            const active = String(opt.value) === String(value);
            return (
              <button
                key={opt.value}
                onClick={() => onChange(opt.value)}
                style={{
                  padding: `${GAP.xs}px ${GAP.md}px`,
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
                  color: active ? COLOR.text : COLOR.sub,
                  background: active ? '#fff' : 'transparent',
                  borderRadius: 3,
                  boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >{opt.label}</button>
            );
          })}
        </div>
      );
    }
    case 'toggle': {
      const on = !!value;
      return (
        <button
          onClick={() => onChange(!on)}
          style={{
            width: 36, height: 18,
            borderRadius: 9, padding: 0,
            background: on ? COLOR.btn : 'rgba(0,0,0,0.15)',
            position: 'relative',
            transition: 'background 0.15s',
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: on ? 20 : 2,
            width: 14, height: 14, borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }} />
        </button>
      );
    }
    case 'select': {
      const opts = c.options || [];
      return (
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            color: COLOR.text2, background: '#fff',
            border: `1px solid ${COLOR.borderLt}`, borderRadius: 4,
          }}
        >
          {opts.map(opt => (
            <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
          ))}
        </select>
      );
    }
    default:
      return (
        <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.error }}>
          unsupported control type: {c.type}
        </span>
      );
  }
}

function EmptyState({ onCTA }) {
  return (
    <div style={{ padding: GAP.lg, textAlign: 'center' }}>
      <Sliders size={28} color={COLOR.dim} style={{ marginBottom: GAP.md, opacity: 0.5 }} />
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
        lineHeight: 1.6, marginBottom: GAP.lg,
      }}>
        当前 deck 还没有暴露可调参数。<br />
        让 AI 看看 deck 然后给一组最有价值的 sliders / 配色 / segmented control。
      </div>
      <button
        onClick={onCTA}
        style={{
          ...btnPrimary,
          margin: '0 auto',
          padding: `${GAP.sm}px ${GAP.lg}px`,
        }}
      >
        <Sparkles size={11} /> 让 AI 暴露可调参数
      </button>
    </div>
  );
}

const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  border: `1px solid ${COLOR.btn}`, borderRadius: 4,
  cursor: 'pointer',
};

const btnSecondary = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.xs + 1}px ${GAP.md}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
  color: COLOR.text4, background: 'rgba(0,0,0,0.04)',
  border: `1px solid ${COLOR.borderLt}`, borderRadius: 4,
  cursor: 'pointer',
};
