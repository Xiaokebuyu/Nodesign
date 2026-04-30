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
export function createHooks({ ctx, workspaceRoot: _workspaceRoot, projectId: _projectId } = {}) {
  return {
    // C4 FileChanged → EventBus emit run.file_changed → 前端 reload iframe
    FileChanged: [{
      hooks: [makeFileChangedHandler({ ctx })],
    }],

    // C5 PreToolUse:  [{ matcher: 'Bash', hooks: [makeBashWhitelistHandler({ workspaceRoot })] }],
    // C6 Stop:        [{ hooks: [makeStopReflectionHandler({ ctx })] }],
    // C7 PreCompact:  [{ hooks: [makePreCompactHandler({ workspaceRoot })] }],

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
