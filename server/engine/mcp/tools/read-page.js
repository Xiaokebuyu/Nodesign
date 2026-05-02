/**
 * mcp/tools/read-page.js — read_page MCP tool
 *
 * 让 agent 精确读 canvas.html 的某一页（`<section data-page="N">` 一段），
 * 不必每次 Read 整个 canvas.html 然后自己切片。
 *
 * 解的痛点（2026-05-02 用户观察）：
 *   - 当前 agent 看 canvas.html 经常只看第一页（Read 默认 limit 影响）
 *   - 让 agent 用 Grep + Read offset/limit 切片是可以但笨拙
 *   - canvas 焕新升级 S1：给 agent 一个原子工具直接拿"第 N 页"内容
 *
 * 行为：
 *   - input: { page: number }（1-based，跟 data-page="N" 一致）
 *   - 找 canvas.html 里 `<section[^>]*data-page="N"[^>]*>...</section>` 一段
 *   - 返该段 outerHTML（含 attributes + 完整子树）
 *   - 找不到该页 → isError + 列出当前 canvas.html 实际有哪些 page
 *   - canvas.html 不存在 → isError + 提示 agent 需要先 Write 创建
 *
 * 用 regex 而非 DOM parser：纯字符串匹配，避免 jsdom 等大依赖；
 * canvas.html 是 agent 自己写的，section 嵌套不会出现（约定每页是 sibling section）。
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
export function makeReadPageTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'read_page',
    `Read a specific page (a single \`<section data-page="N">\`) from canvas.html.

Use this instead of Read+Grep+offset/limit when you want to inspect or
reason about one specific page in detail. Returns the outerHTML of that
section (including attributes and full subtree).

When to use:
- "Show me what page 3 looks like in code" — read_page(3)
- Before editing page N — read_page(N) to see exact current markup
- Debugging why a specific page renders wrong

When NOT to use:
- Reading the whole deck structure → use Read on canvas.html with limit:50
  to see all section openings
- Finding a specific element across pages → use Grep
- canvas.html doesn't exist yet (creating from scratch) → use Write directly`,
    {
      page: z
        .number()
        .int()
        .min(1)
        .describe('Page number (1-based, matches data-page="N" attribute)'),
    },
    async ({ page }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot read page.' }],
            isError: true,
          };
        }

        const canvasPath = path.join(workspaceRoot, 'canvas.html');
        let raw;
        try {
          raw = await fs.readFile(canvasPath, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') {
            return {
              content: [{
                type: 'text',
                text: 'canvas.html does not exist yet. Use Write to create it first '
                  + '(see SKILL.md for the section data-page="N" structure).',
              }],
              isError: true,
            };
          }
          throw err;
        }

        // 匹配 `<section ... data-page="<page>" ...>...</section>`
        // 双引号 / 单引号 / 不引号都接受。section 内不嵌套 section（约定）。
        const pageStr = String(page);
        const escaped = pageStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 三种 attribute quoting 尝试
        const patterns = [
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*"${escaped}"[^>]*>[\\s\\S]*?</section>`, 'i'),
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*'${escaped}'[^>]*>[\\s\\S]*?</section>`, 'i'),
          new RegExp(`<section\\b[^>]*\\bdata-page\\s*=\\s*${escaped}\\b[^>]*>[\\s\\S]*?</section>`, 'i'),
        ];

        let match = null;
        for (const re of patterns) {
          const m = raw.match(re);
          if (m) { match = m; break; }
        }

        if (!match) {
          // 列出 canvas.html 里实际有哪些 page，给 agent 反馈
          const allPages = [...raw.matchAll(/<section\b[^>]*\bdata-page\s*=\s*['"]?(\d+)/gi)]
            .map(m => m[1])
            .filter((v, i, arr) => arr.indexOf(v) === i);
          const pagesList = allPages.length > 0
            ? `Available pages: ${allPages.join(', ')}`
            : 'canvas.html has no <section data-page="N"> structure '
              + '(might be a non-deck artifact).';
          return {
            content: [{
              type: 'text',
              text: `Page ${page} not found in canvas.html. ${pagesList}`,
            }],
            isError: true,
          };
        }

        const sectionHtml = match[0];
        return {
          content: [{
            type: 'text',
            text: `Page ${page} (${sectionHtml.length} chars):\n\n${sectionHtml}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `read_page failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
