import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * P1：纯 UI，messages 由父组件传入，发送只调 onSend 不接后端。
 * P3：onSend 走 WS，messages 从 SSE/WS delta 累加。
 */
export default function ChatPanel({ messages = [], onSend, isStreaming = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部小 header（项目级 chat 概念）*/}
      <div style={{
        padding: `${GAP.lg}px ${GAP.lg}px ${GAP.md}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: COLOR.text, letterSpacing: '0.02em', textTransform: 'uppercase',
        }}>对话</span>
        {isStreaming && (
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.warn }}>
            agent 思考中…
          </span>
        )}
      </div>

      <MessageList messages={messages} />
      <ChatComposer onSend={onSend} disabled={isStreaming} />
    </div>
  );
}
