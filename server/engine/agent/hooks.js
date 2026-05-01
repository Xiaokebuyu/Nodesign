/**
 * server/engine/agent/hooks.js — agent hooks 集中定义
 *
 * P0+ stage 1（C3-C7）：4 件套
 *   FileChanged    — 文件改动 → EventBus emit file.changed → 前端 reload iframe
 *   PreToolUse     — Bash 命令白名单（拦危险命令）
 *   Stop           — agent 收尾自检（占位，stage 2 接真业务）
 *   PostCompact    — compact 摘要写 spec.json 长期记忆
 *
 * Phase 2（agent 层升级）：新增 5 类 hook
 *   UserPromptSubmit         — 每次用户输入前自动注入 spec.json 摘要 + canvas 页数
 *                              （把 SKILL.md "agent 自己 Read spec.json" 软约束变成 SDK 硬注入）
 *   SessionStart             — noop 占位升级为 emit run.session_start，让上层
 *                              区分 startup / resume / clear / compact
 *   PostToolUse(matcher)     — per MCP 工具注 additionalContext，引导 agent 利用工具结果
 *   PostToolUseFailure       — 工具失败时给 agent 恢复建议（避免重试同样的错）
 *   SubagentStart/Stop       — 主动捕子代理生命周期（vs 间接走 SDK task_* message）
 *
 * 调用方式：loop.js 在拼 sdkOptions 时调
 *   hooks: createHooks({ ctx, workspaceRoot, projectId })
 *
 * SDK Hook 接口：
 *   HookCallback = (input, toolUseId, { signal }) => Promise<HookJSONOutput>
 *   HookJSONOutput.SyncHookJSONOutput 关键字段（sdk.d.ts:5283）：
 *     - continue?: boolean              false 中断 query
 *     - decision?: 'approve' | 'block'  控制流（PreToolUse 用 block 拒工具）
 *     - hookSpecificOutput?: { ... }    各 hook 自己的输出（如
 *                                       PreToolUseHookSpecificOutput.permissionDecision /
 *                                       UserPromptSubmitHookSpecificOutput.additionalContext)
 *     - systemMessage?: string          注入 system message 给后续轮
 *     - reason?: string                 给用户看的原因（block 时）
 *
 *   返回 {} 表示"通过，不干预"。
 *
 * 设计原则：
 *   - hook handler 必须**快**（不阻塞 agent loop）。fs 读取限制小文件 + 失败 fail-soft。
 *   - hook handler 不抛异常（SDK 内部会吞，但保险起见自己 try/catch）。
 *   - hook handler 通过 ctx.emit 发事件让前端可见，但不阻塞返回。
 *   - additionalContext 注入要简短直接 —— 不让 agent 觉得需要"回应这条系统消息"，
 *     只是提示"已发生 X"。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Events } from './events.js';

/** 内部：UserPromptSubmit hook 读取 spec.json 时的最大字节数 */
const SPEC_JSON_MAX_BYTES = 200 * 1024;
/** 内部：UserPromptSubmit hook 读 canvas.html 数页数时的最大字节数（防大文件吞内存） */
const CANVAS_HTML_MAX_BYTES = 2 * 1024 * 1024;
/** 内部：spec.json.decisions 注入摘要时取最近 N 条 */
const SPEC_DECISIONS_TAIL = 5;

/**
 * 工厂：根据当前 run 上下文 + workspace 路径生成 hooks 配置。
 *
 * @param {object} deps
 * @param {import('./context.js').AgentContext} deps.ctx
 * @param {string} deps.workspaceRoot
 * @param {string} [deps.projectId]
 * @returns {Partial<Record<string, Array<{ matcher?: string, hooks: Function[], timeout?: number }>>>}
 */
export function createHooks({ ctx, workspaceRoot, projectId: _projectId } = {}) {
  return {
    // ── P0+ stage 1（不动）──

    // FileChanged → EventBus emit run.file_changed → 前端 reload iframe
    FileChanged: [{
      hooks: [makeFileChangedHandler({ ctx })],
    }],

    // PreToolUse Bash 白名单 —— 拦截危险命令（rm 根 / sudo / curl 等）
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [makeBashWhitelistHandler({ ctx })],
    }],

    // Stop —— agent 准备结束 query 时触发，发自检事件给前端
    Stop: [{
      hooks: [makeStopReflectionHandler({ ctx, workspaceRoot })],
    }],

    // PostCompact —— compact 后把摘要写入 spec.json 长期记忆
    PostCompact: [{
      hooks: [makePostCompactHandler({ ctx, workspaceRoot })],
    }],

    // ── Phase 2 升级 ──

    // SessionStart —— 之前是 noop 占位；现在 emit 一条事件让上层知道
    // session 是 startup / resume / clear / compact（注：clear 是 /clear 斜杠命令）
    SessionStart: [{
      hooks: [makeSessionStartHandler({ ctx })],
    }],

    // UserPromptSubmit —— 每次用户输入前自动注入 spec.json 决策摘要 +
    // canvas.html 当前页数。把 SKILL.md 软约束（"agent 自己 turn 开头 Read
    // spec.json"）变成 SDK 硬注入 —— agent 不必每次都自觉，hook 直接喂上下文。
    UserPromptSubmit: [{
      hooks: [makeUserPromptSubmitHandler({ ctx, workspaceRoot })],
    }],

    // PostToolUse —— 按 MCP 工具名分别注 additionalContext，引导 agent 利用
    // 工具结果。matcher 字段是 SDK 标准（与 PreToolUse 'Bash' 同语义）。
    PostToolUse: [
      {
        matcher: 'mcp__nodesign__screenshot_canvas',
        hooks: [makePostToolUseScreenshotHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__export_handoff',
        hooks: [makePostToolUseExportHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__record_decision',
        hooks: [makePostToolUseRecordDecisionHandler({ ctx, workspaceRoot })],
      },
    ],

    // PostToolUseFailure —— 任意工具失败时统一处理：emit 事件 + 给 agent
    // 注入恢复建议（避免重试同样的错）。
    PostToolUseFailure: [{
      hooks: [makePostToolUseFailureHandler({ ctx })],
    }],

    // SubagentStart / SubagentStop —— 主动捕子代理生命周期。当前只 emit 事件
    // 给上层观察；不阻塞流程。stage 2 真接通子代理时这里加调度逻辑。
    SubagentStart: [{
      hooks: [makeSubagentStartHandler({ ctx })],
    }],
    SubagentStop: [{
      hooks: [makeSubagentStopHandler({ ctx })],
    }],
  };
}

// ─────────────────────────────────────────────────────────────────────
// hook handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * FileChanged handler（P0+ s1 C4）：agent 写文件后 SDK 触发，转发给 EventBus。
 *
 * input: FileChangedHookInput (sdk.d.ts:557)
 *   - file_path: string         绝对路径或相对 cwd
 *   - event: 'change' | 'add' | 'unlink'
 *
 * 不在这里做 .html 过滤 —— 全部转发让前端按需消费（C18 ContextUsageBar /
 * C20 file changes 列表都可能用）。前端 Project.jsx 只对 canvas.html bump reloadToken。
 *
 * 返回 {}：不干预 SDK，不影响 agent loop。
 */
function makeFileChangedHandler({ ctx }) {
  // eslint-disable-next-line no-unused-vars
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.fileChanged(input.file_path, input.event));
    } catch (err) {
      console.warn(`[hooks/FileChanged] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * PreToolUse(Bash) handler（P0+ s1 C5）—— 命令白名单。
 * 详见原文档（沙盒 / fail-open / SDK 形状）。
 *
 * input: PreToolUseHookInput (sdk.d.ts:1957)
 *   - tool_name: string
 *   - tool_input: unknown
 *   - tool_use_id: string
 */
function makeBashWhitelistHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const command = input?.tool_input?.command;
      if (!command || typeof command !== 'string') return {};

      const verdict = checkBashCommand(command);
      if (verdict.allow) return {};

      try {
        ctx.emit({
          type: 'run.bash_blocked',
          command: command.slice(0, 200),
          reason: verdict.reason,
        });
      } catch { /* emit fail-safe */ }

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    } catch (err) {
      console.warn(`[hooks/PreToolUse Bash] handler threw:`, err.message);
      return {};  // fail-open：解析错误时让 SDK 继续
    }
  };
}

/**
 * Stop handler（P0+ s1 C6）—— agent 准备结束 query 时触发。
 * 仅 emit 事件给前端可见 hook 系统在跑。stage 2 加真业务（截图/交付提示）时再扩。
 *
 * input: StopHookInput (sdk.d.ts:5247)
 *   - stop_hook_active: boolean
 *   - last_assistant_message?: string
 */
function makeStopReflectionHandler({ ctx, workspaceRoot }) {
  return async (_input, _toolUseId, _options) => {
    try {
      const hasCanvas = workspaceRoot
        ? await fs.access(path.join(workspaceRoot, 'canvas.html'))
            .then(() => true).catch(() => false)
        : false;

      ctx.emit({
        type: 'run.stop_reflection',
        hasCanvas,
      });
    } catch (err) {
      console.warn(`[hooks/Stop] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * PostCompact handler（P0+ s1 C7）—— SDK 自动 compact 后把 summary 持久化到 spec.json。
 *
 * input: PostCompactHookInput (sdk.d.ts:1879)
 *   - trigger: 'manual' | 'auto'
 *   - compact_summary: string
 *
 * 失败 fail-soft：spec.json 写不进去 console.warn 但不抛错（不阻塞 query）。
 */
function makePostCompactHandler({ ctx, workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};
      const summary = input?.compact_summary;
      if (!summary || typeof summary !== 'string') return {};

      const specPath = path.join(workspaceRoot, 'spec.json');
      let spec = {};
      try {
        const raw = await fs.readFile(specPath, 'utf8');
        spec = JSON.parse(raw);
        if (!spec || typeof spec !== 'object') spec = {};
      } catch {
        spec = {};
      }

      if (!Array.isArray(spec.history)) spec.history = [];
      spec.history.push({
        ts: new Date().toISOString(),
        source: 'compact',
        trigger: input.trigger || 'auto',
        summary,
      });

      await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');

      try {
        ctx.emit({
          type: 'run.compact_persisted',
          trigger: input.trigger || 'auto',
          summaryLength: summary.length,
          historyCount: spec.history.length,
        });
      } catch { /* emit fail-safe */ }
    } catch (err) {
      console.warn(`[hooks/PostCompact] handler threw:`, err.message);
    }
    return {};
  };
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 新增 handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * SessionStart handler（升级原 noop 占位）。
 *
 * input: SessionStartHookInput (sdk.d.ts:3577)
 *   - source: 'startup' | 'resume' | 'clear' | 'compact'
 *   - agent_type?: string                  父 agent 类型（--agent 时有）
 *   - model?: string
 *
 * Phase 2 范围：仅 emit 事件让上层可见。不注 additionalContext / initialUserMessage —
 * spec.json 的恢复走 UserPromptSubmit 路径（每次用户输入前重新注入），而不是
 * SessionStart 一次性注入（一次性注入只在 session 开头有效，跨多个 turn 后过期）。
 */
function makeSessionStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.sessionStart(input.source, input.agent_type, input.model));
    } catch (err) {
      console.warn(`[hooks/SessionStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * UserPromptSubmit handler — 每次用户输入前自动注入 spec.json 决策摘要 +
 * canvas.html 当前页数到 additionalContext。
 *
 * 为什么要 hook 注入而不是让 agent 自己 Read：
 *   - SKILL.md 引导是软约束，agent 偶尔会忘
 *   - hook 注入 = SDK 硬保证，每个 turn 都有
 *   - 成本：hook 内 fs 读 2 个文件（< 200KB），单次 turn 增加 ~10-50ms。
 *     spec.json 摘要 +canvas 页数本来 agent 就要 Read，hook 提前喂效率更高
 *
 * input: UserPromptSubmitHookInput (sdk.d.ts:5475)
 *   - prompt: string                  用户原文
 *   - session_title?: string
 *
 * output: UserPromptSubmitHookSpecificOutput (sdk.d.ts:5481)
 *   - additionalContext?: string      注入后续 prompt（标记成 system 提示）
 *   - sessionTitle?: string           覆盖 session 标题（不用）
 */
function makeUserPromptSubmitHandler({ ctx, workspaceRoot }) {
  return async (_input, _toolUseId, _options) => {
    try {
      if (!workspaceRoot) return {};

      const parts = [];

      // 1. spec.json：取最近 N 条 decisions 拼摘要
      try {
        const specPath = path.join(workspaceRoot, 'spec.json');
        const stat = await fs.stat(specPath);
        if (stat.size <= SPEC_JSON_MAX_BYTES) {
          const raw = await fs.readFile(specPath, 'utf8');
          const spec = JSON.parse(raw);
          const decisions = Array.isArray(spec?.decisions) ? spec.decisions : [];
          if (decisions.length > 0) {
            const recent = decisions.slice(-SPEC_DECISIONS_TAIL);
            const lines = recent.map((d, i) => {
              const idx = decisions.length - recent.length + i + 1;
              const title = (d?.title || '(无标题)').slice(0, 80);
              const rationale = (d?.rationale || '').slice(0, 200);
              return `  ${idx}. ${title}${rationale ? ` — ${rationale}` : ''}`;
            }).join('\n');
            parts.push(
              `本项目设计决策档案（spec.json，共 ${decisions.length} 条，最近 ${recent.length} 条）：\n${lines}`,
            );
          }
        }
      } catch {
        // spec.json 不存在 / 解析失败 / stat 失败：noop
      }

      // 2. canvas.html：数页数（grep <section data-page=）
      try {
        const canvasPath = path.join(workspaceRoot, 'canvas.html');
        const stat = await fs.stat(canvasPath);
        if (stat.size <= CANVAS_HTML_MAX_BYTES) {
          const raw = await fs.readFile(canvasPath, 'utf8');
          const matches = raw.match(/<section\b[^>]*\bdata-page=/g);
          const pageCount = matches ? matches.length : 0;
          if (pageCount > 0) {
            parts.push(`canvas.html 当前 ${pageCount} 页。`);
          } else {
            parts.push('canvas.html 已存在但没找到 <section data-page=> 分页结构。');
          }
        } else {
          parts.push(`canvas.html 比较大（${(stat.size / 1024).toFixed(0)}KB）—— 用 Read 工具配 limit 分段读。`);
        }
      } catch {
        // canvas.html 不存在 = 首跑
        parts.push('canvas.html 还不存在 —— 这可能是首跑，按 brief 用 Write 工具创建。');
      }

      if (parts.length === 0) return {};

      const additionalContext = `[NoDesign 工作台自动注入的当前状态]\n\n${parts.join('\n\n')}\n\n请基于这些信息处理用户的请求。`;

      // 不 emit 业务事件 —— additionalContext 注入是私域提示，不需要前端展示
      return {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      };
    } catch (err) {
      console.warn(`[hooks/UserPromptSubmit] handler threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(screenshot_canvas) handler — agent 截图后引导它做视觉自检。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 *   - tool_name / tool_input / tool_response / tool_use_id / duration_ms?
 *
 * output: PostToolUseHookSpecificOutput (sdk.d.ts:1938)
 *   - additionalContext?: string         注入下一轮 prompt
 *   - updatedToolOutput?: unknown        替换 tool 输出（不用）
 *
 * 注意：tool_response 里包含 image content block（base64）。agent 收到这条
 * additionalContext 时已经能"看到"图（multimodal）—— 我们只是用文字提示
 * 它接下来该做什么，不替换 image。
 */
function makePostToolUseScreenshotHandler({ ctx }) {
  return async (_input, _toolUseId, _options) => {
    try { ctx.emit({ type: 'run.screenshot_taken' }); } catch { /* ignore */ }
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '你刚才截图了。基于这张图，简短点出 3 个具体的视觉问题（对比度/留白/对齐/层级/字号节奏 任选），每条 1-2 句。'
          + '\n如果整体看起来 OK，就直接跟用户说"看起来 OK"，不要再重复截图。',
      },
    };
  };
}

/**
 * PostToolUse(export_handoff) handler — agent 打交付包后引导它告知用户路径。
 */
function makePostToolUseExportHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    // tool_response 形态：MCP CallToolResult，可能是 { content: [{ type:'text', text:'path:...' }] }
    let pathHint = '';
    try {
      const resp = input?.tool_response;
      if (resp && typeof resp === 'object') {
        const content = resp.content;
        if (Array.isArray(content) && content[0]?.type === 'text') {
          pathHint = String(content[0].text || '').slice(0, 300);
        }
      }
    } catch { /* ignore */ }

    try {
      ctx.emit({ type: 'run.export_built', path: pathHint || undefined });
    } catch { /* ignore */ }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '已生成交付包。简短告诉用户打包文件路径（让她从 UI 下载），然后收尾。'
          + '\n不要再重复调 export_handoff —— 同一个交付应只打包一次。',
      },
    };
  };
}

/**
 * PostToolUse(record_decision) handler — agent 记决策后引导它继续主任务。
 *
 * 防止 agent 一旦发现"记决策"工具有效，就反复记导致信号稀释（SKILL.md 已经
 * 教过"信号稀释比缺失记录还坏"，但 hook 是兜底）。
 */
function makePostToolUseRecordDecisionHandler({ ctx, workspaceRoot }) {
  return async (input, _toolUseId, _options) => {
    let decisionsCount;
    try {
      // 最 cheap 的方式：读 spec.json 数 decisions 长度
      const specPath = path.join(workspaceRoot, 'spec.json');
      const raw = await fs.readFile(specPath, 'utf8');
      const spec = JSON.parse(raw);
      if (Array.isArray(spec?.decisions)) decisionsCount = spec.decisions.length;
    } catch { /* ignore */ }

    try {
      ctx.emit({
        type: 'run.decision_recorded',
        title: input?.tool_input?.title,
        decisionsCount,
      });
    } catch { /* ignore */ }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '已记录决策到 spec.json。继续做用户的当前任务，不要为同一件事重复 record_decision。'
          + '\n下一步该回到主线（继续 Edit canvas / 截图自检 / 收尾文本，按当前阶段判断）。',
      },
    };
  };
}

/**
 * PostToolUseFailure handler — 工具失败时给 agent 恢复建议。
 *
 * input: PostToolUseFailureHookInput (sdk.d.ts:1908)
 *   - tool_name: string
 *   - tool_input: unknown
 *   - tool_use_id: string
 *   - error: string
 *   - is_interrupt?: boolean
 *   - duration_ms?: number
 *
 * output: PostToolUseFailureHookSpecificOutput (sdk.d.ts:1921)
 *   - additionalContext?: string
 */
function makePostToolUseFailureHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    const tool = input?.tool_name || 'unknown';
    const error = String(input?.error || '').slice(0, 500);
    const isInterrupt = Boolean(input?.is_interrupt);

    try {
      ctx.emit(Events.toolFailure(tool, error));
    } catch { /* ignore */ }

    // is_interrupt: 用户中断 → 不注入建议（agent 应该停下，不是恢复）
    if (isInterrupt) return {};

    let advice;
    if (tool === 'mcp__nodesign__screenshot_canvas') {
      advice =
        '截图失败。常见原因：\n'
        + '  1. canvas.html 还没创建 → 先 Write 创建首版\n'
        + '  2. playwright spawn 慢 / 失败 → 换 Read canvas.html 让用户看代码\n'
        + '  3. fullPage 截图太大 → 换 fullPage:false 截视口';
    } else if (tool === 'Bash') {
      advice =
        'Bash 命令被拦或失败。常见：\n'
        + '  1. 不在 ALLOWED_FIRST_TOKEN 白名单 → 换 Read / Glob / Grep / MCP 工具\n'
        + '  2. 含危险模式（curl/wget/sudo/rm 根目录）→ 用 Read 工具\n'
        + '  3. cwd 越界 → 路径相对 workspace';
    } else if (tool === 'Write' || tool === 'Edit') {
      advice =
        `${tool} 失败。检查：\n`
        + '  1. 路径相对 workspace 还是绝对路径\n'
        + '  2. Edit 的 old_string 是否完整匹配（含空格/缩进）\n'
        + '  3. 文件是否存在（不存在用 Write 创建）';
    } else if (tool === 'Read') {
      advice = `Read 失败：${error}\n  1. 确认路径相对 workspace\n  2. 用 Glob 找文件确认存在`;
    } else {
      advice = `${tool} 失败：${error}\n考虑换工具或调整参数。如果阻塞用户任务，告诉用户跳过这步。`;
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `[工具失败恢复建议]\n${advice}`,
      },
    };
  };
}

/**
 * SubagentStart handler — 子代理启动时主动 emit 事件给 EventBus。
 *
 * input: SubagentStartHookInput (sdk.d.ts:5258)
 *   - agent_id: string
 *   - agent_type: string
 *
 * 与 SDK system 'task_started' message 路径并行：task_* message 走的是 SDK
 * agentProgressSummaries 通道（30s 摘要），而 hook 是子代理 spawn 时立即触发，
 * 时序更前 + 更可靠。loop.js 已对 task_started 翻译成 run.task.started，
 * 这条 hook emit 的 run.subagent.start 是更主动的入口。
 *
 * Phase 2 仅 emit；不注入 additionalContext（子代理刚启动还没产出，注啥都早）。
 */
function makeSubagentStartHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStart(input.agent_id, input.agent_type));
    } catch (err) {
      console.warn(`[hooks/SubagentStart] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * SubagentStop handler — 子代理结束时主动 emit。
 *
 * input: SubagentStopHookInput (sdk.d.ts:5269)
 *   - stop_hook_active: boolean
 *   - agent_id: string
 *   - agent_transcript_path: string       子代理转录文件路径
 *   - agent_type: string
 *   - last_assistant_message?: string     子代理最后一条 assistant 文本
 *
 * 注意：SubagentStop 没有 specific output 类型（sdk.d.ts:5291 的 union 里没列），
 * 只能返回通用 SyncHookJSONOutput（continue/decision/systemMessage）。
 * 这里只 emit 不返 specific 输出，符合规范。
 */
function makeSubagentStopHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStop(
        input.agent_id,
        input.agent_type,
        input.last_assistant_message,
        input.agent_transcript_path,
      ));
    } catch (err) {
      console.warn(`[hooks/SubagentStop] handler threw:`, err.message);
    }
    return {};
  };
}

// ─────────────────────────────────────────────────────────────────────
// Bash 白名单 / 危险正则（沿用 P0+ s1 C5 配置）
// ─────────────────────────────────────────────────────────────────────

/**
 * 第一个 token 白名单 —— P0+ stage 1 范围，覆盖 SKILL.md 引导的典型命令：
 *   - git（commit/log/status/diff/checkout）—— history / variant fork 必需
 *   - playwright / npx playwright —— C9 screenshot
 *   - zip / unzip / tar —— C10 export handoff
 *   - 文件浏览（ls/cat/head/tail/find/wc/tree）
 *   - 文件操作（mkdir/cp/mv/touch；不含 rm，rm 走 DANGEROUS_PATTERNS）
 *   - 文本处理（grep/sed/awk/jq/sort/uniq/cut）
 *   - node/npm/npx
 *   - 元命令（pwd/which/whoami/env/date/echo/printf/test）
 *   - cd —— 复合 `cd workspace && git status` 必需
 */
const ALLOWED_FIRST_TOKEN = new Set([
  'git', 'playwright', 'node', 'npm', 'npx',
  'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'tree',
  'mkdir', 'cp', 'mv', 'touch',
  'echo', 'printf', 'pwd', 'which', 'whoami', 'env', 'date',
  'grep', 'rg', 'sed', 'awk', 'jq', 'sort', 'uniq', 'cut', 'tr',
  'cd', 'true', 'false', 'test',
]);

const DANGEROUS_PATTERNS = [
  /\bsudo\b/, /(?:^|[\s;&|])su\s/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b\s/, /\bnetcat\b/,
  /\bchmod\s+(?:[0-7]{3,4}|[ugoa]?\+x)/,
  /\brm\s+(?:-[rRf]+\s+)?(?:\/|~|\$HOME)/,
  /\bdd\s+if=/, /\bmkfs\b/, /\bfdisk\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\bkill(?:all)?\s+-9\b/,
  />\s*\/dev\//, />\s*\/etc\//, />\s*\/sys\//, />\s*\/proc\//,
];

function checkBashCommand(command) {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(command)) {
      return { allow: false, reason: `命令含危险模式（${pat.source}）：${command.slice(0, 100)}` };
    }
  }

  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  const first = tokens[i] || '';

  if (!ALLOWED_FIRST_TOKEN.has(first)) {
    return {
      allow: false,
      reason: `命令 "${first}" 不在 Bash 白名单。允许集合见 hooks.js ALLOWED_FIRST_TOKEN。`,
    };
  }

  return { allow: true };
}
