/**
 * server/engine/agent/hooks.js — agent hooks 集中定义
 *
 * 4 件套（在后续 commits 逐个填实）：
 *   C4 FileChanged    — 文件改动 → EventBus emit file.changed → 前端 reload iframe
 *   C5 PreToolUse     — Bash 命令白名单（拦危险命令）
 *   C6 Stop           — agent 收尾自检（注入 additionalContext 提示截图 / 交付）
 *   C7 PreCompact     — compact 摘要写 spec.json 长期记忆
 *
 * 调用方式：loop.js 在拼 sdkOptions 时调
 *   hooks: createHooks({ ctx, workspaceRoot, projectId })
 *
 * SDK Hook 接口：
 *   HookCallback = (input, toolUseId, { signal }) => Promise<HookJSONOutput>
 *   HookJSONOutput.SyncHookJSONOutput 关键字段：
 *     - continue?: boolean              false 中断 query
 *     - decision?: 'approve' | 'block'  控制流（PreToolUse 用 block 拒工具）
 *     - hookSpecificOutput?: { ... }    各 hook 自己的输出（如
 *                                       PreToolUseHookSpecificOutput.permissionDecision /
 *                                       UserPromptSubmitHookSpecificOutput.additionalContext）
 *     - systemMessage?: string          注入 system message 给后续轮
 *     - reason?: string                 给用户看的原因（block 时）
 *
 *   返回 {} 表示"通过，不干预"。
 *
 * 设计原则：
 *   - hook handler 必须**快**（不阻塞 agent loop）
 *   - hook handler 不抛异常（SDK 内部会吞，但保险起见自己 try/catch）
 *   - hook handler 通过 ctx.emit 发事件让前端可见，但不阻塞返回
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Events } from './events.js';

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
    // C4 FileChanged → EventBus emit run.file_changed → 前端 reload iframe
    FileChanged: [{
      hooks: [makeFileChangedHandler({ ctx })],
    }],

    // C5 PreToolUse Bash 白名单 —— 拦截危险命令（rm 根 / sudo / curl 等）
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [makeBashWhitelistHandler({ ctx })],
    }],

    // C6 Stop —— agent 准备结束 query 时触发，发自检事件给前端
    Stop: [{
      hooks: [makeStopReflectionHandler({ ctx, workspaceRoot })],
    }],

    // C7 PostCompact —— compact 后把摘要写入 spec.json 长期记忆
    // （plan 原写的是 PreCompact，但 PreCompact 没有 compact_summary 字段；
    //  正确语义是 PostCompact 拿 summary 持久化）
    PostCompact: [{
      hooks: [makePostCompactHandler({ ctx, workspaceRoot })],
    }],

    // 占位 noop SessionStart：验证 hook 系统通路 + 留一处可见的"启动"日志钩子
    SessionStart: [{
      hooks: [
        // eslint-disable-next-line no-unused-vars
        async (_input, _toolUseId, _options) => {
          return {};
        },
      ],
    }],
  };
}

// ── hook handlers ──

/**
 * C4 FileChanged handler：agent 写文件后 SDK 触发，转发给 EventBus
 * 让前端 reload iframe（仅 .html 文件 / canvas.html）。
 *
 * input 字段（FileChangedHookInput）：
 *   - file_path: string         绝对路径或相对 cwd
 *   - event: 'change' | 'add' | 'unlink'
 *
 * 不在这里做 .html 过滤 —— 全部转发让前端按需消费（C18 ContextUsageBar /
 * C20 file changes 列表都可能用）。前端 Project.jsx 只对 canvas.html
 * bump reloadToken。
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
 * C5 PreToolUse(Bash) handler —— 命令白名单。
 *
 * 沙盒由 cwd=workspace 提供（git binary 通过 PATH 拿，文件操作限定在
 * workspace 内）。但 cwd 不是真沙盒：agent 可以 `cd /` 跑出去。
 * 本 handler 在工具调用前做命令白名单兜底。
 *
 * 白名单：第一个 token 必须在 ALLOWED_FIRST_TOKEN，且整命令不含
 * DANGEROUS_PATTERNS（curl / wget / sudo / rm / 根目录 / etc）。
 *
 * 失败 fail-open：如果解析过程出错，让 SDK 继续（避免 hook 错误把
 * agent 卡住）。
 *
 * SDK 形状：
 *   返回 { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *     permissionDecision: 'deny', permissionDecisionReason } } 拒绝
 *   返回 {} 通过
 */
function makeBashWhitelistHandler({ ctx }) {
  return async (input, _toolUseId, _options) => {
    try {
      const command = input?.tool_input?.command;
      if (!command || typeof command !== 'string') return {};

      const verdict = checkBashCommand(command);
      if (verdict.allow) return {};

      // 拒绝 + 让前端可见
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

/**
 * 危险关键字（任何 token 含就拒）。设计：覆盖跨命令的危险模式，不依赖
 * 第一个 token 白名单（如 'bash -c "sudo rm /"' 第一个是 bash 已被白名单
 * 拒了，但即便允许 bash，DANGEROUS_PATTERNS 也会兜底）。
 */
const DANGEROUS_PATTERNS = [
  /\bsudo\b/, /(?:^|[\s;&|])su\s/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b\s/, /\bnetcat\b/,
  /\bchmod\s+(?:[0-7]{3,4}|[ugoa]?\+x)/,  // chmod 777 / +x（有意义但不在 P0 范围）
  /\brm\s+(?:-[rRf]+\s+)?(?:\/|~|\$HOME)/,  // rm 根 / home
  /\bdd\s+if=/, /\bmkfs\b/, /\bfdisk\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\bkill(?:all)?\s+-9\b/,  // kill -9（一般 kill 允许）
  />\s*\/dev\//, />\s*\/etc\//, />\s*\/sys\//, />\s*\/proc\//,  // 输出到系统目录
];

/**
 * C6 Stop handler —— agent 准备结束 query 时触发。
 *
 * P0+ stage 1 范围：温和提示，不强迫继续。
 * - 检查 canvas.html 是否存在（agent 有产物）
 * - 如果有产物 + 本 turn 没用过 mcp__nodesign__screenshot_canvas /
 *   mcp__nodesign__export_handoff（C9/C10 接入后）→ emit run.stop_reflection
 *   让前端可见这个 hook 触发了
 * - 不返回 decision: 'block' / 不注入 systemMessage —— 避免无限循环风险，
 *   让 agent 自然结束。stage 2 真按设计需要 block 时再加。
 *
 * 实际上这个 hook 在 stage 1 几乎是 noop —— 主要价值是给 stage 2
 * 留个挂载点 + emit 让前端可见 hook 系统在跑。
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
        // stage 2 加 toolsUsedThisTurn 字段（从 ctx.counters 或 ctx.snapshot 抽）
        // 用来判断是否提示 screenshot/export
      });
    } catch (err) {
      console.warn(`[hooks/Stop] handler threw:`, err.message);
    }
    return {};
  };
}

/**
 * C7 PostCompact handler —— SDK 自动 compact 后把 summary 持久化到 spec.json。
 *
 * 为什么要持久化：
 * - SDK compact 后 session 内的旧 messages 被丢弃，只留 summary 在 SDK 内
 * - 跨 session（用户 reload / 服务重启）SDK summary 是否保留依赖 SessionStore
 *   实现 —— 我们没用 SessionStore，靠 ~/.claude/projects/<sid>.jsonl 持久化
 * - spec.json 是 agent 私域的"设计意图档案"，按设计就是用来跨 session 记忆
 *   关键决策的；这里把 compact summary 沉淀进去，下次 turn 起来时 agent
 *   通过 Read spec.json 拿到历史
 *
 * spec.json 结构（约定）：
 *   {
 *     history: [
 *       { ts, source: 'compact' | 'decision', trigger?, summary }
 *     ],
 *     decisions: [...],   // C11 record_decision tool 写
 *     ...
 *   }
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
        // spec.json 不存在或解析失败 —— 起新对象
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

function checkBashCommand(command) {
  // 先扫危险关键字（任何 token 命中就拒）
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(command)) {
      return { allow: false, reason: `命令含危险模式（${pat.source}）：${command.slice(0, 100)}` };
    }
  }

  // 第一个 token 白名单（跳过环境变量赋值前缀如 'FOO=bar git ...'）
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
