import { Square } from 'lucide-react';
import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import TodoPanel from './TodoPanel.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * 结构：header → TodoPanel（可选，agent 计划清单）→ MessageList → ChatComposer
 */
export default function ChatPanel({
  messages = [], onSend, isStreaming = false,
  trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  agentProgress,
  onStop,
  todos,
}) {
  // C20：subagent 30s 摘要 > "思考中…" 占位
  // - agentProgress 非空 → 用具体描述（"正在分析颜色对比度…"）
  // - 否则 fallback "agent 思考中…"
  const statusText = agentProgress
    ? (agentProgress.summary || agentProgress.description || 'agent 思考中…')
    : 'agent 思考中…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部小 header（项目级 chat 概念）*/}
      <div style={{
        padding: `${GAP.lg}px ${GAP.lg}px ${GAP.md}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: GAP.md,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: COLOR.text, letterSpacing: '0.02em', textTransform: 'uppercase',
          flexShrink: 0,
        }}>对话</span>
        {isStreaming && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: GAP.sm,
            minWidth: 0, flex: 1, justifyContent: 'flex-end',
          }}>
            <span style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.warn,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
            title={agentProgress ? `${agentProgress.description || ''}${agentProgress.lastTool ? ` · ${agentProgress.lastTool}` : ''}` : undefined}
            >
              {statusText}
            </span>
            {onStop && (
              <button
                onClick={onStop}
                title="终止生成（Esc）"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  padding: `2px ${GAP.sm}px`,
                  fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
                  color: '#fff',
                  background: COLOR.error,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = 0.85; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = 1; }}
              >
                <Square size={9} fill="#fff" /> 停止
              </button>
            )}
          </div>
        )}
      </div>

      <TodoPanel todos={todos} />
      <MessageList messages={messages} />
      <ChatComposer
        onSend={onSend}
        disabled={isStreaming}
        trayItems={trayItems}
        onRemoveTrayItem={onRemoveTrayItem}
        onPickFile={onPickFile}
        promptSuggestion={promptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
      />
    </div>
  );
}
