/**
 * mcp/tools/navigate-to-page.js — navigate_to_page MCP tool
 *
 * 让 agent 主动把前端 canvas 切到第 N 页。典型场景：agent 在分析多页 deck，
 * 一边讲一边切；或者用户问"第 3 页那个图怎么改"，agent 先切过去再选元素。
 *
 * 实现：纯 emit run.canvas_navigate 事件 → 已订阅 '*' 的 ws bridge 自动转发，
 * 前端 ProjectWorkspace 收到后调 SlideNavigator setActivePage / iframe 内
 * scrollIntoView 对应 section[data-page="N"]。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeNavigateToPageTool({ ctx }) {
  return tool(
    'navigate_to_page',
    `Switch the canvas in the user's frontend to a specific page (1-based).

Use this when:
- You're explaining/changing page N and want the user to see the same page
- The user asks about "page 3" — switch to it before discussing
- After editing a non-current page so the user sees the result

The frontend will scroll to <section data-page="N"> and update the page nav.`,
    {
      index: z
        .number()
        .int()
        .min(1)
        .describe('Target page number (1-based, matches data-page="N")'),
    },
    async ({ index }) => {
      try {
        ctx?.emit?.({
          type: 'run.canvas_navigate',
          page: index,
        });
        return {
          content: [{
            type: 'text',
            text: `Navigated frontend canvas to page ${index}.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `navigate_to_page failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
