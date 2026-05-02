/**
 * mcp/tools/get-computed-styles.js — get_computed_styles MCP tool
 *
 * 拿一组元素在 canvas.html 真实渲染后的 computed style（不是 inline 也不是
 * CSS 文件里的 raw 值）—— agent 不用猜"用户看到的字号实际是多少 px"，直接调。
 *
 * 典型场景：
 *   - "把 H1 字号缩小一点" → 先拿当前 H1 是多少 px 再决定改多少
 *   - "对比度够不够" → 拿 color 和 background-color 算对比度
 *
 * 默认拿一组常用样式属性（color/fontSize/fontFamily/...）；agent 可以传
 * props 数组只拿需要的（省 token）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DEFAULT_PROPS = [
  'color', 'backgroundColor',
  'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlign', 'textTransform',
  'padding', 'margin',
  'borderRadius', 'borderWidth', 'borderColor',
  'display', 'width', 'height',
];

const MAX_RESULTS = 30;

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeGetComputedStylesTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'get_computed_styles',
    `Get the actual rendered computed styles for elements matching a CSS
selector in canvas.html. Returns the post-CSS-cascade values (px / rgb()
form), not raw stylesheet declarations.

Use when:
- Before changing a style property, check the current value (don't guess)
- Verifying contrast ratios (need both color and backgroundColor)
- Debugging why a layout looks wrong

By default returns a generic style set; pass \`props\` to restrict to just
the properties you care about (saves tokens).

Returns up to 30 elements.`,
    {
      selector: z.string().min(1).describe('CSS selector to inspect'),
      props: z
        .array(z.string())
        .optional()
        .describe('Optional: subset of CSS properties to read (camelCase, e.g. ["color","fontSize"]). Default: a generic set.'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional: scope to a specific page (prepends section[data-page="N"])'),
    },
    async ({ selector, props, page: pageIndex }) => {
      if (!workspaceRoot) {
        return {
          content: [{ type: 'text', text: 'No workspace bound; cannot read computed styles.' }],
          isError: true,
        };
      }
      const canvasPath = path.join(workspaceRoot, 'canvas.html');
      try {
        await fs.access(canvasPath);
      } catch {
        return {
          content: [{ type: 'text', text: 'canvas.html not found in workspace.' }],
          isError: true,
        };
      }

      const finalSelector = pageIndex
        ? `section[data-page="${pageIndex}"] ${selector}`
        : selector;
      const finalProps = (Array.isArray(props) && props.length > 0) ? props : DEFAULT_PROPS;

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(`file://${canvasPath}`, { waitUntil: 'networkidle', timeout: 15000 });

        const result = await page.evaluate(({ sel, p, max }) => {
          const els = Array.from(document.querySelectorAll(sel));
          const total = els.length;
          const slice = els.slice(0, max);
          const items = slice.map((el) => {
            const cs = getComputedStyle(el);
            const styles = {};
            for (const prop of p) {
              try {
                styles[prop] = cs[prop];
              } catch {
                styles[prop] = null;
              }
            }
            return {
              tag: el.tagName.toLowerCase(),
              dataAnchor: el.getAttribute('data-anchor') || null,
              text: (el.textContent || '').trim().slice(0, 80),
              computed: styles,
            };
          });
          return { items, total };
        }, { sel: finalSelector, p: finalProps, max: MAX_RESULTS });

        if (result.total === 0) {
          return {
            content: [{
              type: 'text',
              text: `No elements match selector: ${finalSelector}`,
            }],
          };
        }

        const truncatedNote = result.total > MAX_RESULTS
          ? ` (showing first ${MAX_RESULTS} of ${result.total})`
          : '';

        return {
          content: [{
            type: 'text',
            text: `Computed styles for ${result.total} element(s)${truncatedNote}:\n\n${JSON.stringify(result.items, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `get_computed_styles failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      } finally {
        if (browser) {
          try { await browser.close(); } catch { /* ignore */ }
        }
      }
    },
  );
}
