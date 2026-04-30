/**
 * server/engine/mcp/index.js — Nodesign 内置 MCP server
 *
 * 暴露给 agent 的自定义工具集（in-process，via SDK 的 createSdkMcpServer）：
 *
 *   ping                  — 占位，验证 MCP 通路（C8）
 *   screenshot_canvas     — playwright 截图当前 canvas.html，返回 image content block
 *                           让 agent vision 自检视觉效果（C9）
 *   export_handoff        — 复用 exports.js 的 handoff zip pipeline，
 *                           agent 觉得到了交付时机时主动调（C10）
 *   record_decision       — 写入 workspace/spec.json 的 decisions[]，
 *                           agent 记录"为什么这样做"的设计意图（C11）
 *
 * 调用约定（SDK 自动给 tool name 加前缀）：
 *   tool 名在 agent 端是 mcp__nodesign__<tool>，比如 mcp__nodesign__ping
 *
 * 实例化策略：
 *   每个 runAgent 创建一个新的 MCP server 实例（through createNodesignMcpServer）。
 *   开销小（in-process，没起 process），但能让 deps（workspaceRoot / projectId / ctx）
 *   绑死到当前 turn 的上下文，避免 cross-talk。
 *
 * 安全：
 *   tool handler 在 SDK 进程内（本服务器进程）跑，不通过 stdio/sse/http。
 *   handler 自己不做沙盒，由 PreToolUse hook + workspace cwd 隔离兜底。
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * 创建 Nodesign 的 MCP server，绑定当前 run 的依赖。
 *
 * @param {object} deps
 * @param {string} deps.workspaceRoot       绝对路径，project workspace
 * @param {string} [deps.projectId]
 * @param {import('../agent/context.js').AgentContext} [deps.ctx]  EventBus 入口
 * @returns SDK MCP server config（喂给 query options.mcpServers）
 */
// eslint-disable-next-line no-unused-vars
export function createNodesignMcpServer({ workspaceRoot, projectId, ctx } = {}) {
  // workspaceRoot/projectId/ctx 在 C9-C11 工具实装时按需绑定到 handler 闭包。
  // 当前 ping 不需要它们 —— 故意留参数签名稳定。
  return createSdkMcpServer({
    name: 'nodesign',
    version: '0.1.0',
    tools: [
      tool(
        'ping',
        'Echo back input. Used to verify the Nodesign MCP server is wired correctly. '
        + 'Pass any string and you get "pong: <string>" back. Has no side effects.',
        {
          msg: z.string().describe('Any string to echo back'),
        },
        async ({ msg }) => ({
          content: [
            { type: 'text', text: `pong: ${msg}` },
          ],
        }),
      ),

      // C9 makeScreenshotCanvasTool({ workspaceRoot, ctx }),
      // C10 makeExportHandoffTool({ workspaceRoot, projectId, ctx }),
      // C11 makeRecordDecisionTool({ workspaceRoot, ctx }),
    ],
  });
}
