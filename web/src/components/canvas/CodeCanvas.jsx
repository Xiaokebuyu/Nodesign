import Editor from '@monaco-editor/react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * CodeCanvas — Monaco 显示/编辑 HTML 源
 *
 * P1：只读显示（onChange 回调存在但不接后端）。
 * P2：blur 后存到本地 state。
 * P3：blur 后 PATCH /api/projects/:id/artifacts/:aid。
 */
export default function CodeCanvas({ value = '', onChange }) {
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', background: COLOR.bgCard }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        padding: `${GAP.sm}px ${GAP.lg}px`,
        background: 'rgba(0,0,0,0.04)',
        borderBottom: `1px solid ${COLOR.borderLt}`,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        zIndex: 1,
      }}>
        <span>deck.html</span>
        <span style={{ fontSize: 10 }}>P1: 只读 · P3 后可编辑落库</span>
      </div>
      <div style={{ position: 'absolute', top: 28, bottom: 0, left: 0, right: 0 }}>
        <Editor
          defaultLanguage="html"
          value={value}
          onChange={onChange}
          theme="light"
          options={{
            readOnly: true,
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
