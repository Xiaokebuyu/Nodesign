import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * CodeCanvas — Monaco 显示/编辑 HTML 源
 *
 * P2：可编辑。本地 draft 状态 + 800ms debounce 同步到父（避免每个 keystroke
 *      都重 render iframe）。手动按"应用"按钮立即同步。
 * P3：onChange 触发 PATCH 后端 artifact source。
 */
export default function CodeCanvas({ value = '', onChange, readOnly = false }) {
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;

  // 外部 value 变化时同步进 draft（不要覆盖用户正在编辑的内容）
  useEffect(() => {
    if (!dirty) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // debounce 同步：800ms 静止后 commit
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => onChange?.(draft), 800);
    return () => clearTimeout(t);
  }, [draft, dirty, onChange]);

  const applyNow = () => {
    if (dirty) onChange?.(draft);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', background: COLOR.bgCard, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flexShrink: 0,
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: 'rgba(0,0,0,0.04)',
        borderBottom: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>
          deck.html
          {dirty && <span style={{ color: COLOR.warn, marginLeft: GAP.sm }}>· 已修改</span>}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
          {dirty && (
            <button
              onClick={applyNow}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
                padding: `2px ${GAP.md}px`,
                fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
                color: COLOR.btnText, background: COLOR.btn,
                border: 'none', borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <Save size={10} /> 应用
            </button>
          )}
          <span style={{ fontSize: 10 }}>
            {readOnly ? '只读' : '改完会同步到 Edit / Preview'}
          </span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          defaultLanguage="html"
          value={draft}
          onChange={(v) => setDraft(v ?? '')}
          theme="light"
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'SF Mono', 'Cascadia Code', 'Menlo', monospace",
            lineNumbers: 'on',
            renderLineHighlight: 'none',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
          }}
          loading={<div style={{
            padding: GAP.xl, fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>Monaco 加载中…</div>}
        />
      </div>
    </div>
  );
}
