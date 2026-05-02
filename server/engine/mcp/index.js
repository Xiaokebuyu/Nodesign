/**
 * server/engine/mcp/index.js — Nodesign 内置 MCP server
 *
 * 暴露给 agent 的自定义工具集（in-process，via SDK 的 createSdkMcpServer）：
 *
 *   感知层（playwright headless 跑出真实渲染元数据）：
 *     screenshot_canvas / list_pages / read_page / query_elements / get_computed_styles
 *   控制层（emit 事件让前端同步）：
 *     navigate_to_page / highlight
 *   反馈层（用户在 canvas 上的直接编辑 + 评论 buffer）：
 *     get_pending_changes / clear_pending_changes
 *   产物层（NoDesign 差异化能力）：
 *     expose_tweaks / export_handoff / record_decision
 *   研究层：
 *     web_search（4 provider，CJK auto baidu）
 *
 * 调用约定（SDK 自动给 tool name 加前缀）：
 *   tool 名在 agent 端是 mcp__nodesign__<tool>，比如 mcp__nodesign__screenshot_canvas
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

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
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
export function createNodesignMcpServer({ workspaceRoot, projectId, ctx } = {}) {
  return createSdkMcpServer({
    name: 'nodesign',
    version: '0.1.0',
    // SDK 默认 mcp 工具 deferred —— 只把工具名灌进 system prompt，完整 schema
    // 藏在 ToolSearch 后面，agent 必须先 query 才能调。NoDesign 这 14 个工具
    // 是业务核心（SKILL.md 全程在引导调它们），defer 直接让 agent 当不存在。
    // alwaysLoad: true → 所有 schema 第一 turn 就注入 prompt，agent 直接可调。
    // 代价 ~3-5k system prompt tokens，相对差异化能力（vision 自检 / tweaks /
    // pending changes / list_pages 精准切片）值得。
    alwaysLoad: true,
    tools: [
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
