import { useState } from 'react';
import {
  Wrench, ChevronRight,
  FileText, FileEdit, FilePlus, Search, Terminal,
  Eye, Download, Bookmark, Send,
  ListChecks, FolderTree, Globe,
  ShieldAlert, Info, AlertCircle, CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * 单条消息渲染。4 种 role：
 *   - user      用户气泡（亮黑底，靠右）
 *   - assistant agent 文本（无气泡，markdown 渲染）
 *   - thinking  折叠面板（"思考过程 ▼"）
 *   - tool      工具调用 + 状态（含 input/output 折叠 + elapsed time）
 */
export default function Message({ message }) {
  const { role, content, toolName, toolInput, toolOutput, toolError, toolImages, status, elapsed } = message;

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
    return <ThinkingMessage content={content} isStreaming={message.isStreaming} />;
  }

  if (role === 'tool') {
    // C27：AskUserQuestion 走专门卡片渲染（不当普通 tool message）
    if (toolName === 'AskUserQuestion') {
      return <AskUserQuestionView toolInput={toolInput} toolOutput={toolOutput} status={status} />;
    }
    return (
      <ToolMessage
        toolName={toolName}
        toolInput={toolInput}
        toolOutput={toolOutput}
        toolError={toolError}
        toolImages={toolImages}
        status={status}
        elapsed={elapsed}
        // C28：subagent 调用时 SDK 推 task_* events，前端绑到 Task tool message
        agentType={message.agentType}
        taskStatus={message.taskStatus}
        taskSummary={message.taskSummary}
        taskLastTool={message.taskLastTool}
      />
    );
  }

  if (role === 'system') {
    return <SystemMessage variant={message.variant} content={content} />;
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

/**
 * AskUserQuestionView —— C27：agent 调用 SDK 内置 AskUserQuestion 工具的卡片渲染
 *
 * SDK 内置 AskUserQuestion 工具的 input schema：
 *   {
 *     questions: [{
 *       question: string,
 *       header: string,           // 12 字短 chip 标签
 *       options: [{ label, description, preview? }],
 *       multiSelect: boolean,
 *     }]
 *   }
 *
 * 用户点 option → setChatDraft(label) 把选项填入 chat composer，
 * 用户确认 send 后回给 agent。这是简版交互（不走 SDK control flow
 * 直接 inject 答案，stage 2 再做）。
 */
function AskUserQuestionView({ toolInput, toolOutput, status }) {
  const setChatDraft = useGlobalStore(s => s.setChatDraft);
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const isAnswered = status === 'success' && toolOutput;

  if (questions.length === 0) {
    return (
      <SystemMessage
        variant="info"
        content="Agent 调用了 AskUserQuestion 但 input 没有 questions"
      />
    );
  }

  const handlePickOption = (q, optionLabel) => {
    if (isAnswered) return;
    const headerLabel = q.header ? `[${q.header}] ` : '';
    setChatDraft(`${headerLabel}${optionLabel}`);
  };

  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      {questions.map((q, qi) => (
        <div
          key={qi}
          style={{
            marginBottom: qi < questions.length - 1 ? GAP.md : 0,
            padding: GAP.md,
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 10,
            background: '#fff',
            opacity: isAnswered ? 0.6 : 1,
          }}
        >
          {/* header chip */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: `2px ${GAP.sm}px`,
            background: 'rgba(45, 36, 24, 0.06)',
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: COLOR.text2,
            letterSpacing: '0.04em',
            marginBottom: GAP.xs + 1,
          }}>
            <HelpCircle size={10} />
            {q.header || 'AGENT 问'}
          </div>

          {/* question text */}
          <div style={{
            fontFamily: FONT_SANS,
            fontSize: FONT_SIZE.base,
            color: COLOR.text,
            lineHeight: 1.5,
            marginBottom: GAP.sm,
          }}>
            {q.question}
          </div>

          {/* options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
            {(q.options || []).map((opt, oi) => (
              <button
                key={oi}
                onClick={() => handlePickOption(q, opt.label)}
                disabled={isAnswered}
                style={{
                  textAlign: 'left',
                  padding: `${GAP.sm}px ${GAP.md}px`,
                  border: `1px solid ${COLOR.borderLt}`,
                  borderRadius: 6,
                  background: '#fff',
                  cursor: isAnswered ? 'not-allowed' : 'pointer',
                  fontFamily: FONT_SANS,
                  fontSize: FONT_SIZE.sm,
                  color: COLOR.text,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  if (isAnswered) return;
                  e.currentTarget.style.background = 'rgba(45, 36, 24, 0.04)';
                  e.currentTarget.style.borderColor = COLOR.borderHv;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = '#fff';
                  e.currentTarget.style.borderColor = COLOR.borderLt;
                }}
              >
                <div style={{ fontWeight: 500 }}>{opt.label}</div>
                {opt.description && (
                  <div style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: COLOR.sub,
                    lineHeight: 1.4,
                  }}>
                    {opt.description}
                  </div>
                )}
              </button>
            ))}
          </div>

          {q.multiSelect && (
            <div style={{
              marginTop: GAP.xs,
              fontSize: 10,
              color: COLOR.sub,
              fontStyle: 'italic',
            }}>
              （可多选 —— 简版只接受单选；多选请在 chat 里描述）
            </div>
          )}
        </div>
      ))}

      {!isAnswered && (
        <div style={{
          marginTop: GAP.xs + 2,
          fontSize: 10,
          color: COLOR.sub,
          paddingLeft: 2,
        }}>
          点选项 → 填到对话框，确认后发送给 agent
        </div>
      )}
    </div>
  );
}

/**
 * SystemMessage —— 系统级提示（区分自 assistant 消息）
 *
 * variant：
 *   - 'warn' (默认): 黄色 - PreToolUse 拦截 / 工具拦截
 *   - 'info'        : 蓝色 - 通用通知
 *   - 'error'       : 红色 - 系统错误
 *   - 'success'     : 绿色 - decision recorded / export built
 */
function SystemMessage({ variant = 'warn', content }) {
  const config = {
    warn:    { icon: ShieldAlert, color: COLOR.warn,    bgRgba: 'rgba(255, 193, 7, 0.08)',  border: 'rgba(255, 193, 7, 0.35)' },
    info:    { icon: Info,        color: COLOR.btn,     bgRgba: 'rgba(45, 36, 24, 0.05)',   border: 'rgba(45, 36, 24, 0.18)' },
    error:   { icon: AlertCircle, color: COLOR.error,   bgRgba: 'rgba(220, 53, 69, 0.06)',  border: 'rgba(220, 53, 69, 0.30)' },
    success: { icon: CheckCircle2,color: COLOR.success, bgRgba: 'rgba(40, 167, 69, 0.06)',  border: 'rgba(40, 167, 69, 0.30)' },
  }[variant] || { icon: Info, color: COLOR.text2, bgRgba: 'rgba(0,0,0,0.04)', border: COLOR.borderLt };

  const Icon = config.icon;

  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md}px`,
        background: config.bgRgba,
        border: `1px solid ${config.border}`,
        borderRadius: 8,
        fontFamily: FONT_SANS,
        fontSize: FONT_SIZE.sm,
        color: COLOR.text2,
        lineHeight: 1.5,
      }}>
        <Icon size={14} color={config.color} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * ThinkingMessage —— thinking 默认展开 + 视觉区分 + 流式光标
 *
 * - 默认展开（"暴露思维链"）
 * - 左侧 2px 细条 + 等宽字体 + 浅灰
 * - 头部 THINKING chip 可折叠
 * - isStreaming=true 时尾部一颗 blinking 光标（流式打字效果）；
 *   appendTextDelta 在 thinking 累加时设；其他内容产生 / run 收尾时清除
 */
function ThinkingMessage({ content, isStreaming }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: isStreaming ? COLOR.warn : COLOR.sub,
          padding: `${GAP.xs}px ${GAP.md - 2}px`,
          borderRadius: 4,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          letterSpacing: '0.04em',
        }}
      >
        <ChevronRight
          size={11}
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
        {isStreaming ? 'THINKING…' : 'THINKING'}
      </button>
      {open && (
        <div style={{
          marginLeft: GAP.md,
          marginTop: 2,
          paddingLeft: GAP.md,
          borderLeft: `2px solid ${COLOR.borderMd}`,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: COLOR.text4, lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          opacity: 0.85,
        }}>
          {content}
          {isStreaming && (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 7,
                height: '0.95em',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                background: COLOR.warn,
                animation: 'nd-thinking-blink 1s steps(2, start) infinite',
              }}
            />
          )}
        </div>
      )}
      <style>{`
        @keyframes nd-thinking-blink { to { visibility: hidden; } }
      `}</style>
    </div>
  );
}

// ── 工具图标映射 —— 让用户一眼看出 agent 在做什么 ──
const TOOL_ICONS = {
  Read: FileText,
  Write: FilePlus,
  Edit: FileEdit,
  Glob: FolderTree,
  Grep: Search,
  Bash: Terminal,
  TodoWrite: ListChecks,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Send,                                  // subagent 调用
  // MCP nodesign 工具
  'mcp__nodesign__screenshot_canvas': Eye,
  'mcp__nodesign__export_handoff': Download,
  'mcp__nodesign__record_decision': Bookmark,
  'mcp__nodesign__ping': Wrench,
};

function getToolIcon(toolName) {
  return TOOL_ICONS[toolName] || Wrench;
}

/**
 * 渲染工具入参的简短摘要（按工具类型挑关键字段）。
 * 比把整个 JSON 打 60 字符更可读。
 */
function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' ? input.slice(0, 80) : '';
  }
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    return input.file_path || input.path || '';
  }
  if (toolName === 'Bash') {
    return (input.command || '').slice(0, 80);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    return input.pattern || input.glob || '';
  }
  if (toolName === 'TodoWrite') {
    const todos = input.todos || [];
    return `${todos.length} todos`;
  }
  if (toolName === 'Task') {
    return `${input.subagent_type || ''}: ${(input.prompt || input.description || '').slice(0, 60)}`;
  }
  // MCP / 其他：取第一个非空字符串字段
  const firstStr = Object.values(input).find(v => typeof v === 'string' && v.length > 0);
  if (firstStr) return firstStr.slice(0, 80);
  return JSON.stringify(input).slice(0, 80);
}

/** 格式化 elapsed 秒数 */
function formatElapsed(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function ToolMessage({
  toolName, toolInput, toolOutput, toolError, toolImages, status, elapsed,
  agentType, taskStatus, taskSummary, taskLastTool,
}) {
  const [open, setOpen] = useState(false);
  const Icon = getToolIcon(toolName);

  // C28：Task 工具状态优先用 taskStatus（subagent 实际生命周期），
  // fallback 到 status（main agent tool_result）
  const effectiveStatus =
    toolName === 'Task'
      ? (taskStatus === 'completed' ? 'success'
        : taskStatus === 'failed' ? 'error'
        : taskStatus === 'stopped' ? 'error'
        : taskStatus === 'running' ? 'running'
        : status)
      : status;

  const isError = effectiveStatus === 'failed' || effectiveStatus === 'error';
  const isRunning = effectiveStatus === 'running';
  const dot = isError ? COLOR.error : isRunning ? COLOR.warn : COLOR.success;
  const summary = summarizeToolInput(toolName, toolInput);

  // 显示标签（截短 mcp__nodesign__ 前缀以省空间）
  // Task 工具：显示 "Task → vision-checker"
  let displayName = toolName?.startsWith('mcp__nodesign__')
    ? toolName.replace('mcp__nodesign__', '')
    : toolName;
  if (toolName === 'Task' && agentType) {
    displayName = `Task → ${agentType}`;
  }

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
          maxWidth: '100%',
          cursor: 'pointer',
        }}
        title={toolName}
      >
        <Icon size={11} color={COLOR.text4} style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 500, flexShrink: 0 }}>{displayName}</span>
        {summary && (
          <span style={{
            color: COLOR.sub, opacity: 0.8,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0, maxWidth: 240,
          }}>
            {summary}
          </span>
        )}
        {isRunning && elapsed != null && elapsed >= 1 && (
          <span style={{ color: COLOR.warn, fontSize: 10, flexShrink: 0 }}>
            · {formatElapsed(elapsed)}
          </span>
        )}
        <span style={{
          width: 6, height: 6, borderRadius: 3, background: dot,
          flexShrink: 0, marginLeft: 'auto',
        }} />
      </button>

      {/* C28：subagent 30s 进度摘要直接显示在 chip 下方（不必展开）*/}
      {toolName === 'Task' && (taskSummary || taskLastTool) && (
        <div style={{
          marginTop: GAP.xs,
          marginLeft: GAP.lg,
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: COLOR.sub,
          fontStyle: 'italic',
          lineHeight: 1.4,
        }}>
          {taskSummary || `· ${taskLastTool}`}
        </div>
      )}

      {open && (
        <div style={{ marginTop: GAP.sm, display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
          {/* 入参完整 JSON */}
          {toolInput && (
            <div style={{
              padding: GAP.lg,
              background: COLOR.bgCard,
              borderRadius: 8,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.text4, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 200, overflow: 'auto',
            }}>
              <div style={{ fontSize: 9, color: COLOR.sub, marginBottom: 4, letterSpacing: '0.04em' }}>INPUT</div>
              {typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2)}
            </div>
          )}

          {/* 图片 output（C24 screenshot 等返回图片）*/}
          {Array.isArray(toolImages) && toolImages.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
              <div style={{ fontSize: 9, color: COLOR.sub, letterSpacing: '0.04em' }}>OUTPUT (image)</div>
              {toolImages.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType || 'image/png'};base64,${img.data}`}
                  alt={`tool result ${i}`}
                  style={{
                    maxWidth: '100%',
                    border: `1px solid ${COLOR.borderLt}`,
                    borderRadius: 6,
                  }}
                />
              ))}
            </div>
          )}

          {/* 文本 output */}
          {toolOutput && (
            <div style={{
              padding: GAP.lg,
              background: COLOR.bgCard,
              borderRadius: 8,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.text4, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 280, overflow: 'auto',
            }}>
              <div style={{ fontSize: 9, color: COLOR.sub, marginBottom: 4, letterSpacing: '0.04em' }}>OUTPUT</div>
              {typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2)}
            </div>
          )}

          {/* 错误 */}
          {toolError && (
            <div style={{
              padding: GAP.lg,
              background: 'rgba(220, 53, 69, 0.06)',
              border: `1px solid ${COLOR.error}33`,
              borderRadius: 8,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.error, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}>
              <div style={{ fontSize: 9, opacity: 0.8, marginBottom: 4, letterSpacing: '0.04em' }}>ERROR</div>
              {typeof toolError === 'string' ? toolError : JSON.stringify(toolError, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
