/**
 * mcp/tools/screenshot.js — screenshot_canvas MCP tool
 *
 * 用 playwright headless chromium 截当前 workspace 的 canvas.html，
 * 返回 image content block，agent 可以直接 vision 看自己写的设计。
 *
 * 调用约定（agent 端）：
 *   mcp__nodesign__screenshot_canvas
 *     viewport?: { width, height }   默认 1280x720
 *     fullPage?: boolean              默认 true（完整可滚动页面）
 *     selector?: string               若给则截匹配的第一个元素 bbox（覆盖 fullPage）
 *     pageIndex?: number              若给则截 section[data-page="N"] 整页（覆盖 fullPage）
 *
 * 返回 CallToolResult：
 *   content: [
 *     { type: 'text', text: 'Screenshot of canvas.html ...' },
 *     { type: 'image', data: base64, mimeType: 'image/png' },
 *   ]
 *
 * 错误处理：
 *   - canvas.html 不存在 → 返回 isError: true + 文本提示
 *   - playwright 启动失败 → 返回 isError: true + 错误信息
 *   - 截图失败 → 同上
 *
 * 性能：
 *   每次调用 spawn 新 chromium ~1-2s。P0+ stage 2 上 pool（chromium
 *   常驻 + page.goto 切换）；这次接受。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeScreenshotCanvasTool({ workspaceRoot, ctx }) {
  return tool(
    'screenshot_canvas',
    `Take a screenshot of the current canvas.html in this workspace and return it
as an image content block. Use this to visually inspect the design you wrote
— check spacing, contrast, hierarchy, layout, alignment.

The screenshot uses headless chromium at the given viewport (default
1280x720). Set fullPage=true (default) to capture the full scrollable page,
or false to only capture the visible viewport.

Targeted captures (overrides fullPage):
- selector: capture only the first element matching this CSS selector
- pageIndex: capture only section[data-page="N"]

Returns: image content block (you see it directly via vision) plus a short
text caption with size info.

Use this tool when:
- You finished writing or editing canvas.html and want to verify it looks right
- The user asks "what does it look like" or "show me the result"
- You suspect a layout bug and want to see the rendered output
- You want a closeup of one specific page or element (use pageIndex / selector)

Do NOT use this tool when:
- canvas.html doesn't exist yet (write it first)
- You haven't actually changed the design since the last screenshot`,
    {
      viewport: z
        .object({
          width: z.number().int().min(320).max(3840),
          height: z.number().int().min(240).max(2160),
        })
        .optional()
        .describe('Browser viewport size; defaults to 1280x720'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture full scrollable page instead of just viewport (default true). Ignored if selector or pageIndex is given.'),
      selector: z
        .string()
        .optional()
        .describe('If given, capture only the first element matching this CSS selector (overrides fullPage)'),
      pageIndex: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('If given, capture only section[data-page="N"] (overrides fullPage)'),
    },
    async ({ viewport, fullPage, selector, pageIndex }) => {
      const canvasPath = path.join(workspaceRoot, 'canvas.html');
      try {
        await fs.access(canvasPath);
      } catch {
        return {
          content: [{
            type: 'text',
            text: 'canvas.html not found in workspace. Write it first (with the Write tool) before screenshotting.',
          }],
          isError: true,
        };
      }

      const vp = viewport || DEFAULT_VIEWPORT;
      const fp = fullPage !== false;

      let browser;
      try {
        // 动态 import：playwright 启动慢，模块顶部 import 会拖累其他工具
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: vp });

        // 用 file:// scheme 加载 canvas.html
        // waitUntil: 'networkidle' 等所有外部 fetch（CDN 字体 / 图片）完成
        await page.goto(`file://${canvasPath}`, {
          waitUntil: 'networkidle',
          timeout: 15000,
        });

        // selector / pageIndex 优先，命中则截元素 bbox（locator.screenshot），
        // 都不给走 fullPage / viewport。
        let buf;
        let mode;
        const targetSelector = selector
          || (pageIndex ? `section[data-page="${pageIndex}"]` : null);
        if (targetSelector) {
          const locator = page.locator(targetSelector).first();
          const count = await locator.count();
          if (count === 0) {
            return {
              content: [{
                type: 'text',
                text: `Selector matched no elements: ${targetSelector}`,
              }],
              isError: true,
            };
          }
          buf = await locator.screenshot({ type: 'png' });
          mode = `selector="${targetSelector}"`;
        } else {
          buf = await page.screenshot({ fullPage: fp, type: 'png' });
          mode = `fullPage=${fp}`;
        }

        // emit 让前端可见 agent 在自检
        try {
          ctx?.emit?.({
            type: 'run.screenshot_taken',
            sizeBytes: buf.length,
            viewport: vp,
            mode,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [
            {
              type: 'text',
              text: `Screenshot of canvas.html (${vp.width}x${vp.height}, ${mode}, ${(buf.length / 1024).toFixed(1)} KB)`,
            },
            {
              type: 'image',
              data: buf.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Screenshot failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* ignore close errors */ }
        }
      }
    },
  );
}
