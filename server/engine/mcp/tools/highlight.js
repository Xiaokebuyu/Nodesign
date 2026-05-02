/**
 * mcp/tools/highlight.js — highlight MCP tool
 *
 * 让 agent 在前端 canvas 上短暂 pulse 一个元素（默认 1500ms），用来"我建议
 * 改这块"时给用户视觉锚点 — 不污染 DOM、不改样式、纯动画 overlay。
 *
 * 实现：emit run.canvas_highlight 事件 → 前端在 InspectFloatingCard 同层
 * 挂 pulse overlay 短暂动画。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeHighlightTool({ ctx }) {
  return tool(
    'highlight',
    `Briefly pulse-highlight an element in the user's canvas (does not modify
DOM or styles, just an animated overlay).

Use this when:
- You're suggesting a change to a specific element and want the user to
  see exactly which one
- You just modified an element and want to draw attention to the result

The frontend will resolve the selector inside iframe.contentDocument and
animate a glow ring on it.`,
    {
      selector: z
        .string()
        .min(1)
        .describe('CSS selector inside the canvas iframe (e.g., \'section[data-page="2"] h1\', \'[data-anchor="cover-title"]\')'),
      durationMs: z
        .number()
        .int()
        .min(200)
        .max(10000)
        .optional()
        .describe('How long the pulse lasts; default 1500ms'),
    },
    async ({ selector, durationMs }) => {
      try {
        ctx?.emit?.({
          type: 'run.canvas_highlight',
          selector,
          durationMs: durationMs ?? 1500,
        });
        return {
          content: [{
            type: 'text',
            text: `Highlight pulse sent: ${selector} (${durationMs ?? 1500}ms)`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `highlight failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
