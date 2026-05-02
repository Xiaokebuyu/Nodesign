import { ChevronDown } from 'lucide-react';
import MessageList from './MessageList.jsx';
import ChatComposer from './ChatComposer.jsx';
import TodoPanel from './TodoPanel.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * Chat Panel — 左栏整体壳
 *
 * 结构：header → TodoPanel（可选，agent 计划清单）→ MessageList → ChatComposer
 *
 * S4：header 显示当前 session 标题（来自 SDK SDKSessionInfo.summary /
 * customTitle / firstPrompt），点击触发 SessionListModal 切换/fork/rename/tag/delete。
 */
export default function ChatPanel({
  messages = [], onSend, isStreaming = false,
  trayItems, onRemoveTrayItem, onPickFile,
  promptSuggestion, onDismissSuggestion,
  agentProgress,
  onStop,
  todos,
  sessionTitle,
  onOpenSessionList,
}) {
  // V2：streaming 状态从 header 移到 Send 按钮，header 不再显示文字。
  // agentProgress 还保留——后续如果想加进度气泡（hover Send 看 last tool）可用。
  void agentProgress;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶部 header：session selector（点击弹 SessionListModal）+ 流式状态 */}
      <div style={{
        padding: `${GAP.md}px ${GAP.lg}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: GAP.md,
      }}>
        <button
          onClick={onOpenSessionList}
          disabled={!onOpenSessionList}
          title={onOpenSessionList ? '切换 / 管理会话' : ''}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
            color: COLOR.text,
            background: 'transparent',
            border: 'none',
            borderRadius: 4,
            cursor: onOpenSessionList ? 'pointer' : 'default',
            maxWidth: '60%',
            minWidth: 0,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { if (onOpenSessionList) e.currentTarget.style.background = 'rgba(0,0,0,0.04)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0,
            letterSpacing: 0,
            textTransform: 'none',
          }}>
            {sessionTitle || '新对话'}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} color={COLOR.sub} style={{ flexShrink: 0 }} />
        </button>
      </div>

      <TodoPanel todos={todos} />
      <MessageList messages={messages} isStreaming={isStreaming} />
      <ChatComposer
        onSend={onSend}
        // disabled 给外部留口（hydrateError 等）；isRunning 单独控 Send/停止 形态
        disabled={false}
        isRunning={isStreaming}
        onStop={onStop}
        trayItems={trayItems}
        onRemoveTrayItem={onRemoveTrayItem}
        onPickFile={onPickFile}
        promptSuggestion={promptSuggestion}
        onDismissSuggestion={onDismissSuggestion}
      />
    </div>
  );
}
