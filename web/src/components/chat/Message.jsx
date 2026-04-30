import { useState } from 'react';
import {
  Wrench, ChevronRight,
  FileText, FileEdit, FilePlus, Search, Terminal,
  Eye, Download, Bookmark, Send,
  ListChecks, FolderTree, Globe,
  ShieldAlert, Info, AlertCircle, CheckCircle2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

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
    return <ThinkingMessage content={content} />;
  }

  if (role === 'tool') {
    return (
      <ToolMessage
        toolName={toolName}
        toolInput={toolInput}
        toolOutput={toolOutput}
        toolError={toolError}
        toolImages={toolImages}
        status={status}
        elapsed={elapsed}
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
 * ThinkingMessage —— C26：thinking 默认展开 + 视觉区分
 *
 * 用户要求"暴露思维链"。P0 时 thinking 默认折叠（"思考过程 ▼"），
 * 用户得点开才看到——agent 思考过程几乎不可见。本次改为：
 * - 默认展开
 * - 左侧 2px 细条（视觉区分自 assistant 文本）
 * - 浅灰背景 + 等宽字体
 * - 流式时尾部 blinking 光标（typing 效果）
 * - 头部小 chip "思考中" / "思考过程" + 折叠按钮（用户想收起仍可以）
 *
 * isStreaming：父级（MessageList → Message → 这里）传是不是当前最后一条
 * thinking 在打字。但 MessageList 不知道流式状态——用 message.isStreaming
 * 字段检测。当前没维护此字段，先做"默认展开 + 视觉区分"，光标动画 stage 2。
 */
function ThinkingMessage({ content }) {
  const [open, setOpen] = useState(true);  // C26：默认展开
  return (
    <div style={{ padding: `${GAP.sm}px ${GAP.lg}px` }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
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
        THINKING
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
        }}>{content}</div>
      )}
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

function ToolMessage({ toolName, toolInput, toolOutput, toolError, toolImages, status, elapsed }) {
  const [open, setOpen] = useState(false);
  const Icon = getToolIcon(toolName);
  const isError = status === 'failed' || status === 'error';
  const isRunning = status === 'running';
  const dot = isError ? COLOR.error : isRunning ? COLOR.warn : COLOR.success;
  const summary = summarizeToolInput(toolName, toolInput);

  // 显示标签（截短 mcp__nodesign__ 前缀以省空间）
  const displayName = toolName?.startsWith('mcp__nodesign__')
    ? toolName.replace('mcp__nodesign__', '')
    : toolName;

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
