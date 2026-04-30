import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * P1：纯 UI，messages 由父组件传入，发送只调 onSend 不接后端。
 * P3：onSend 走 WS，messages 从 SSE/WS delta 累加。
 */
export default function ChatPanel({
  messages = [], onSend, isStreaming = false,
  trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  agentProgress,
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
          <span style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.warn,
            // agentProgress 时可能很长，省略号截断
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={agentProgress ? `${agentProgress.description || ''}${agentProgress.lastTool ? ` · ${agentProgress.lastTool}` : ''}` : undefined}
          >
            {statusText}
          </span>
        )}
      </div>

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
