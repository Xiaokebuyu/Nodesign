/**
 * server/engine/agent/hooks.js — agent hooks 集中定义
 *
 * P0+ stage 1（C3-C7）：4 件套（Phase 3d 改为 3 件套，PreToolUse 删）
 *   FileChanged    — 文件改动 → EventBus emit file.changed → 前端 reload iframe
 *   Stop           — agent 收尾自检（占位，stage 2 接真业务）
 *   PostCompact    — compact 摘要写 spec.json 长期记忆
 *   ~~PreToolUse(Bash)~~ — Phase 3d 删，改用 SDK 内置 sandbox（loop.js sandbox 字段）。
 *                          OS 级隔离（macOS sandbox-exec / Linux bubblewrap）替代正则白名单。
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

    // ~~PreToolUse(Bash) 白名单~~ Phase 3d 删 —— 改用 loop.js sandbox option
    // OS 级隔离（macOS sandbox-exec / Linux bubblewrap），filesystem.allowWrite/denyRead
    // 替代命令级正则。如未来要 per-tool 拦截（非 Bash 工具如 Write 越界），可在
    // PreToolUse 数组重新加 matcher。

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
      // Edit/Write 后干掉 tool_response.originalFile：FileEditOutput/FileWriteOutput
      // 默认含完整原文件（sdk-tools.d.ts:2270, 2328），这是上下文累积大头。
      // canvas.html 25KB 一次 Edit ≈ 6k tokens，30 turn 累积可达 180k+ → 触发 256k 上限。
      // 模型有 structuredPatch (diff 行) 看改动够了，原文件需要再用 Read 拿。
      {
        matcher: 'Edit|Write',
        hooks: [makePostToolUseEditWriteTrimHandler({ ctx })],
      },
      // Canvas 焕新升级 S1d — Edit/Write canvas.html 时检测改动落在哪些 page →
      // emit run.canvas_focus_page（前端 SlideNavigator 跳页 + pulse 高亮）。
      // 不返 hookSpecificOutput，纯 emit；不阻塞 agent，不注 additionalContext。
      {
        matcher: 'Edit|Write',
        hooks: [makePostToolUseCanvasFocusPageHandler({ ctx })],
      },
      // Phase 3.2 — SDK plan mode：agent 调 ExitPlanMode 工具提交 plan，
      // host emit run.plan_for_approval 让前端弹 PlanReviewCard。
      // SDK 自身在 plan mode 下会停 agent 等待 host 切 mode 才继续，所以本 handler
      // 不需要返回 hookSpecificOutput.decision='block'，纯 emit 即可。
      {
        matcher: 'ExitPlanMode',
        hooks: [makePostToolUseExitPlanModeHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__screenshot_canvas',
        hooks: [makePostToolUseScreenshotHandler({ ctx })],
      },
      {
        matcher: 'mcp__nodesign__export_handoff',
        hooks: [makePostToolUseExportHandler({ ctx })],
      },
      // record_decision 后**不再**注 additionalContext —— 之前注的"继续主任务"
      // 跟 SDK preset 'claude_code' 教的"工具调用不是任务结束"重复，agent 模型
      // 自己已经懂。删除让 agent 行为更接近 SDK 默认（不"被牵着走"）。
      // screenshot / export 那两条仍保留：截图后要求 3 条具体视觉问题、export
      // 后防重复打包，都是 SDK 不知道的 NoDesign 业务约束。
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

// makeBashWhitelistHandler / ALLOWED_FIRST_TOKEN / DANGEROUS_PATTERNS / checkBashCommand
// Phase 3d 删除 —— 命令级正则白名单换成 SDK sandbox（loop.js）的 OS 级隔离。
// 如需回滚：git revert 3d commit，本段恢复。

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
 * PostToolUse(Edit|Write) handler —— 干掉 tool_response.originalFile 防上下文累积。
 *
 * 背景：
 *   FileEditOutput.originalFile / FileWriteOutput.originalFile (sdk-tools.d.ts:2270, 2328)
 *   是完整原文件内容。canvas.html 25KB 一次 Edit 在 tool_result 里等于 6k tokens。
 *   30 turn 累积 ≈ 180k tokens → 跟 Kimi 256k 上限挤爆（用户实测 418k 报错）。
 *
 *   structuredPatch（diff 行）是模型理解改动所需的全部信息；oldString/newString
 *   是模型自己刚才传的 input，本来就在上下文里。originalFile 对模型基本无用 —
 *   要看完整文件后续再 Read 即可。
 *
 * 行为：
 *   updatedToolOutput 是 SDK 提供的"改写发给 model 的 tool_result"通道
 *   (sdk.d.ts:1944)。**只影响 model 视图**，jsonl 持久化仍是原 tool_response。
 *   也就是 forkSession / 断线恢复看到的还是完整产物 — 不丢数据。
 *
 *   保留字段：filePath / oldString / newString / structuredPatch / type / gitDiff
 *   清掉字段：originalFile（替换为 null，保持类型 string|null）
 *
 *   非 Edit/Write 的 tool_response 形态（如 input 不带 originalFile） noop。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 * output: PostToolUseHookSpecificOutput (sdk.d.ts:1938)
 */
function makePostToolUseEditWriteTrimHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const resp = input?.tool_response;
      if (!resp || typeof resp !== 'object') return {};
      if (!('originalFile' in resp)) return {};
      const originalSize = typeof resp.originalFile === 'string' ? resp.originalFile.length : 0;
      if (originalSize === 0) return {};  // 新建文件 originalFile 本就是 null

      const trimmed = { ...resp, originalFile: null };

      try {
        ctx.emit({
          type: 'run.tool_response_trimmed',
          tool: input?.tool_name || 'Edit/Write',
          field: 'originalFile',
          savedChars: originalSize,
        });
      } catch { /* emit fail-safe */ }

      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: trimmed,
        },
      };
    } catch (err) {
      console.warn(`[hooks/PostToolUse Edit|Write trim] handler threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(Edit|Write canvas.html) handler — Canvas 焕新升级 S1d。
 *
 * focus_page：检测改动落在哪些 <section data-page="N"> + 改动里有没有
 *   data-anchor="..." 引用 → emit run.canvas_focus_page(pages, anchor?)
 *   → 前端 SlideNavigator 自动 scrollIntoView + 1.5s pulse 高亮
 *
 * 不返 hookSpecificOutput / 不阻塞 agent / 不注 additionalContext。
 *
 * 检测策略（Edit / Write 都要看）：
 *   - Edit：从 tool_input.new_string 找 data-page / data-anchor
 *     （保守 — 只看新增的，不重复扫旧 content）
 *   - Write：从 tool_input.content 找（整文件都是新内容）
 *   - 非 canvas.html 文件：跳过
 *   - file_path 是相对 cwd 的，没法判断到底是不是 canvas.html，按 basename 匹配
 *
 * 失败 fail-soft：emit fail / 解析炸都不抛，console.warn 一行。
 */
function makePostToolUseCanvasFocusPageHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const filePath = input?.tool_input?.file_path;
      if (!filePath || typeof filePath !== 'string') return {};
      // basename 匹配 canvas.html（兼容相对/绝对路径）
      if (!/(?:^|[/\\])canvas\.html$/i.test(filePath)) return {};

      // 取改动文本：Edit 看 new_string，Write 看 content
      const toolName = input?.tool_name;
      let changeText = '';
      if (toolName === 'Edit') {
        changeText = String(input?.tool_input?.new_string || '');
      } else if (toolName === 'Write') {
        changeText = String(input?.tool_input?.content || '');
      } else {
        return {};
      }
      if (!changeText) return {};

      // focus_page —— 找 <section ... data-page="N"> + 可选 data-anchor
      try {
        const pageMatches = [...changeText.matchAll(
          /<section\b[^>]*\bdata-page\s*=\s*['"]?(\d+)['"]?/gi
        )];
        const pages = [...new Set(pageMatches.map(m => parseInt(m[1], 10)))]
          .filter(n => Number.isFinite(n));

        // 找 data-anchor — 取第一个，前端用它精确定位元素
        const anchorMatch = changeText.match(/\bdata-anchor\s*=\s*['"]([^'"]+)['"]/i);
        const anchor = anchorMatch ? anchorMatch[1] : null;

        // Edit 改的是 page 内某段时不会包含 <section data-page>，要从 file path
        // 上推 ——但 hook 时 canvas.html 已写完，可以读出来定位。为避免 hook IO
        // 阻塞 agent，这次先只 emit 显式带 data-page 的改动；不带 page 但带 anchor
        // 也 emit（前端能找到 anchor 元素自己反推 page）。
        if (pages.length > 0 || anchor) {
          ctx.emit(Events.canvasFocusPage(pages, anchor));
        }
      } catch (err) {
        console.warn(`[hooks/canvas_focus_page] handler partial failure:`, err.message);
      }

      return {};
    } catch (err) {
      console.warn(`[hooks/canvas_focus_page] outer handler threw:`, err.message);
      return {};
    }
  };
}

/**
 * PostToolUse(ExitPlanMode) handler — Phase 3.2 SDK plan mode 接通。
 *
 * agent 在 permissionMode='plan' 下调 ExitPlanMode 工具提交 plan：
 *   tool_input: { plan: string, allowedPrompts?: [...] }
 *
 * SDK 自身在 plan mode 下会停 agent 等待 host 处理（切 mode 或 interrupt）；
 * 我们的工作是 emit 事件让前端展示 PlanReviewCard。审批通过后 host 调
 * POST /plan-approve 走 query.setPermissionMode('default')，agent 自然继续。
 *
 * input: PostToolUseHookInput (sdk.d.ts:1926)
 *   - tool_name: 'ExitPlanMode'
 *   - tool_input: ExitPlanModeInput
 *   - tool_use_id: string
 */
function makePostToolUseExitPlanModeHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const plan = String(input?.tool_input?.plan || '').trim();
      const toolUseId = input?.tool_use_id;
      if (!plan) {
        console.warn(`[hooks/ExitPlanMode] empty plan input — skip emit`);
        return {};
      }
      ctx.emit(Events.planForApproval(toolUseId, plan));
    } catch (err) {
      console.warn(`[hooks/ExitPlanMode] handler threw:`, err.message);
    }
    return {};
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
function makePostToolUseScreenshotHandler({ ctx: _ctx }) {
  // 不 emit run.screenshot_taken —— mcp/tools/screenshot.js:114 已经 emit
  // 完整字段（sizeBytes / viewport / fullPage）。hook 只负责注 additionalContext
  // 引导 agent 行为，业务事件由 MCP 工具内部负责。
  return async (_input, _toolUseId, _options) => {
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
function makePostToolUseExportHandler({ ctx: _ctx }) {
  // 不 emit run.export_built —— mcp/tools/export-handoff.js:83 已经 emit
  // 完整字段（format / path / sizeBytes / notes）。hook 从 tool_response 字符串
  // substring 拼出来的 path 反而不准。hook 只负责注 additionalContext。
  return async (_input, _toolUseId, _options) => {
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

// makePostToolUseRecordDecisionHandler — 已移除（git 历史可查）。
// 之前注 "继续做用户的当前任务" 跟 SDK preset 'claude_code' 教的内容重复，
// 让 agent 行为像被牵着走。删除后 agent 记完决策自己判断下一步，更接近
// SDK 默认行为。如未来观察到 agent 反复 record_decision 信号稀释，再考虑
// 加回（那时改成更精准的 anti-loop 检测，不是无脑注引导）。

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
        'Bash 命令失败。常见：\n'
        + '  1. sandbox 拦截（命令访问越界文件 / 不允许的网络）→ 换 Read / Glob / Grep / MCP 工具\n'
        + '  2. cwd 越界 → 路径相对 workspace\n'
        + '  3. 命令本身错（参数 / 文件不存在）→ 检查 stderr';
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
  return async (input, toolUseId, _options) => {
    try {
      ctx.emit(Events.subagentStop(
        input.agent_id,
        input.agent_type,
        input.last_assistant_message,
        input.agent_transcript_path,
        toolUseId,    // main agent 调 Task 时的 tool_use_id；前端按它 match 卡
      ));
    } catch (err) {
      console.warn(`[hooks/SubagentStop] handler threw:`, err.message);
    }
    return {};
  };
}

// Phase 3d 删除：Bash 白名单 / 危险正则 / checkBashCommand
// 替换为 SDK 内置 sandbox（loop.js sandbox 字段）。OS 级隔离比正则白名单更稳。
// 如需回滚：git revert 3d commit，恢复 ALLOWED_FIRST_TOKEN / DANGEROUS_PATTERNS / checkBashCommand。
