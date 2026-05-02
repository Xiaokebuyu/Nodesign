import { useState, useMemo } from 'react';
import {
  Wrench, ChevronRight, ChevronLeft,
  FileText, Pencil, FilePlus, Search, Terminal,
  Eye, Download, Bookmark, Bot, Activity,
  ListChecks, FolderTree, Globe,
  ShieldAlert, Info, AlertCircle, CheckCircle2,
  HelpCircle, SkipForward, Send, Check,
  Clock4,
} from 'lucide-react';
import { diffLines } from 'diff';
import ReactMarkdown from 'react-markdown';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Turn } from '../../lib/api.js';
import TimelineNode from './TimelineNode.jsx';

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
    // A4.3：toolUseId 直传 = message.id（ProjectWorkspace 创建 tool 消息时
    // id 用 evt.blockId，blockId 就是 SDK tool_use_id）。
    if (toolName === 'AskUserQuestion') {
      return (
        <AskUserQuestionView
          toolInput={toolInput}
          toolOutput={toolOutput}
          status={status}
          toolUseId={message.id}
        />
      );
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
 * AskUserQuestionView —— SDK 内置 AskUserQuestion 工具的卡片渲染（wizard 步进版）
 *
 * SDK 内置 AskUserQuestion 工具的 input schema：
 *   {
 *     questions: [{
 *       question: string,
 *       header: string,
 *       options: [{ label, description, preview? }],
 *       multiSelect: boolean,
 *     }]
 *   } —— 单次调用 1-4 个 question，每题 2-4 个 option
 *
 * UX：一次只显示当前一题，所有题答完后**一并提交**（而不是答一题就提交一题）。
 *   - 单选 q：点 option 高亮选中；改主意可点别的覆盖
 *   - 多选 q：option 可勾可去；至少选 1 个才能下一步
 *   - 导航：[← 上一题] [跳过本题] [下一题 →] / [✓ 提交全部 (N 题)]
 *   - 跳过的题不进 answers payload —— 模型看不到这条 q（SDK 工具
 *     mapToolResultToToolResultBlockParam 只 iterate Object.entries，缺的不显示）
 *   - 全部答完按"提交全部"才一次性 POST，对应 SDK answers map 的真实语义
 *
 * 提交后流程（同 A4.3）：POST /answer → backend resolve canUseTool →
 * binary tool.call → run.delta.tool_result → status='success' → 卡片 disable
 *
 * 历史卡片（已 cancelled / 已答 / 老 session）：isAnswered=true 一开始就 disable
 * 整张卡，progress 直接显 "已完成"，所有按钮灰；POST 路径不会触发。
 */
function AskUserQuestionView({ toolInput, toolOutput, status, toolUseId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const activeRun = useGlobalStore(s => s.activeRun);
  // collected: { [questionText]: answerString }；submitted 后等 status 推回
  const [collected, setCollected] = useState({});
  // currentQuestionIdx：wizard 当前在第几题
  const [stepIdx, setStepIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const total = questions.length;
  const isAnswered = (status === 'success' && toolOutput) || status === 'error';
  const disabled = isAnswered || submitting;

  if (total === 0) {
    return (
      <SystemMessage
        variant="info"
        content="Agent 调用了 AskUserQuestion 但 input 没有 questions"
      />
    );
  }

  const currentQ = questions[Math.min(stepIdx, total - 1)];
  const currentAnswer = collected[currentQ.question];  // string（单选 label / 多选 csv）/ undefined
  const isLast = stepIdx === total - 1;
  const canBack = stepIdx > 0;

  // 多选：当前题 selected set（从 csv 反解析；空 set 表示未选）
  const multiSet = useMemo(() => {
    if (!currentQ.multiSelect || !currentAnswer) return new Set();
    return new Set(currentAnswer.split(', '));
  }, [currentQ, currentAnswer]);

  const setQuestionAnswer = (answerStr) => {
    setCollected(prev => {
      const next = { ...prev };
      if (answerStr === undefined) delete next[currentQ.question];
      else next[currentQ.question] = answerStr;
      return next;
    });
  };

  const handlePickSingle = (label) => {
    if (disabled) return;
    setQuestionAnswer(label);
  };

  const handleToggleMulti = (label) => {
    if (disabled) return;
    const next = new Set(multiSet);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setQuestionAnswer(next.size === 0 ? undefined : [...next].join(', '));
  };

  const handleBack = () => {
    if (!canBack || disabled) return;
    setStepIdx(stepIdx - 1);
  };

  const handleSkip = () => {
    if (disabled) return;
    setQuestionAnswer(undefined);  // 跳过 = 不提供答案
    if (isLast) submitAll({ ...collected, [currentQ.question]: undefined });
    else setStepIdx(stepIdx + 1);
  };

  const handleNext = () => {
    if (disabled) return;
    if (!currentAnswer) {
      showToast('请先选一个选项，或点"跳过本题"', 'info');
      return;
    }
    setStepIdx(stepIdx + 1);
  };

  const handleSubmit = () => {
    if (disabled) return;
    if (!currentAnswer) {
      showToast('请先选一个选项，或点"跳过本题"', 'info');
      return;
    }
    submitAll(collected);
  };

  // 真正的 POST。allCollected：可能含 undefined 表示跳过 → 过滤掉
  const submitAll = async (allCollected) => {
    if (!activeRun?.pid || !activeRun?.runId) {
      showToast('当前无活跃 run，无法回答历史问题', 'info');
      return;
    }
    if (!toolUseId) {
      showToast('卡片缺 toolUseId（不应发生）', 'error');
      return;
    }

    // 过滤 undefined（跳过的题）+ 防御非空 string
    const answers = {};
    for (const [k, v] of Object.entries(allCollected)) {
      if (typeof v === 'string' && v.length > 0) answers[k] = v;
    }

    setSubmitting(true);
    try {
      await Turn.answer({
        pid: activeRun.pid,
        runId: activeRun.runId,
        toolUseId,
        answers,
      });
      // 不 setSubmitting(false) —— 等 run.delta.tool_result 把 status 推成
      // success，isAnswered 接管 disable。
    } catch (err) {
      setSubmitting(false);
      const msg = err.code === 'NO_PENDING_QUESTION'
        ? '问题已不在等待中（可能已被回答 / cancel / run 结束）'
        : `回答失败：${err.message}`;
      showToast(msg, 'error');
    }
  };

  // 进度点（小圆点 + 当前数字）
  const progress = (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
      letterSpacing: '0.04em',
    }}>
      {questions.map((q, i) => {
        const filled = !!collected[q.question];
        const isCurrent = i === stepIdx && !isAnswered;
        return (
          <span
            key={i}
            title={q.header || `Q${i + 1}`}
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: filled
                ? COLOR.btn
                : (isCurrent ? COLOR.borderHv : COLOR.borderMd),
              outline: isCurrent ? `1px solid ${COLOR.borderHv}` : 'none',
              outlineOffset: 2,
            }}
          />
        );
      })}
      <span style={{ marginLeft: 6 }}>{Math.min(stepIdx + 1, total)} / {total}</span>
    </div>
  );

  // 时间轴 icon 颜色：success → 绿；error → 红；submitting/running → warn；其余 sub
  const tlIconColor = status === 'success'
    ? COLOR.success
    : status === 'error'
      ? COLOR.error
      : (submitting || !isAnswered)
        ? COLOR.warn
        : COLOR.sub;

  return (
    <TimelineNode icon={HelpCircle} iconColor={tlIconColor}>
      <div
        style={{
          padding: GAP.md,
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: 10,
          background: '#fff',
          opacity: isAnswered ? 0.6 : 1,
        }}
      >
        {/* header chip（agent 自己写的 q.header）+ 进度点 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: GAP.xs + 1,
        }}>
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
          }}>
            {currentQ.header || 'AGENT 问'}
          </div>
          {progress}
        </div>

        {/* question text */}
        <div style={{
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.base,
          color: COLOR.text,
          lineHeight: 1.5,
          marginBottom: GAP.sm,
        }}>
          {currentQ.question}
        </div>

        {/* options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
          {(currentQ.options || []).map((opt, oi) => {
            const isPicked = currentQ.multiSelect
              ? multiSet.has(opt.label)
              : currentAnswer === opt.label;
            return (
              <button
                key={oi}
                onClick={() => currentQ.multiSelect
                  ? handleToggleMulti(opt.label)
                  : handlePickSingle(opt.label)}
                disabled={disabled}
                style={{
                  textAlign: 'left',
                  padding: `${GAP.sm}px ${GAP.md}px`,
                  border: `1px solid ${isPicked ? COLOR.btn : COLOR.borderLt}`,
                  borderRadius: 6,
                  background: isPicked ? 'rgba(45, 36, 24, 0.06)' : '#fff',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: FONT_SANS,
                  fontSize: FONT_SIZE.sm,
                  color: COLOR.text,
                  transition: 'background 0.15s, border-color 0.15s',
                  display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
                }}
                onMouseEnter={e => {
                  if (disabled) return;
                  e.currentTarget.style.background = 'rgba(45, 36, 24, 0.04)';
                  e.currentTarget.style.borderColor = COLOR.borderHv;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = isPicked ? 'rgba(45, 36, 24, 0.06)' : '#fff';
                  e.currentTarget.style.borderColor = isPicked ? COLOR.btn : COLOR.borderLt;
                }}
              >
                {/* checkbox / radio dot indicator */}
                <span style={{
                  width: 14, height: 14,
                  marginTop: 2,
                  flexShrink: 0,
                  border: `1.5px solid ${isPicked ? COLOR.btn : COLOR.borderHv}`,
                  borderRadius: currentQ.multiSelect ? 3 : '50%',
                  background: isPicked ? COLOR.btn : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isPicked && <Check size={10} color={COLOR.btnText} strokeWidth={3} />}
                </span>
                <span style={{ flex: 1 }}>
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
                </span>
              </button>
            );
          })}
        </div>

        {currentQ.multiSelect && !isAnswered && (
          <div style={{
            marginTop: GAP.xs,
            fontSize: 10,
            color: COLOR.sub,
            fontStyle: 'italic',
          }}>
            （多选：可勾多个，至少选 1 个再"下一题"）
          </div>
        )}

        {/* nav buttons */}
        {!isAnswered && (
          <div style={{
            marginTop: GAP.md,
            paddingTop: GAP.sm,
            borderTop: `1px dashed ${COLOR.borderLt}`,
            display: 'flex',
            alignItems: 'center',
            gap: GAP.xs,
          }}>
            <NavBtn
              onClick={handleBack}
              disabled={disabled || !canBack}
              icon={ChevronLeft}
              label="上一题"
            />
            <NavBtn
              onClick={handleSkip}
              disabled={disabled}
              icon={SkipForward}
              label="跳过"
              variant="ghost"
            />
            <span style={{ flex: 1 }} />
            {isLast ? (
              <NavBtn
                onClick={handleSubmit}
                disabled={disabled || !currentAnswer}
                icon={Send}
                label={`提交全部 (${Object.values(collected).filter(Boolean).length}/${total})`}
                variant="primary"
              />
            ) : (
              <NavBtn
                onClick={handleNext}
                disabled={disabled || !currentAnswer}
                icon={ChevronRight}
                label="下一题"
                variant="primary"
                iconRight
              />
            )}
          </div>
        )}

        {submitting && (
          <div style={{
            marginTop: GAP.xs + 2,
            fontSize: 10,
            color: COLOR.sub,
            fontStyle: 'italic',
          }}>
            已发送给 agent，等它继续…
          </div>
        )}

        {isAnswered && (
          <div style={{
            marginTop: GAP.sm,
            paddingTop: GAP.sm,
            borderTop: `1px dashed ${COLOR.borderLt}`,
            fontSize: 10,
            color: COLOR.sub,
          }}>
            已完成
          </div>
        )}
      </div>
    </TimelineNode>
  );
}

function NavBtn({ onClick, disabled, icon: Icon, label, variant = 'default', iconRight = false }) {
  const styles = {
    default: { bg: '#fff', color: COLOR.text2, border: COLOR.borderMd },
    ghost:   { bg: 'transparent', color: COLOR.sub, border: 'transparent' },
    primary: { bg: COLOR.btn, color: COLOR.btnText, border: COLOR.btn },
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: `4px ${GAP.sm}px`,
        background: styles.bg,
        border: `1px solid ${styles.border}`,
        borderRadius: 5,
        fontFamily: FONT_SANS,
        fontSize: 11,
        color: styles.color,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {!iconRight && <Icon size={11} />}
      {label}
      {iconRight && <Icon size={11} />}
    </button>
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
 * ThinkingMessage —— Timeline 风格：Clock 图标 + 段落 + 流式光标
 *
 * 节点图标固定 Clock4，颜色区分状态（流式 warn 旋转 / 完成 sub 静态）。
 *
 * 折叠规则（两套 threshold）：
 *   1. 流式 + 内容 > STREAMING_AUTO_COLLAPSE_AT(1000 字) → 自动收起到
 *      STREAMING_PREVIEW(500 字)，不给"展开"按钮（防 thinking 无限增长占满屏）。
 *      显示总字数提示，等 streaming 结束再走规则 2。
 *   2. 非流式 + 内容 > THINKING_LONG_THRESHOLD(320 字) → 默认显示
 *      THINKING_PREVIEW_CHARS(220 字) preview + "Show more"，可手动展开。
 *
 * 流式短内容（< 1000 字）一直显示全文 —— 用户要看打字效果。
 */
const THINKING_LONG_THRESHOLD = 320;
const THINKING_PREVIEW_CHARS = 220;
const STREAMING_AUTO_COLLAPSE_AT = 1000;
const STREAMING_PREVIEW = 500;

function ThinkingMessage({ content, isStreaming }) {
  const [expanded, setExpanded] = useState(false);

  const text = content || '';
  // 流式中超长 → 强制收起防视觉爆炸
  const veryLongStreaming = isStreaming && text.length > STREAMING_AUTO_COLLAPSE_AT;
  // 非流式长内容 → 可手动展开
  const longEnough = !isStreaming && text.length > THINKING_LONG_THRESHOLD;
  // 显示全文条件：流式中超长强制 false；其余按现有逻辑
  const showFull = !veryLongStreaming && (isStreaming || expanded || !longEnough);
  const previewLen = veryLongStreaming ? STREAMING_PREVIEW : THINKING_PREVIEW_CHARS;
  const displayed = showFull ? text : text.slice(0, previewLen);

  return (
    <TimelineNode
      icon={Clock4}
      iconColor={isStreaming ? COLOR.warn : COLOR.sub}
    >
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: COLOR.text2, lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {displayed}
        {!showFull && (
          <span style={{ color: COLOR.dim }}>… </span>
        )}
        {veryLongStreaming && (
          <div style={{
            marginTop: 6,
            fontSize: FONT_SIZE.xs,
            color: COLOR.dim,
            fontStyle: 'italic',
          }}>
            思考中… 已 {text.length} 字（先收起防刷屏，思考完毕后可展开）
          </div>
        )}
        {longEnough && (
          <div style={{ marginTop: 6 }}>
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                padding: 0,
                background: 'transparent',
                border: 'none',
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
                color: COLOR.sub,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = COLOR.text2; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = COLOR.sub; }}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          </div>
        )}
      </div>
      {/* thinking 不用 shimmer —— thinking 本身就有逐字打字效果，用户能看到
          内容在动。shimmer 留给非流式 tool 调用的 running 状态（globals.css）。 */}
    </TimelineNode>
  );
}

// ── 工具图标映射 —— 让用户一眼看出 agent 在做什么 ──
const TOOL_ICONS = {
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,                                // 铅笔 = 改文件
  Glob: FolderTree,
  Grep: Search,
  Bash: Terminal,
  TodoWrite: ListChecks,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,                                   // subagent → 机器人（派任务给子代理）
  AskUserQuestion: HelpCircle,                 // 问号 = 主动问用户
  // MCP nodesign 工具
  'mcp__nodesign__screenshot_canvas': Eye,
  'mcp__nodesign__export_handoff': Download,
  'mcp__nodesign__record_decision': Bookmark,
  'mcp__nodesign__ping': Activity,             // ping → 心跳/连接
};

function getToolIcon(toolName) {
  return TOOL_ICONS[toolName] || Wrench;
}

/** 路径 → 文件名（去目录） */
function basename(p) {
  if (!p) return '';
  const s = String(p);
  return s.split('/').pop() || s;
}

/**
 * 估算 Edit / Write 的行数 diff。
 * SDK Edit 工具 result 不直接暴露行数，从 toolInput 估算：
 *   - Edit:  -<old_string 行数>  +<new_string 行数>（替换语义视为先删后增）
 *   - Write: +<content 行数>（全新写入，无删除）
 *   - 其他：null
 */
function computeFileDiff(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  if (toolName === 'Edit') {
    const old = String(input.old_string || '').split('\n');
    const next = String(input.new_string || '').split('\n');
    return { adds: next.length, dels: old.length };
  }
  if (toolName === 'Write') {
    const lines = String(input.content || '').split('\n');
    return { adds: lines.length, dels: 0 };
  }
  return null;
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

  // Task 工具状态优先用 taskStatus，fallback status
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

  // v2：节点 icon 直接用工具特定 icon（去外环），颜色按状态变
  const NodeIcon = getToolIcon(toolName);
  const iconColor = isRunning ? COLOR.warn : (isError ? COLOR.error : COLOR.sub);

  // Edit / Write 特殊渲染：文件名 + +N/-M 行数 + 展开看真 diff
  const fileDiff = computeFileDiff(toolName, toolInput);
  if (fileDiff && (toolName === 'Edit' || toolName === 'Write')) {
    const filename = basename(toolInput?.file_path || toolInput?.path);
    const canExpand = toolName === 'Edit' && (fileDiff.adds > 0 || fileDiff.dels > 0);
    return (
      <TimelineNode icon={NodeIcon} iconColor={iconColor} isSpinning={isRunning}>
        <button
          onClick={() => canExpand && setOpen(o => !o)}
          disabled={!canExpand}
          style={{
            display: 'inline-flex', alignItems: 'baseline', gap: GAP.sm,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2,
            maxWidth: '100%',
            padding: 0,
            background: 'transparent',
            border: 'none',
            cursor: canExpand ? 'pointer' : 'default',
            textAlign: 'left',
          }}
          title={toolInput?.file_path || toolInput?.path || ''}
        >
          <span
            className={isRunning ? 'nd-shimmer' : undefined}
            style={{
              fontWeight: 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              maxWidth: 200,
            }}
          >
            {filename || toolName}
          </span>
          {fileDiff.adds > 0 && (
            <span style={{ color: COLOR.success, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              +{fileDiff.adds}
            </span>
          )}
          {fileDiff.dels > 0 && (
            <span style={{ color: COLOR.error, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              −{fileDiff.dels}
            </span>
          )}
          {isRunning && elapsed != null && elapsed >= 1 && (
            <span style={{ color: COLOR.warn, fontSize: 10 }}>· {formatElapsed(elapsed)}</span>
          )}
          {isError && (
            <span style={{ color: COLOR.error, fontSize: 11 }}>失败</span>
          )}
          {canExpand && (
            <ChevronRight
              size={10}
              strokeWidth={1.75}
              color={COLOR.dim}
              style={{
                flexShrink: 0,
                alignSelf: 'center',
                transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
              }}
            />
          )}
        </button>
        {canExpand && open && (
          <DiffView
            oldStr={String(toolInput?.old_string || '')}
            newStr={String(toolInput?.new_string || '')}
          />
        )}
      </TimelineNode>
    );
  }

  // 其他工具：保留 chip 折叠展开 input/output
  const summary = summarizeToolInput(toolName, toolInput);
  let displayName = toolName?.startsWith('mcp__nodesign__')
    ? toolName.replace('mcp__nodesign__', '')
    : toolName;
  if (toolName === 'Task' && agentType) {
    displayName = `Task → ${agentType}`;
  }

  return (
    <TimelineNode icon={NodeIcon} iconColor={iconColor} isSpinning={isRunning}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          padding: 0,
          background: 'transparent', border: 'none', cursor: 'pointer',
          maxWidth: '100%',
        }}
        title={toolName}
      >
        <span
          className={isRunning ? 'nd-shimmer' : undefined}
          style={{ fontWeight: 500, flexShrink: 0 }}
        >
          {displayName}
        </span>
        {summary && (
          <span style={{
            color: COLOR.sub, opacity: 0.85,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            minWidth: 0, maxWidth: 240,
            fontWeight: 400,
          }}>
            {summary}
          </span>
        )}
        {isRunning && elapsed != null && elapsed >= 1 && (
          <span style={{ color: COLOR.warn, fontSize: 10, flexShrink: 0 }}>
            · {formatElapsed(elapsed)}
          </span>
        )}
        <ChevronRight
          size={10}
          strokeWidth={1.75}
          color={COLOR.dim}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
      </button>

      {/* subagent 30s 进度摘要 */}
      {toolName === 'Task' && (taskSummary || taskLastTool) && (
        <div style={{
          marginTop: GAP.xs,
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.xs,
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
    </TimelineNode>
  );
}

/**
 * DiffView —— Edit 工具展开后的 unified diff 渲染
 *
 * 数据来源：toolInput.old_string / new_string，前端用 `diff` 包 diffLines
 * 算行级 diff（chunks of added / removed / context lines）。SDK Edit 工具
 * 的 tool_result 是给模型看的文本，不是结构化 diff —— 前端自己算最干净，
 * 也能任意控制视觉。
 *
 * 视觉：等宽 + 行级背景色（绿 add / 红 del / 灰 context）+ 行首 +/-/空格 标记。
 * 长 diff 内滚（maxHeight 320），不挤占消息流。
 */
function DiffView({ oldStr, newStr }) {
  const rows = useMemo(() => {
    const chunks = diffLines(oldStr || '', newStr || '');
    const out = [];
    chunks.forEach((c) => {
      const lines = c.value.split('\n');
      // diffLines 每个 chunk value 末尾通常带 \n，split 后多一个 ''
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const type = c.added ? 'add' : c.removed ? 'del' : 'ctx';
      lines.forEach((line) => out.push({ type, text: line }));
    });
    return out;
  }, [oldStr, newStr]);

  if (rows.length === 0) return null;

  return (
    <div style={{
      marginTop: GAP.sm,
      background: COLOR.bgCard,
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: 6,
      fontFamily: FONT_MONO, fontSize: 11,
      lineHeight: 1.5,
      maxHeight: 320,
      overflow: 'auto',
    }}>
      {rows.map((r, i) => {
        const bg = r.type === 'add'
          ? 'rgba(74,138,74,0.10)'
          : r.type === 'del'
            ? 'rgba(184,58,42,0.08)'
            : 'transparent';
        const prefixColor = r.type === 'add'
          ? COLOR.success
          : r.type === 'del'
            ? COLOR.error
            : COLOR.dim;
        const textColor = r.type === 'ctx' ? COLOR.text4 : COLOR.text2;
        return (
          <div key={i} style={{
            display: 'flex',
            background: bg,
            color: textColor,
            padding: '0 8px',
            whiteSpace: 'pre',
          }}>
            <span style={{
              flexShrink: 0,
              width: 14,
              color: prefixColor,
              userSelect: 'none',
            }}>
              {r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>{r.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
