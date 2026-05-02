/**
 * mcp/tools/query-elements.js — query_elements MCP tool
 *
 * 用 CSS selector 在 canvas.html 里 querySelectorAll，返回每个元素的
 * { anchor, tag, text, bbox, dataAttrs } —— anchor schema 跟前端
 * lib/html-utils.js 的 serializeAnchor 一致，agent 可以直接拿这个 anchor
 * 喂回前端做精确选中（未来）或继续 query。
 *
 * 典型场景：
 *   - "把所有 H1 字号统一成 56" → query_elements({selector:'h1'}) 拿全清单
 *   - "找到 cover 上那个 cta 按钮" → query_elements({selector:'[data-anchor="cover-cta"]'})
 *
 * 限制：返回 max 50 条，溢出截断 + 文本提示。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const MAX_RESULTS = 50;

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeQueryElementsTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'query_elements',
    `Query elements in canvas.html via CSS selector. Returns a list of
matched elements with { anchor, tag, text, bbox, dataAttrs }.

The anchor object (dataId / path / textHint / bbox) is the same schema used
by the frontend selection system — you can reference it later to highlight
or pin comments.

Use when:
- You need to inspect/operate on multiple elements matching a pattern
  (all H1, all .cta, all data-anchor="page-N-title", etc.)
- Before bulk-editing, get the current state list first
- Verifying that a class / data-attr is applied where you expect

Returns up to 50 matches; further results truncated with a hint.`,
    {
      selector: z
        .string()
        .min(1)
        .describe('CSS selector (e.g., "h1", ".accent", \'[data-anchor="cover-title"]\', \'section[data-page="2"] p\')'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional: scope query to a specific page (prepends section[data-page="N"] to selector)'),
    },
    async ({ selector, page: pageIndex }) => {
      if (!workspaceRoot) {
        return {
          content: [{ type: 'text', text: 'No workspace bound; cannot query.' }],
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

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(`file://${canvasPath}`, { waitUntil: 'networkidle', timeout: 15000 });

        const result = await page.evaluate(({ sel, max }) => {
          const els = Array.from(document.querySelectorAll(sel));
          const total = els.length;
          const slice = els.slice(0, max);

          const computePath = (el) => {
            const segments = [];
            let cur = el;
            while (cur && cur !== document.body && cur.nodeType === 1) {
              const tag = cur.tagName.toLowerCase();
              const parent = cur.parentNode;
              if (!parent || parent.nodeType !== 1) break;
              const sameType = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
              const idx = sameType.indexOf(cur) + 1;
              segments.unshift(sameType.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
              cur = parent;
            }
            return segments.join(' > ');
          };

          const items = slice.map((el) => {
            const r = el.getBoundingClientRect();
            const dataId = el.getAttribute('data-node-id') || null;
            const text = (el.textContent || '').trim();
            const dataAttrs = {};
            for (const a of Array.from(el.attributes)) {
              if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value;
            }
            return {
              anchor: {
                dataId,
                path: computePath(el),
                textHint: text.slice(0, 50),
                bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
              },
              tag: el.tagName.toLowerCase(),
              text: text.slice(0, 200),
              bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
              dataAttrs,
            };
          });

          return { items, total };
        }, { sel: finalSelector, max: MAX_RESULTS });

        if (result.total === 0) {
          return {
            content: [{
              type: 'text',
              text: `No elements match selector: ${finalSelector}`,
            }],
          };
        }

        const truncatedNote = result.total > MAX_RESULTS
          ? ` (showing first ${MAX_RESULTS} of ${result.total} matches)`
          : '';

        return {
          content: [{
            type: 'text',
            text: `Matched ${result.total} element(s)${truncatedNote}:\n\n${JSON.stringify(result.items, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `query_elements failed: ${err?.message || String(err)}` }],
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
