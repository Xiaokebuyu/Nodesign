import { useState } from 'react';
import { Wrench, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * 单条消息渲染。4 种 role：
 *   - user      用户气泡（亮黑底，靠右）
 *   - assistant agent 文本（无气泡，markdown 渲染）
 *   - thinking  折叠面板（"思考过程 ▼"）
 *   - tool      工具调用 + 状态
 */
export default function Message({ message }) {
  const { role, content, toolName, toolInput, toolOutput, status } = message;

  if (role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: `${GAP.sm}px ${GAP.lg}px` }}>
        <div style={{
          maxWidth: '85%',
          background: COLOR.btn, color: COLOR.btnText,
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderRadius: 14,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>{content}</div>
      </div>
    );
  }

  if (role === 'thinking') {
    return <ThinkingMessage content={content} />;
  }

  if (role === 'tool') {
    return (
      <ToolMessage
        toolName={toolName}
        toolInput={toolInput}
        toolOutput={toolOutput}
        status={status}
      />
    );
  }

  // assistant
  return (
    <div style={{
      padding: `${GAP.sm}px ${GAP.lg}px`,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
      color: COLOR.text2, lineHeight: 1.6,
    }}>
      <div className="md-content">
        <ReactMarkdown>{content || ''}</ReactMarkdown>
      </div>
      <style>{`
        .md-content p { margin: 0 0 8px 0; }
        .md-content p:last-child { margin-bottom: 0; }
        .md-content code { background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 3px; font-family: ${FONT_MONO}; font-size: 12px; }
        .md-content pre { background: ${COLOR.bgCard}; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
        .md-content ul, .md-content ol { margin: 0 0 8px 0; padding-left: 20px; }
        .md-content li { margin: 2px 0; }
        .md-content a { color: ${COLOR.btn}; text-decoration: underline; }
      `}</style>
    </div>
  );
}

function ThinkingMessage({ content }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          padding: `${GAP.xs}px ${GAP.md}px`, borderRadius: 6,
          background: 'rgba(0,0,0,0.03)',
        }}
      >
        <ChevronRight
          size={12}
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
        思考过程
      </button>
      {open && (
        <div style={{
          marginTop: GAP.sm,
          padding: GAP.lg,
          background: COLOR.bgCard,
          borderRadius: 8,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
          color: COLOR.text4, lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}>{content}</div>
      )}
    </div>
  );
}

function ToolMessage({ toolName, toolInput, toolOutput, status }) {
  const [open, setOpen] = useState(false);
  const dot = status === 'failed' ? COLOR.error : status === 'running' ? COLOR.warn : COLOR.success;
  const inputBrief = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {}).slice(0, 60);

  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          padding: `${GAP.xs}px ${GAP.md}px`, borderRadius: 6,
          background: 'rgba(0,0,0,0.03)',
          border: `1px solid ${COLOR.borderLt}`,
        }}
      >
        <Wrench size={11} color={COLOR.text4} />
        <span style={{ fontWeight: 500 }}>{toolName}</span>
        <span style={{ color: COLOR.sub, opacity: 0.8 }}>{inputBrief}{inputBrief.length >= 60 ? '…' : ''}</span>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: dot }} />
      </button>
      {open && toolOutput && (
        <div style={{
          marginTop: GAP.sm,
          padding: GAP.lg,
          background: COLOR.bgCard,
          borderRadius: 8,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: COLOR.text4, lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          maxHeight: 200, overflow: 'auto',
        }}>{typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2)}</div>
      )}
    </div>
  );
}
