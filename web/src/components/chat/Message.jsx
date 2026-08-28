import { useState, useMemo, memo } from 'react';
import {
  ChevronRight, ChevronLeft, ShieldAlert, Info, AlertCircle, CheckCircle2,
  HelpCircle, SkipForward, Send, Check, Clock4,
} from 'lucide-react';
import { diffLines } from 'diff';
import MarkdownText from './MarkdownText.jsx';
import { Undo2 } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Turn, Sessions } from '../../lib/api.js';
import TimelineNode from './TimelineNode.jsx';
import { getToolIcon, isSubagentTool } from './tool-icons.js';
import { parseAnnotationMessage, annotationTargets } from '../../lib/annotation-message.js';
import AnnotationNote from './AnnotationNote.jsx';
import { useTimelinePosition } from './TimelineGroupContext.js';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * 单条消息渲染。4 种 role：
 *   - user      用户气泡（亮黑底，靠右）
 *   - assistant agent 文本（无气泡，markdown 渲染）
 *   - thinking  折叠面板（"思考过程 ▼"）
 *   - tool      工具调用 + 状态（含 input/output 折叠 + elapsed time）
 */
function Message({ message, projectId, sessionId, onCanvasReload }) {
  // V7：assistant 进 timeline group（V6 grouping 决定）但**不包 TimelineNode**——
  // 用户反馈：默认给个对话气泡 icon 不 OK，"实在不行也别给 icon，就放那"。
  // 所以 assistant 在 group 内 / group 外都走 bare 渲染，timeline 竖线在那段断开
  // 是接受的。useTimelinePosition 只用来调左 padding 让正文跟其他 timeline 节点
  // 内容对齐（不左对节点 icon 列）。
  const inTimeline = useTimelinePosition() !== null;
  const { role, content, toolName, toolInput, toolOutput, toolError, toolImages, status, elapsed } = message;

  if (role === 'user') {
    return (
      <UserMessage
        message={message}
        projectId={projectId}
        sessionId={sessionId}
        onCanvasReload={onCanvasReload}
      />
    );
  }

  if (role === 'thinking') {
    return <ThinkingMessage content={content} isStreaming={message.isStreaming} />;
  }

  if (role === 'tool') {
    // C27：AskUserQuestion 走专门卡片渲染（不当普通 tool message）
    // A4.3：toolUseId 直传 = message.id（ProjectWorkspace 创建 tool 消息时
    // id 用 evt.blockId，blockId 就是 SDK tool_use_id）。
    //
    // SDK streaming 设计：run.tool_use.started 事件不含 input（仅 blockId+name），
    // 之后才推 run.delta.tool_use 带完整 input；中间 toolInput===undefined 期间
    // 直接走 AskUserQuestionView 会触发 questions 长度 0 的 fallback "调用了但没填"。
    // 这里在路由层先拦一次：streaming 中（status=running 且 toolInput 还没到）
    // 渲染 timeline pending 节点（参考 ToolMessage 的 nd-shimmer 模式）。
    if (toolName === 'AskUserQuestion' && status === 'running' && !toolInput) {
      return <ToolPendingNode toolName="AskUserQuestion" />;
    }
    if (toolName === 'AskUserQuestion') {
      // 2026-07-28：问题面板的主场在工作台画布（StageLayer 的 QuestionStageCard）。
      // 侧边栏只留一张摘要卡——同一个 /answer 端点两处都能答，但聊天栏默认不再
      // 铺一整个 wizard 抢戏；画布卡被关掉 / 刷新丢了时点"在这里答"展开兜底。
      return (
        <AskUserQuestionBrief
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
        taskSummaryLog={message.taskSummaryLog}
        taskDescription={message.taskDescription}
        taskLastTool={message.taskLastTool}
        // S3b：SubagentStop hook 收尾时挂的 lastAssistantMessage（vision-checker
        // critique 卡的数据源）
        subagentResult={message.subagentResult}
      />
    );
  }

  if (role === 'system') {
    return <SystemMessage variant={message.variant} content={content} pending={!!message.pending} />;
  }

  // assistant（正文渲染连同 LaTeX 都在 MarkdownText.jsx，2026-08-15 拆出）
  const mdContent = <MarkdownText>{content || ''}</MarkdownText>;

  // V7：bare 渲染（无 icon、无 TimelineNode）。在 group 内左 padding 加大让正文
  // 跟其他 timeline 节点的 children 对齐（PAD_LEFT + NODE_AREA + CONTENT_GAP =
  // 12 + 18 + 6 = 36px）；group 外保留原来 GAP.lg 的左 padding。
  const padLeft = inTimeline ? 36 : GAP.lg;
  return (
    <div style={{
      padding: `${GAP.sm}px ${GAP.lg}px ${GAP.sm}px ${padLeft}px`,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
      color: COLOR.text2, lineHeight: 1.6,
    }}>
      {mdContent}
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

/**
 * UserMessage —— 用户消息气泡 + 悬停 Undo 按钮（rewindFiles）。
 *
 * Undo 按钮逻辑：
 *   - 仅在 hover + projectId/sessionId 都已知时显示
 *   - 点击 → confirm → POST /api/projects/:pid/sessions/:sid/rewind { userMessageId: message.id }
 *   - 后端调 SDK Query.rewindFiles() 把所有文件回滚到该 user message 之前
 *   - 成功 → toast + onCanvasReload()（让 iframe bump reloadToken）
 *   - 410 (session 已 close) → toast 'session 已关闭，无法撤销'
 */
// SDK uuid 36-char 形态（"abc12345-1234-1234-1234-123456789abc"）—— SDK Query.rewindFiles
// 只认这个；前端乐观插入的 newId('msg') = "msg_xxx" 拿来调会被 SDK 拒（canRewind:false）
// 一闪即逝，用户感觉"无反应"。所以 undo 按钮只在 hydrate 来的真 uuid 上启用。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function UserMessage({ message, projectId, sessionId, onCanvasReload }) {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  // 画布标注那条：机械描述默认折起来，见下面 anno
  const [annoOpen, setAnnoOpen] = useState(false);

  // 场务托词（08-28 自动召回无扰化）：nd:gm-nudge 替玩家发的召回请托是机器话，
  // 不占一整个用户气泡 —— 渲染成一行淡色场记，指令尾巴（SendMessage 那段）不给人看。
  const plainText = typeof message.content === 'string' ? message.content : '';
  if (plainText.startsWith('【场务】')) {
    return (
      <div style={{ fontSize: 12, opacity: 0.55, padding: '2px 8px', fontStyle: 'italic' }}>
        {plainText.split('——')[0]}
      </div>
    );
  }

  /**
   * 画布标注（2026-08-28 用户报「完整的附加内容都被显示在侧边栏」）：
   * 用户在板上圈一段字回话，前端拼的那条里有路径、作者、原文摘录、reply_to 指令 ——
   * 那些是**给 agent 的**（它要靠它们接线程），发出去的内容一个字不动；
   * 但侧边栏原样显示，用户自己那句话淹在机械里。这里只管显示：机械折起来，
   * 留一行小字说标了什么，点开能看全。拆分判据在 lib/annotation-message.js（有单测）。
   */
  const anno = parseAnnotationMessage(plainText);
  const annoWhat = anno ? annotationTargets(anno.desc) : [];

  const canUndo = !!(projectId && sessionId && message.id && UUID_RE.test(message.id));

  async function handleUndo() {
    if (!canUndo || busy) return;
    if (!(await confirm({ title: '回到此处', message: '回到此处？这会丢弃后续所有文件改动。\n\n历史会话首次回滚需 3-5 秒（重启临时会话）；后续回滚瞬间完成。', confirmLabel: '回滚', danger: true }))) return;
    setBusy(true);
    try {
      const result = await Sessions.rewind(projectId, sessionId, message.id);
      if (result?.canRewind === false) {
        showToast(result.error || '此处不支持回滚', 'warn');
      } else {
        const n = result?.filesChanged?.length || 0;
        // iframe reload 由后端 emit 的 run.file_changed event 自动触发（ProjectWorkspace 已 case），
        // 不再依赖 onCanvasReload —— 但保留兼容调用（active query 路径同步返回时也 bump）
        const talk = result?.conversationTruncated ? '，对话已截回该处' : '';
        showToast(n > 0 ? `已回滚 ${n} 个文件${talk}` : `已回滚${talk || '（无文件改动）'}`, 'success');
        if (onCanvasReload) onCanvasReload();
        // 对话层已被服务端截断 → 通知 ProjectWorkspace 重拉消息（免传三层 props）
        if (result?.conversationTruncated) {
          window.dispatchEvent(new CustomEvent('nd-conversation-rewound', { detail: { sessionId } }));
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('REWIND_BUSY') || msg.includes('409')) {
        showToast('上一个回滚还在进行，稍候重试', 'warn');
      } else if (msg.includes('JSONL_MISSING') || msg.includes('404')) {
        showToast('会话历史已删，无法回滚', 'warn');
      } else if (msg.includes('REWIND_FAILED') || msg.includes('timeout')) {
        showToast('回滚超时，请重试（临时会话启动较慢时偶发）', 'error');
      } else {
        showToast(`回滚失败：${msg}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ display: 'flex', justifyContent: 'flex-end', padding: `${GAP.sm}px ${GAP.lg}px`, position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {canUndo && hover && (
        <button
          onClick={handleUndo}
          disabled={busy}
          title="回滚到此处之前的状态（撤销后续所有文件改动）"
          style={{
            position: 'absolute',
            top: 4,
            right: GAP.lg,
            display: 'flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.md}px`,
            background: COLOR.bgCard,
            color: COLOR.text2,
            border: `1px solid ${COLOR.border}`,
            borderRadius: RADIUS.md,
            fontSize: FONT_SIZE.xs || 11,
            fontFamily: FONT_SANS,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 0.95,
            zIndex: 1,
          }}
        >
          <Undo2 size={11} />
          {busy ? '回滚中...' : '回到此处'}
        </button>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '85%', minWidth: 0 }}>
        {anno && (
          <AnnotationNote desc={anno.desc} what={annoWhat} open={annoOpen} onToggle={() => setAnnoOpen((v) => !v)} />
        )}
        <div style={{
          background: COLOR.btn, color: COLOR.btnText,
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderRadius: 14,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>{anno ? anno.text : message.content}</div>
      </div>
    </div>
  );
}

/**
 * Phase Image-5：preview 字段的智能渲染分派。
 *
 * Agent 用 AskUserQuestion 时 preview 字段历史上只接 HTML（sandbox iframe）。
 * 加图片生成后我们希望同样卡片能 preview 图（多变体并排选 cover/portrait）。
 * 走轻量路线 A：前端 wrapper 检测 preview 内容形态自动分派。
 *
 * 检测规则（按优先级）：
 *   1. data:image/* base64 URL → 直接 <img>（agent 把 generate_image 出的 image
 *      base64 拼成 data URL 当 preview）
 *   2. http(s)://...  /api/.../assets/...  以 .png/.jpg/.jpeg/.webp/.gif 结尾的 URL
 *      → <img>（agent 把 assets/generated/ 路径或网络图当 preview）
 *   3. assets/... 相对路径（agent 简写）→ <img>（用 srcset 容错）
 *   4. 含 < / > 看起来像 HTML → iframe srcDoc（旧逻辑）
 *   5. 都不像 → text 兜底
 */
function renderQuestionPreview(preview, label) {
  if (!preview || typeof preview !== 'string') return null;
  const s = preview.trim();

  // 规则 1: data: URL
  const isDataImg = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(s);
  // 规则 2: http(s) URL ending in image ext
  const isHttpImg = /^https?:\/\/\S+\.(png|jpe?g|webp|gif|svg)(\?\S*)?$/i.test(s);
  // 规则 2b: 同源 /api/... assets endpoint
  const isApiAssetUrl = /^\/api\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?\S*)?$/i.test(s);
  // 规则 3: assets/ 相对路径
  const isAssetRelPath = /^assets\/[^\s]+\.(png|jpe?g|webp|gif|svg)$/i.test(s) && !s.includes('<');

  if (isDataImg || isHttpImg || isApiAssetUrl || isAssetRelPath) {
    // 相对路径 → 不能直接当 src（前端 base 不一定对），加注释提示
    // 实际情况：agent 通常会用 data: URL 或 /api/... 完整 URL；assets/ 相对路径作 fallback
    return (
      <div style={{
        marginTop: GAP.xs + 2,
        width: '100%',
        aspectRatio: '4 / 3',
        borderRadius: RADIUS.sm,
        overflow: 'hidden',
        border: `1px solid ${COLOR.borderLt}`,
        background: '#fafafa',
      }}>
        <img
          src={s}
          alt={`preview-${label}`}
          loading="lazy"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none',  // 点击穿透到 button onClick
          }}
        />
      </div>
    );
  }

  // 规则 4: HTML（默认旧逻辑）
  const looksLikeHtml = /<[a-z][\s\S]*?>/i.test(s);
  if (looksLikeHtml) {
    return (
      <div style={{
        marginTop: GAP.xs + 2,
        width: '100%',
        borderRadius: RADIUS.sm,
        overflow: 'hidden',
        border: `1px solid ${COLOR.borderLt}`,
        background: '#fafafa',
      }}>
        <iframe
          title={`preview-${label}`}
          srcDoc={s}
          sandbox=""
          style={{
            display: 'block',
            width: '100%',
            height: 140,
            border: 'none',
            background: COLOR.bgWhite,
            pointerEvents: 'none',
          }}
        />
      </div>
    );
  }

  // 规则 5: text 兜底
  return (
    <div style={{
      marginTop: GAP.xs + 2,
      padding: GAP.xs,
      fontSize: FONT_SIZE.sm,
      color: COLOR.text3,
      fontFamily: FONT_MONO,
      background: COLOR.bgCard,
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: RADIUS.sm,
    }}>
      {s.length > 200 ? s.slice(0, 200) + '…' : s}
    </div>
  );
}

/**
 * ToolPendingNode —— 工具流式输入阶段的 timeline pending 占位。
 *
 * 用途：SDK run.tool_use.started 事件只带 name/blockId，不含 input；
 * run.delta.tool_use 才推完整 input（中间间隔 100ms ~ 数秒）。期间 toolInput
 * 是 undefined。普通工具走 ToolMessage 时由 isRunning + nd-shimmer 自然处理；
 * AskUserQuestion 走专门 wizard 卡片，没有这层兜底，需要本组件占位。
 *
 * 只对 input 必需才能渲染的特殊工具用（目前只 AskUserQuestion）。
 */
function ToolPendingNode({ toolName }) {
  const NodeIcon = getToolIcon(toolName);
  const displayName = toolName?.startsWith('mcp__nodesign__')
    ? toolName.replace('mcp__nodesign__', '')
    : toolName;
  return (
    <TimelineNode icon={NodeIcon} iconColor={COLOR.warn} isSpinning={true}>
      <span
        className="nd-shimmer"
        style={{
          fontFamily: FONT_MONO,
          fontSize: FONT_SIZE.sm,
          color: COLOR.text2,
          fontWeight: 500,
        }}
      >
        {displayName}
      </span>
    </TimelineNode>
  );
}

/**
 * tool_result 里捞 { 问题: 答案 }。SDK 的回填是一句自由文本：
 *   Your questions have been answered: "问题"="答案". You can now continue…
 * 先按这个形状抠引号对，抠不出再当 JSON 试一次，都不行就返 null（卡片退回整段回显）。
 */
function answerMapOf(toolOutput) {
  let v = toolOutput;
  if (typeof v === 'string') {
    const pairs = {};
    const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(v))) pairs[m[1]] = m[2];
    if (Object.keys(pairs).length) return pairs;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const src = (v.answers && typeof v.answers === 'object') ? v.answers : v;
  const out = {};
  for (const [k, val] of Object.entries(src)) {
    if (typeof val === 'string' && val) out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * AskUserQuestionBrief —— 聊天栏的问题摘要卡（2026-07-28）
 *
 * 作答面板已经常驻工作台画布，侧边栏再铺一整个 wizard 是重复的。这里只报
 * "问了什么 / 答了什么"，需要时点开兜底 wizard（画布卡关掉、刷新丢了、
 * 或者用户就想在聊天栏答）。两处走同一个 /answer，谁先答谁生效。
 */
function AskUserQuestionBrief({ toolInput, toolOutput, status, toolUseId }) {
  const [expanded, setExpanded] = useState(false);
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const answered = (status === 'success' && toolOutput) || status === 'error';
  const answers = answered ? answerMapOf(toolOutput) : null;
  // 一条都对不上题（SDK 文案改了 / 问题文本被裁过）→ 退一步整段回显一行
  const matched = answers ? questions.filter(q => answers[q.question]).length : 0;
  const flatEcho = (answered && matched === 0 && typeof toolOutput === 'string')
    ? toolOutput.trim().replace(/\s+/g, ' ').slice(0, 160) : '';

  if (expanded) {
    return (
      <AskUserQuestionView
        toolInput={toolInput}
        toolOutput={toolOutput}
        status={status}
        toolUseId={toolUseId}
      />
    );
  }
  if (questions.length === 0) {
    return <SystemMessage variant="error" content="Agent 调用了 AskUserQuestion 但 input.questions 为空（SDK schema 违规）" />;
  }

  const TlIcon = status === 'success' ? CheckCircle2 : status === 'error' ? AlertCircle : HelpCircle;
  const tlIconColor = status === 'success' ? COLOR.success : status === 'error' ? COLOR.error : COLOR.warn;

  return (
    <TimelineNode icon={TlIcon} iconColor={tlIconColor}>
      <div style={{
        padding: `${GAP.sm}px ${GAP.md}px`,
        border: `1px solid ${answered ? COLOR.borderLt : COLOR.borderMd}`,
        borderRadius: 2,
        background: COLOR.bgWhite,
        boxShadow: PAPER_SHADOW.far,
        opacity: answered ? 0.7 : 1,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, letterSpacing: '0.04em',
        }}>
          <span style={{ color: COLOR.text2 }}>AGENT 问</span>
          <span>·</span>
          <span>{questions.length} 题</span>
          <span style={{ marginLeft: 'auto' }}>
            {status === 'error' ? '已取消' : answered ? '已回答' : '面板在画布上'}
          </span>
        </div>

        <div style={{ marginTop: GAP.xs + 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {questions.map((q, i) => {
            const a = answers?.[q.question];
            return (
              <div key={i} style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, lineHeight: 1.5 }}>
                <span style={{
                  color: COLOR.text,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'block',
                }}>{q.header ? `${q.header}：` : ''}{q.question}</span>
                {a && (
                  <span style={{
                    display: 'block', color: COLOR.sub, fontSize: FONT_SIZE.sm,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>→ {a}</span>
                )}
              </div>
            );
          })}
          {flatEcho && (
            <span style={{
              color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>→ {flatEcho}</span>
          )}
        </div>

        {!answered && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              marginTop: GAP.sm, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.md,
              background: COLOR.bgWhite, color: COLOR.text2, cursor: 'pointer',
              boxShadow: PAPER_SHADOW.far,
              padding: `3px ${GAP.sm}px`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
            }}
          >在这里答</button>
        )}
      </div>
    </TimelineNode>
  );
}

// export：工作台画布的舞台层也渲染这张卡（agent 提问直接在画布里答）
export function AskUserQuestionView({ toolInput, toolOutput, status, toolUseId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const activeRun = useGlobalStore(s => s.activeRun);
  // collected: { [questionText]: answerString }；submitted 后等 status 推回
  const [collected, setCollected] = useState({});
  // customReplies: { [questionText]: free-text }——textarea 自由输入，优先级高于 option
  // 当 customReplies[q] 非空时 effective answer = trim 后的 textarea 内容（不走 options）
  // SDK schema 注释明确 "There should be no 'Other' option, that will be provided automatically"
  // —— SDK 期望宿主 UI 提供自由输入入口；我们用 textarea 实现这个。
  const [customReplies, setCustomReplies] = useState({});
  // currentQuestionIdx：wizard 当前在第几题
  const [stepIdx, setStepIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const total = questions.length;
  const isAnswered = (status === 'success' && toolOutput) || status === 'error';
  const disabled = isAnswered || submitting;

  if (total === 0) {
    // streaming 中间态已被 Message() 路由层拦截到 ToolPendingNode；
    // 走到这里 = SDK 已经推过完整 input 但 questions 数组真的是空（极少见 edge：
    // SDK schema 有 @minItems 1 验证，agent 发空数组本身违规）→ 报 error。
    return (
      <SystemMessage
        variant="error"
        content="Agent 调用了 AskUserQuestion 但 input.questions 为空（SDK schema 违规）"
      />
    );
  }

  const currentQ = questions[Math.min(stepIdx, total - 1)];
  const currentAnswer = collected[currentQ.question];  // string（单选 label / 多选 csv）/ undefined
  const currentCustom = customReplies[currentQ.question] || '';
  // effective answer：textarea 自由输入优先；空白则走 options 选择
  const currentEffective = currentCustom.trim() || currentAnswer;
  const isLast = stepIdx === total - 1;
  const canBack = stepIdx > 0;

  // 多选：当前题 selected set（从 csv 反解析；空 set 表示未选）
  // 注意：不用 useMemo —— Hook 不能在 early return（line 152 total===0）后调用，
  // 否则第一次 render total=0 走早返跳过此 hook、下次 render 时 total>0 调到此 hook 就
  // 报 "Rendered more hooks than during the previous render"。Set 构造很轻，inline 算即可。
  const multiSet = (currentQ.multiSelect && currentAnswer)
    ? new Set(currentAnswer.split(', '))
    : new Set();

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
    setCustomReplies(prev => { const next = { ...prev }; delete next[currentQ.question]; return next; });
    if (isLast) submitAll({ ...collected, [currentQ.question]: undefined }, customReplies);
    else setStepIdx(stepIdx + 1);
  };

  const handleNext = () => {
    if (disabled) return;
    if (!currentEffective) {
      showToast('请先选一个选项 / 自由输入回复，或点"跳过本题"', 'info');
      return;
    }
    setStepIdx(stepIdx + 1);
  };

  const handleSubmit = () => {
    if (disabled) return;
    if (!currentEffective) {
      showToast('请先选一个选项 / 自由输入回复，或点"跳过本题"', 'info');
      return;
    }
    submitAll(collected, customReplies);
  };

  // 真正的 POST。allCollected：可能含 undefined 表示跳过 → 过滤掉
  // customMap：textarea 自由输入；非空时优先于 collected[q] 用作 answer
  const submitAll = async (allCollected, customMap = {}) => {
    if (!activeRun?.pid || !activeRun?.runId) {
      showToast('当前无活跃 run，无法回答历史问题', 'info');
      return;
    }
    if (!toolUseId) {
      showToast('卡片缺 toolUseId（不应发生）', 'error');
      return;
    }

    // 过滤 undefined（跳过的题）+ 合并 customReplies（textarea 优先级高于 option）
    // 对每条 question：textarea 非空 trim 后用 textarea；否则 fallback option label
    const answers = {};
    const allKeys = new Set([...Object.keys(allCollected), ...Object.keys(customMap)]);
    for (const k of allKeys) {
      const custom = (customMap[k] || '').trim();
      const opt = allCollected[k];
      const v = custom || opt;
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
      display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
      letterSpacing: '0.04em',
    }}>
      {questions.map((q, i) => {
        const filled = !!((customReplies[q.question] || '').trim() || collected[q.question]);
        const isCurrent = i === stepIdx && !isAnswered;
        return (
          <span
            key={i}
            title={q.header || `Q${i + 1}`}
            style={{
              width: 6, height: 6, borderRadius: RADIUS.round,
              background: filled
                ? COLOR.btn
                : (isCurrent ? COLOR.borderHv : COLOR.borderMd),
              outline: isCurrent ? `1px solid ${COLOR.borderHv}` : 'none',
              outlineOffset: 2,
            }}
          />
        );
      })}
      <span style={{ marginLeft: GAP.sm }}>{Math.min(stepIdx + 1, total)} / {total}</span>
    </div>
  );

  // 时间轴 icon 颜色 + 形状：
  //   - 等待用户答 / 提交中：HelpCircle（`?`）warn
  //   - 已答 success：CheckCircle2 绿（题答过去了，问号 stale）
  //   - 已答 error：AlertCircle 红
  const tlIconColor = status === 'success'
    ? COLOR.success
    : status === 'error'
      ? COLOR.error
      : COLOR.warn;
  const TlIcon = status === 'success'
    ? CheckCircle2
    : status === 'error'
      ? AlertCircle
      : HelpCircle;

  return (
    <TimelineNode icon={TlIcon} iconColor={tlIconColor}>
      <div
        style={{
          padding: GAP.md,
          borderRadius: 2,
          background: COLOR.bgWhite,
          boxShadow: PAPER_SHADOW.far,
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
            gap: GAP.xs,
            padding: `${GAP.xxs}px ${GAP.sm}px`,
            background: 'rgba(45, 36, 24, 0.06)',
            borderRadius: RADIUS.sm,
            fontFamily: FONT_MONO,
            fontSize: FONT_SIZE.xs,
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
                  borderRadius: RADIUS.md,
                  background: isPicked ? 'rgba(45, 36, 24, 0.06)' : COLOR.bgWhite,
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
                  e.currentTarget.style.background = isPicked ? 'rgba(45, 36, 24, 0.06)' : COLOR.bgWhite;
                  e.currentTarget.style.borderColor = isPicked ? COLOR.btn : COLOR.borderLt;
                }}
              >
                {/* checkbox / radio dot indicator */}
                <span style={{
                  width: 14, height: 14,
                  marginTop: GAP.xxs,
                  flexShrink: 0,
                  border: `1.5px solid ${isPicked ? COLOR.btn : COLOR.borderHv}`,
                  borderRadius: currentQ.multiSelect ? RADIUS.xs : RADIUS.round,
                  background: isPicked ? COLOR.btn : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isPicked && <Check size={10} color={COLOR.btnText} strokeWidth={3} />}
                </span>
                <span style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  {opt.description && (
                    <div style={{
                      marginTop: GAP.xxs,
                      fontSize: FONT_SIZE.sm,
                      color: COLOR.sub,
                      lineHeight: 1.4,
                    }}>
                      {opt.description}
                    </div>
                  )}
                  {/* preview —— agent 在 preview 字段塞内容给视觉方向 question 用。
                      自动检测格式（Phase Image-5）：
                        - "data:image/..."  / "/api/.../assets/..."  / 任意 image url
                          → 按图渲染（aspect cover，配合 generate_image 多变体并排选）
                        - "<...html..." / 含 HTML 标签
                          → 旧逻辑：sandbox iframe srcDoc（视觉/字体/排版方向 question）
                      sandbox="" 不带 allow-same-origin / allow-scripts → 完全隔离 */}
                  {opt.preview && renderQuestionPreview(opt.preview, opt.label)}
                </span>
              </button>
            );
          })}
        </div>

        {currentQ.multiSelect && !isAnswered && (
          <div style={{
            marginTop: GAP.xs,
            fontSize: FONT_SIZE.xs,
            color: COLOR.sub,
            fontStyle: 'italic',
          }}>
            （多选：可勾多个，至少选 1 个再"下一题"）
          </div>
        )}

        {/* 自由输入 textarea —— 覆盖上方选项；选项不够全 / 想用自己的话答时用 */}
        {!isAnswered && (
          <div style={{ marginTop: GAP.sm }}>
            <div style={{
              fontSize: FONT_SIZE.xs,
              color: COLOR.sub,
              marginBottom: GAP.xs,
              fontFamily: FONT_MONO,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              或自由输入（覆盖上方选项）
            </div>
            <textarea
              value={currentCustom}
              onChange={(e) => {
                if (disabled) return;
                const v = e.target.value;
                setCustomReplies(prev => {
                  const next = { ...prev };
                  if (v) next[currentQ.question] = v;
                  else delete next[currentQ.question];
                  return next;
                });
              }}
              disabled={disabled}
              placeholder={currentAnswer
                ? `已选「${currentAnswer.length > 30 ? currentAnswer.slice(0, 30) + '…' : currentAnswer}」；填这里会替换它`
                : '想用自己的话回复就在这里写…'}
              rows={2}
              style={{
                width: '100%',
                padding: `${GAP.sm}px ${GAP.md}px`,
                border: `1px solid ${currentCustom.trim() ? COLOR.btn : COLOR.borderLt}`,
                borderRadius: RADIUS.md,
                fontFamily: FONT_SANS,
                fontSize: FONT_SIZE.sm,
                color: COLOR.text,
                background: currentCustom.trim() ? 'rgba(45, 36, 24, 0.04)' : COLOR.bgWhite,
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onFocus={e => { if (!disabled) e.currentTarget.style.borderColor = COLOR.borderHv; }}
              onBlur={e => {
                e.currentTarget.style.borderColor = currentCustom.trim() ? COLOR.btn : COLOR.borderLt;
              }}
            />
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
                disabled={disabled || !currentEffective}
                icon={Send}
                label={`提交全部 (${
                  questions.filter(q =>
                    (customReplies[q.question] || '').trim() || collected[q.question]
                  ).length
                }/${total})`}
                variant="primary"
              />
            ) : (
              <NavBtn
                onClick={handleNext}
                disabled={disabled || !currentEffective}
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
            fontSize: FONT_SIZE.xs,
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
            fontSize: FONT_SIZE.xs,
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
    default: { bg: COLOR.bgWhite, color: COLOR.text2, border: COLOR.borderMd },
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
        gap: GAP.xs,
        padding: `${GAP.xs}px ${GAP.sm}px`,
        background: styles.bg,
        border: `1px solid ${styles.border}`,
        borderRadius: 5,
        fontFamily: FONT_SANS,
        fontSize: FONT_SIZE.sm,
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
function SystemMessage({ variant = 'warn', content, pending = false }) {
  const config = {
    warn:    { icon: ShieldAlert, color: COLOR.warn,    bgRgba: 'rgba(255, 193, 7, 0.08)',  border: 'rgba(255, 193, 7, 0.35)' },
    info:    { icon: Info,        color: COLOR.btn,     bgRgba: 'rgba(45, 36, 24, 0.05)',   border: 'rgba(45, 36, 24, 0.18)' },
    error:   { icon: AlertCircle, color: COLOR.error,   bgRgba: 'rgba(220, 53, 69, 0.06)',  border: 'rgba(220, 53, 69, 0.30)' },
    success: { icon: CheckCircle2,color: COLOR.success, bgRgba: 'rgba(40, 167, 69, 0.06)',  border: 'rgba(40, 167, 69, 0.30)' },
  }[variant] || { icon: Info, color: COLOR.text2, bgRgba: 'rgba(43,33,23,0.04)', border: COLOR.borderLt };

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
        borderRadius: RADIUS.lg,
        fontFamily: FONT_SANS,
        fontSize: FONT_SIZE.sm,
        color: COLOR.text2,
        lineHeight: 1.5,
      }}>
        {pending
          ? (
            <>
            <style>{'@keyframes ndSpin{to{transform:rotate(360deg)}}'}</style>
            <span style={{
              width: 12, height: 12, flexShrink: 0, marginTop: GAP.xxs, borderRadius: RADIUS.round,
              border: `1.5px solid ${COLOR.borderLt}`, borderTopColor: config.color,
              animation: 'ndSpin 800ms linear infinite',
            }} />
            </>
          )
          : <Icon size={14} color={config.color} style={{ flexShrink: 0, marginTop: 1 }} />}
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
            marginTop: GAP.sm,
            fontSize: FONT_SIZE.xs,
            color: COLOR.dim,
            fontStyle: 'italic',
          }}>
            思考中… 已 {text.length} 字（先收起防刷屏，思考完毕后可展开）
          </div>
        )}
        {longEnough && (
          <div style={{ marginTop: GAP.sm }}>
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
  if (isSubagentTool(toolName)) {
    return `${input.subagent_type || ''}: ${(input.prompt || input.description || '').slice(0, 60)}`;
  }
  if (toolName === 'Skill') {
    // SDK 内置 Skill 工具 input schema 未文档化（sdk-tools.d.ts 没显式定义）。
    // 三段式 fallback：① 具名字段优先 ② 第一个 string 字段 ③ JSON 截断兜底
    // 运行时确认 SDK 真用的字段名后再收紧
    const named = input.skill || input.name || input.skillId;
    if (named) return String(named);
    const firstStr = Object.values(input).find(v => typeof v === 'string' && v.length > 0);
    return firstStr ? firstStr.slice(0, 80) : JSON.stringify(input).slice(0, 80);
  }
  if (toolName === 'mcp__nodesign__generate_image') {
    const role = input.assetRole ? `[${input.assetRole}] ` : '';
    const dims = input.aspectRatio ? ` (${input.aspectRatio}${input.imageSize ? '/' + input.imageSize : ''})` : '';
    return `${role}${(input.prompt || '').slice(0, 70)}${dims}`;
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

/**
 * 解析 vision-checker 子代理的 lastAssistantMessage（S3b）。
 * vision-checker.md 锁定输出 schema：
 *   VERDICT: <ok | minor-issues | major-issues | error>
 *   ISSUES:
 *   1. [<severity>] <where>
 *      PROBLEM: <one sentence>
 *      FIX: <suggestion>
 *   2. ...
 *   OVERALL: <paragraph>
 * 解析失败时返回 { raw } 让上层 fallback 显示原文，不抛错。
 */
function parseVisionCheckerCritique(text) {
  if (!text || typeof text !== 'string') return { raw: '' };
  try {
    const verdictMatch = text.match(/VERDICT:\s*(ok|minor-issues|major-issues|error)\b/i);
    const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : null;

    const overallMatch = text.match(/OVERALL:\s*([\s\S]*?)$/i);
    const overall = overallMatch ? overallMatch[1].trim() : null;

    // ISSUES 段在 VERDICT 后 / OVERALL 前
    const issuesBlockMatch = text.match(/ISSUES:\s*([\s\S]*?)(?:\nOVERALL:|$)/i);
    const issues = [];
    if (issuesBlockMatch) {
      const block = issuesBlockMatch[1];
      // 按数字编号 split：'\n1. ' '\n2. ' ...
      const items = block.split(/\n(?=\s*\d+\.\s)/);
      for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const headerMatch = trimmed.match(/^\d+\.\s*\[(high|medium|low)\]\s*(.*)$/im);
        const problemMatch = trimmed.match(/PROBLEM:\s*(.+?)(?:\n|$)/i);
        const fixMatch = trimmed.match(/FIX:\s*(.+?)(?:\n|$)/i);
        if (!headerMatch && !problemMatch) continue;
        issues.push({
          severity: headerMatch?.[1]?.toLowerCase() || null,
          where: headerMatch?.[2]?.trim() || null,
          problem: problemMatch?.[1]?.trim() || null,
          fix: fixMatch?.[1]?.trim() || null,
        });
      }
    }
    if (!verdict && issues.length === 0 && !overall) return { raw: text };
    return { verdict, issues, overall, raw: text };
  } catch {
    return { raw: text };
  }
}

const VERDICT_COLOR = {
  ok: COLOR.success,
  'minor-issues': COLOR.warn,
  'major-issues': COLOR.error,
  error: COLOR.dim,
};

const VERDICT_LABEL = {
  ok: '✓ 看着 OK',
  'minor-issues': '⚠ 小毛病',
  'major-issues': '✗ 主要问题',
  error: '⊘ 评审失败',
};

const SEVERITY_COLOR = {
  high: COLOR.error,
  medium: COLOR.warn,
  low: COLOR.dim,
};

function VisionCheckerCard({ text }) {
  const [open, setOpen] = useState(true);    // 默认展开 — 用户最想看 critique 内容
  const parsed = parseVisionCheckerCritique(text);
  const { verdict, issues, overall, raw } = parsed;

  // 解析失败 → fallback 显示原文（折叠）
  if (!verdict && (!issues || issues.length === 0) && !overall) {
    return (
      <div style={{
        marginTop: GAP.sm,
        padding: GAP.md,
        background: COLOR.bgCard,
        borderRadius: RADIUS.lg,
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
        color: COLOR.text4, lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        maxHeight: 280, overflow: 'auto',
      }}>
        <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginBottom: GAP.xs, letterSpacing: '0.04em' }}>
          评审原文（解析未命中 schema）
        </div>
        {raw}
      </div>
    );
  }

  const verdictColor = VERDICT_COLOR[verdict] || COLOR.dim;
  const verdictLabel = VERDICT_LABEL[verdict] || verdict;

  return (
    <div style={{
      marginTop: GAP.sm,
      border: `1px solid ${verdictColor}33`,
      borderLeft: `3px solid ${verdictColor}`,
      borderRadius: RADIUS.lg,
      background: COLOR.bgCard,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          width: '100%',
          padding: `${GAP.sm}px ${GAP.md}px`,
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          textAlign: 'left',
        }}
      >
        <span style={{ fontWeight: 600, color: verdictColor, flexShrink: 0 }}>
          {verdictLabel}
        </span>
        {issues && issues.length > 0 && (
          <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs }}>
            {issues.length} 条建议
          </span>
        )}
        <ChevronRight
          size={10}
          strokeWidth={1.75}
          color={COLOR.dim}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
          }}
        />
      </button>

      {open && (
        <div style={{
          padding: `0 ${GAP.md}px ${GAP.md}px`,
          display: 'flex', flexDirection: 'column', gap: GAP.sm,
        }}>
          {issues && issues.length > 0 && (
            <ol style={{
              margin: 0, paddingLeft: GAP.lg,
              display: 'flex', flexDirection: 'column', gap: GAP.xs,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3,
              lineHeight: 1.5,
            }}>
              {issues.map((iss, i) => (
                <li key={i} style={{ paddingLeft: GAP.xs }}>
                  {iss.severity && (
                    <span style={{
                      display: 'inline-block',
                      padding: `0 ${GAP.sm}px`,
                      marginRight: GAP.sm,
                      background: `${SEVERITY_COLOR[iss.severity]}22`,
                      color: SEVERITY_COLOR[iss.severity],
                      borderRadius: RADIUS.sm,
                      fontSize: FONT_SIZE.xs,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>
                      {iss.severity}
                    </span>
                  )}
                  {iss.where && (
                    <span style={{ color: COLOR.text2, fontWeight: 500 }}>{iss.where}</span>
                  )}
                  {iss.problem && (
                    <div style={{ marginTop: GAP.xxs }}>{iss.problem}</div>
                  )}
                  {iss.fix && (
                    <div style={{ marginTop: GAP.xxs, color: COLOR.sub, fontStyle: 'italic' }}>
                      → {iss.fix}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {overall && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
              color: COLOR.sub, lineHeight: 1.6,
              borderTop: issues && issues.length > 0 ? `1px solid ${COLOR.borderLt}` : 'none',
              paddingTop: issues && issues.length > 0 ? GAP.sm : 0,
            }}>
              {overall}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolMessage({
  toolName, toolInput, toolOutput, toolError, toolImages, status, elapsed,
  agentType, taskStatus, taskSummary, taskSummaryLog, taskDescription, taskLastTool, subagentResult,
}) {
  const [open, setOpen] = useState(false);

  // Task 工具状态优先用 taskStatus，fallback status
  const effectiveStatus =
    isSubagentTool(toolName)
      ? (taskStatus === 'completed' ? 'success'
        : taskStatus === 'failed' ? 'error'
        : taskStatus === 'stopped' ? 'error'
        : taskStatus === 'running' ? 'running'
        : status)
      : status;

  const isError = effectiveStatus === 'failed' || effectiveStatus === 'error';
  const isRunning = effectiveStatus === 'running';

  // v2：节点 icon 直接用工具特定 icon（去外环），颜色按状态变
  const NodeIcon = getToolIcon(toolName, toolInput?.subagent_type || agentType);
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
            <span style={{ color: COLOR.success, fontSize: FONT_SIZE.sm, fontVariantNumeric: 'tabular-nums' }}>
              +{fileDiff.adds}
            </span>
          )}
          {fileDiff.dels > 0 && (
            <span style={{ color: COLOR.error, fontSize: FONT_SIZE.sm, fontVariantNumeric: 'tabular-nums' }}>
              −{fileDiff.dels}
            </span>
          )}
          {isRunning && elapsed != null && elapsed >= 1 && (
            <span style={{ color: COLOR.warn, fontSize: FONT_SIZE.xs }}>· {formatElapsed(elapsed)}</span>
          )}
          {isError && (
            <span style={{ color: COLOR.error, fontSize: FONT_SIZE.sm }}>失败</span>
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

  // Task/Agent 工具：时间轴抽屉（2026-07-30）。状态行只留一句话，30s 摘要流水 /
  // 结果内容 / 入参全部收进抽屉 —— 聊天流不再被子代理的过程刷屏。2026-08-18 起
  // 这是子代理动态的**唯一**入口（侧栏 tabs / 舞台便利贴 / 在场徽记同日退役）。
  if (isSubagentTool(toolName)) {
    // 真名优先走 toolInput.subagent_type（SDK task_started 的 taskType 可能是
    // 'local_agent' 这种泛名，真机 2026-07-30 确认）
    const agentName = toolInput?.subagent_type || agentType || 'subagent';
    const drawerRows = Array.isArray(taskSummaryLog) && taskSummaryLog.length
      ? taskSummaryLog
      : (taskSummary ? [taskSummary] : []);
    const resultText = subagentResult?.lastAssistantMessage || null;
    // ⚠️ 常驻角色（rp-*）跟干活型子代理在这儿的语义**相反**：
    // 干活型会结束，所以"转圈 = 在跑"成立；常驻角色**按设计永不收回合**
    //（见 mcp/tools/role-inbox.js 的散场闸），task_notification(completed) 永远不来，
    // 于是时间轴上留一个永远转的圈，读起来像"卡住了"。
    // 角色的动静不在这条流水里 —— 在画布精灵和侧栏那行台上提示上。这里只记一次上场。
    const isRole = typeof agentName === 'string' && agentName.startsWith('rp-');
    const statusLabel = taskStatus === 'completed' ? '完成'
      : taskStatus === 'failed' ? '失败'
      : taskStatus === 'stopped' ? '已停止'
      : isRole ? '在台上'
      : isRunning ? (taskSummary || taskLastTool || '工作中…') : null;
    return (
      <TimelineNode icon={NodeIcon} iconColor={iconColor} isSpinning={isRunning && !isRole}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2,
            padding: 0, background: 'transparent', border: 'none', cursor: 'pointer',
            maxWidth: '100%',
          }}
          title={taskDescription || toolName}
        >
          <span className={isRunning && !isRole ? 'nd-shimmer' : undefined} style={{ fontWeight: 500, flexShrink: 0 }}>
            {agentName}
          </span>
          {taskDescription && (
            <span style={{
              color: COLOR.sub, opacity: 0.85, fontWeight: 400,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: 200,
            }}>
              {taskDescription}
            </span>
          )}
          {statusLabel && (
            <span style={{
              color: taskStatus === 'failed' || taskStatus === 'stopped' ? COLOR.error
                : taskStatus === 'completed' ? COLOR.success : COLOR.warn,
              fontSize: FONT_SIZE.xs, flexShrink: 0, fontStyle: isRunning ? 'italic' : 'normal',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
            }}>
              · {statusLabel}
            </span>
          )}
          {isRunning && elapsed != null && elapsed >= 1 && (
            <span style={{ color: COLOR.warn, fontSize: FONT_SIZE.xs, flexShrink: 0 }}>· {formatElapsed(elapsed)}</span>
          )}
          <ChevronRight
            size={10} strokeWidth={1.75} color={COLOR.dim}
            style={{
              flexShrink: 0,
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)',
            }}
          />
        </button>

        {open && (
          <div style={{ marginTop: GAP.sm, display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
            {/* 派活的 brief */}
            {toolInput?.prompt && (
              <div style={{
                padding: GAP.md, background: COLOR.bgCard, borderRadius: RADIUS.lg,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text4,
                lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto',
              }}>
                <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginBottom: GAP.xs, letterSpacing: '0.04em' }}>BRIEF</div>
                {String(toolInput.prompt)}
              </div>
            )}
            {/* 30s 摘要流水（时间轴）*/}
            {drawerRows.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {drawerRows.map((s, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: GAP.sm, alignItems: 'baseline',
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.5,
                  }}>
                    <span style={{ color: COLOR.dim, flexShrink: 0 }}>·</span>
                    <span style={{ fontStyle: 'italic' }}>{s}</span>
                  </div>
                ))}
              </div>
            )}
            {/* 结果内容：vision-checker 走结构化卡，其余子代理直接给收尾文本 */}
            {agentName === 'vision-checker' && resultText ? (
              <VisionCheckerCard text={resultText} />
            ) : resultText ? (
              <div style={{
                padding: GAP.md, background: COLOR.bgCard, borderRadius: RADIUS.lg,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
                lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto',
              }}>
                <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginBottom: GAP.xs, letterSpacing: '0.04em', fontFamily: FONT_MONO }}>结果</div>
                {resultText}
              </div>
            ) : null}
          </div>
        )}
      </TimelineNode>
    );
  }

  // 其他工具：保留 chip 折叠展开 input/output
  const summary = summarizeToolInput(toolName, toolInput);
  const displayName = toolName?.startsWith('mcp__nodesign__')
    ? toolName.replace('mcp__nodesign__', '')
    : toolName;

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
          <span style={{ color: COLOR.warn, fontSize: FONT_SIZE.xs, flexShrink: 0 }}>
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

      {open && (
        <div style={{ marginTop: GAP.sm, display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
          {/* 入参完整 JSON */}
          {toolInput && (
            <div style={{
              padding: GAP.lg,
              background: COLOR.bgCard,
              borderRadius: RADIUS.lg,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.text4, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 200, overflow: 'auto',
            }}>
              <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginBottom: GAP.xs, letterSpacing: '0.04em' }}>INPUT</div>
              {typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2)}
            </div>
          )}

          {/* 图片 output（C24 screenshot 等返回图片）*/}
          {Array.isArray(toolImages) && toolImages.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
              <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, letterSpacing: '0.04em' }}>OUTPUT (image)</div>
              {toolImages.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mediaType || 'image/png'};base64,${img.data}`}
                  alt={`tool result ${i}`}
                  style={{
                    maxWidth: '100%',
                    border: `1px solid ${COLOR.borderLt}`,
                    borderRadius: RADIUS.md,
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
              borderRadius: RADIUS.lg,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.text4, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 280, overflow: 'auto',
            }}>
              <div style={{ fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginBottom: GAP.xs, letterSpacing: '0.04em' }}>OUTPUT</div>
              {typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2)}
            </div>
          )}

          {/* 错误 */}
          {toolError && (
            <div style={{
              padding: GAP.lg,
              background: 'rgba(220, 53, 69, 0.06)',
              border: `1px solid ${COLOR.error}33`,
              borderRadius: RADIUS.lg,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
              color: COLOR.error, lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}>
              <div style={{ fontSize: FONT_SIZE.xxs, opacity: 0.8, marginBottom: GAP.xs, letterSpacing: '0.04em' }}>ERROR</div>
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
      borderRadius: RADIUS.md,
      fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
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
            padding: `0 ${GAP.md}px`,
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

// React.memo + 默认浅比较：appendTextDelta 只 new 末尾那条 message，其他条引用稳定，
// memo 让稳定 message 不重渲（搭配 ProjectWorkspace.handleCanvasReload 的 useCallback
// 让函数 prop 也稳定）。streaming 时只有正在写入的那条会重渲。
export default memo(Message);
