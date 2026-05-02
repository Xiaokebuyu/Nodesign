/**
 * mcp/tools/list-pages.js — list_pages MCP tool
 *
 * 加载 canvas.html 用 playwright headless，扫所有 `<section data-page="N">`
 * 返回每页的元信息（index / layout / data-anchor / 标题 / bbox）。比 read_page
 * 轻 —— read_page 给整段 outerHTML，list_pages 只给每页 1 行摘要。
 *
 * 典型场景：agent 想知道"这 deck 有多少页 / 每页大致是什么主题"，做总览决策时调。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeListPagesTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'list_pages',
    `List all pages in canvas.html — for each <section data-page="N"> returns
{ index, layout, anchor, title, bbox }.

Use when:
- You want a quick deck overview before deciding what to change
- You need to know total page count
- Verifying page numbering / layout assignments after restructure

Lighter than read_page (which returns full outerHTML of one page).`,
    {
      _placeholder: z.string().optional().describe('Unused; reserved for future filters'),
    },
    async () => {
      if (!workspaceRoot) {
        return {
          content: [{ type: 'text', text: 'No workspace bound; cannot list pages.' }],
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

      let browser;
      try {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(`file://${canvasPath}`, { waitUntil: 'networkidle', timeout: 15000 });

        const pages = await page.$$eval('section[data-page]', (sections) => {
          return sections.map((s, i) => {
            const r = s.getBoundingClientRect();
            const idxAttr = s.getAttribute('data-page');
            const heading = s.querySelector('h1, h2, h3, h4');
            return {
              index: idxAttr ? parseInt(idxAttr, 10) : (i + 1),
              layout: s.getAttribute('data-layout') || null,
              anchor: s.getAttribute('data-anchor') || null,
              title: heading ? (heading.textContent || '').trim().slice(0, 100) : null,
              bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
            };
          });
        });

        if (pages.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'canvas.html has no <section data-page="N"> elements.',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `${pages.length} page(s):\n\n${JSON.stringify(pages, null, 2)}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `list_pages failed: ${err?.message || String(err)}` }],
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
