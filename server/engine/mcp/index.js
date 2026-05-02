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
import { makeScreenshotCanvasTool } from './tools/screenshot.js';
import { makeExportHandoffTool } from './tools/export-handoff.js';
import { makeRecordDecisionTool } from './tools/record-decision.js';
import { makeWebSearchTool } from './tools/web-search.js';
import { makeReadPageTool } from './tools/read-page.js';
import { makeListPagesTool } from './tools/list-pages.js';
import { makeQueryElementsTool } from './tools/query-elements.js';
import { makeGetComputedStylesTool } from './tools/get-computed-styles.js';
import { makeNavigateToPageTool } from './tools/navigate-to-page.js';
import { makeHighlightTool } from './tools/highlight.js';
import { makeExposeTweaksTool } from './tools/expose-tweaks.js';
import { makeGetPendingChangesTool } from './tools/get-pending-changes.js';
import { makeClearPendingChangesTool } from './tools/clear-pending-changes.js';

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

      // C9 screenshot_canvas — playwright headless 截图 → image content block
      makeScreenshotCanvasTool({ workspaceRoot, ctx }),

      // C10 export_handoff — 复用 exports.js 的 buildHandoffZip，写到 workspace/exports/
      makeExportHandoffTool({ workspaceRoot, projectId, ctx }),

      // C11 record_decision — 写入 spec.json decisions[] 设计意图档案
      makeRecordDecisionTool({ workspaceRoot, ctx }),

      // web_search — 4 provider 联网搜索（baidu/tavily/exa/zhipu，CJK auto route to baidu）
      // 移植自 ~/.deskclaw/skills/deskclaw-search-pro/scripts/search.py，0 外部依赖。
      // WebFetch 不在这里 — 用 SDK 内置（loop.js DEFAULT_TOOL_ALLOWLIST 启用），
      // 它自带 LLM summarize 能控制上下文，不需要自实现。
      makeWebSearchTool({ ctx }),

      // S1c canvas 焕新升级 — read_page 让 agent 精确读 canvas.html 任意页
      // （`<section data-page="N">` 一段），不必 Read 整文件 + Grep + offset/limit。
      // 解 2026-05-02 用户观察"agent 只看第一页"痛点。
      makeReadPageTool({ workspaceRoot, ctx }),

      // ── Canvas 焕新 C1（2026-05-02）：完整 agent "感知 + 操作" 工具链 ──
      // 感知层：list_pages / query_elements / get_computed_styles —— playwright
      // headless 跑出来真实 render 后的元数据，agent 不再盲改
      makeListPagesTool({ workspaceRoot, ctx }),
      makeQueryElementsTool({ workspaceRoot, ctx }),
      makeGetComputedStylesTool({ workspaceRoot, ctx }),

      // 控制层：emit 反向事件给前端，server 主动操作 canvas UI
      makeNavigateToPageTool({ ctx }),
      makeHighlightTool({ ctx }),

      // 反馈层：用户在 canvas 上的直接编辑 + 评论 buffer
      // 前端在 chat 时由 turn.js 注入 system 提示，agent 主动调下面两个工具读 + 清
      makeGetPendingChangesTool({ workspaceRoot, ctx }),
      makeClearPendingChangesTool({ workspaceRoot, ctx }),

      // Tweaks 协议：agent 暴露 deck 专属可调参数 schema → 前端按 schema 渲染控件
      makeExposeTweaksTool({ workspaceRoot, ctx }),
    ],
  });
}
