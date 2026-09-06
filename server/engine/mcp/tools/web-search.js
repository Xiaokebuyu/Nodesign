/**
 * mcp/tools/web-search.js — web_search MCP tool
 *
 * 多 provider 联网搜索（移植自 ~/.deskclaw/skills/deskclaw-search-pro/scripts/search.py）。
 * Provider 优先级按 query 语言自动路由：CJK → baidu 优先；非 CJK → tavily 优先；
 * zhipu 配额稀缺永远最后。zero 外部依赖（仅 Node 内置 fetch + URL）。
 *
 * key 配置（.env，至少配一个）：见 web-search-providers.js（四家适配器与选家 09-07 拆去那里，
 * 因为 hosted relay 也要跑同一段：桌面版没 key 时由网关替它搜，见 relay-tools.js）。
 *
 * agent 视角的工具名：mcp__nodesign__web_search
 *
 * 返回 markdown（top N 条 title + source + snippet + url），让 agent 直接消费，
 * 不暴露 raw JSON 避免 context 灌满。
 *
 * # 调用上限（没有硬闸，全靠 description 里那句"一回合 2-3 次"）
 * 各家的经验值：baidu 中文 snippet 即正文，单次通常够；tavily 摘要浅（100-200 字）要多 query
 * 三角验证；exa 的 content 字段 2000+ 字，3 次以上爆 context；zhipu 包配额稀缺；baidu 英文实测
 * 严重跑题。⚠️ 这些数字**没有**写在任何 SKILL.md 里（09-07 核过），别在别处声称"SKILL 强约束"。
 */

import { downloadReferenceImages } from './helpers/reference-download.js';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PROVIDERS, ProviderError, domainOf, runWebSearch } from './web-search-providers.js';
import { searchRoute, relayWebSearch } from './relay-tools.js';


function formatMarkdown(query, provider, hits, { images = [] } = {}) {
  const lines = [`## Search results (${provider}, ${hits.length} hits)`, '', `> Query: ${query}`, ''];
  if (hits.length === 0) {
    lines.push('No text results found.');
  } else {
    hits.forEach((h, i) => {
      const src = h.source ? ` — ${h.source}` : '';
      const pub = h.publishedAt ? ` (${h.publishedAt})` : '';
      lines.push(`${i + 1}. **${h.title || 'Untitled'}**${src}${pub}`);
      if (h.snippet) {
        // 缩进显示，限单条 snippet 800 字符防爆 context
        const snippet = h.snippet.length > 800 ? h.snippet.slice(0, 800) + '…' : h.snippet;
        for (const line of snippet.split('\n')) lines.push(`   ${line}`);
      }
      if (h.url) lines.push(`   ${h.url}`);
      lines.push('');
    });
    if (images.length === 0) {
      lines.push(
        '> Snippets carry no layout, type or colour. For anything visual, browser_navigate the promising '
        + 'URLs and browse their inner pages; for text, WebFetch the URL. To see pictures of a subject or a '
        + 'style, re-run with include_images: true.',
        '',
      );
    }
  }

  if (images.length > 0) {
    lines.push(`## Reference images (downloaded, ${images.length})`, '');
    lines.push(
      '> The actual pixel content of each image follows this text as inline '
      + 'image content blocks (in the same numbered order). Vision-check them '
      + 'directly to pick the best 1-2 candidates.',
      '> Then pass the chosen `local_path` value(s) as `referenceImages[]` to '
      + '`mcp__nodesign__generate_image` (paths are already inside the workspace).',
      '',
    );
    images.forEach((img, i) => {
      const desc = img.description || img.title || '(no description)';
      const sizeKB = (img.sizeBytes / 1024).toFixed(0);
      lines.push(`${i + 1}. ${desc}`);
      lines.push(`   local_path: ${img.relPath}`);
      lines.push(`   size: ${sizeKB} KB, mime: ${img.mimeType}`);
      lines.push(`   source: ${domainOf(img.url)}`);
      lines.push(`   url: ${img.url}`);
      lines.push('');
    });
  }
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {string} [deps.workspaceRoot]      agent cwd（include_images 下载落档需要）
 * @param {string} [deps.sharedRoot]         project shared/，存在时优先落档
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeWebSearchTool({ workspaceRoot, sharedRoot, ctx } = {}) {
  return tool(
    'web_search',
    `Search the web via tavily / exa / baidu (Qianfan) / zhipu providers. Auto-routes by query language: CJK
queries prefer baidu, English queries prefer tavily.

Use this tool when:
- You need current information (latest design trends, library docs, recent events)
- You need to verify a fact or find a citation
- You need to find a URL to then GO LOOK AT: for anything visual, follow up with browser_navigate and browse the site's inner pages — snippets carry no layout, type or colour. (Or WebFetch for text.)
- You need to SEE something: set include_images=true (see below). Two cases — a real, specific subject you are about to draw with generate_image (named IP / character / person / product model / niche brand), and a style or creative tradition you want to look at before designing in it.

DO NOT:
- Run more than 2-3 queries per turn (context bloat)
- Use baidu for English queries (returns severely off-topic results)
- Re-issue the same query to retry — change the wording instead

For Chinese queries baidu's snippet field already contains 500-3000 chars of body text;
you usually don't need to WebFetch the URL afterwards. Tavily snippets are short (100-200
chars) and may need a follow-up fetch.

Add a year hint (e.g., "2025 2026") to the query — search engines especially Chinese ones
often return stale results without it.

# include_images mode

Downloads the top-N image hits into <workspace>/assets/references/ref-<hash>.<ext>
and returns each one as an inline image content block (same numbered order as the
markdown), so you vision-check them in this turn without calling Read. Each entry
carries a 'local_path' — that is what goes into generate_image referenceImages[]
(never the http url). Auto-routes CJK → baidu (native image search), EN → tavily
(best image descriptions), exa as fallback; zhipu has no image search and is rejected.
CJK queries sent to tavily/exa are auto-translated to English first. Filter: 5KB ≤ size
≤ 8MB, png/jpg/webp/gif only. Every returned image stays in context for the rest of
the session, so keep it to 2-3 image queries per turn; count is fine at 5-10.`,
    {
      query: z.string().min(2).max(500).describe('Search query. Add year hints (2025/2026) for time-sensitive results. Baidu truncates content to 72 chars — keep CJK queries short.'),
      provider: z
        .enum(['tavily', 'exa', 'baidu', 'zhipu', 'auto'])
        .optional()
        .describe('Force a provider; default "auto" routes by query language. include_images=true auto-routes among tavily/exa/baidu (zhipu rejected, no image support).'),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Max text results to return (default 5). Image count follows the same value.'),
      include_images: z
        .boolean()
        .optional()
        .describe('Returns top-N reference images downloaded into assets/references/ for use as generate_image referenceImages. Auto-routes CJK→baidu / EN→tavily (exa fallback). CJK queries on tavily/exa are auto-translated to English for richer descriptions. zhipu rejected. Default false.'),
    },
    async ({ query, provider = 'auto', count = 5, include_images = false }) => {
      try {
        // 1) 选路：本机有 key 就本机搜；没有但登录了站点（桌面版）就让网关用站主的 key 搜（按账号计次）；
        //    都没有 → 同一句"没配 provider"
        const route = searchRoute();
        if (!route) {
          return { content: [{ type: 'text', text: `web_search failed: no provider configured. Set at least one of ${Object.values(PROVIDERS).map(p => p.keyEnv).join(' / ')} in NoDesign .env.` }], isError: true };
        }
        // 2) 搜（选家 + 调适配器；relay 那边跑的是同一个 runWebSearch）
        const result = route === 'relay'
          ? await relayWebSearch({ query, provider, count, includeImages: include_images })
          : await runWebSearch({ query, provider, count, includeImages: include_images });
        if (result.error) return { content: [{ type: 'text', text: result.error }], isError: true };
        const { providerId, providerNote } = result;
        const effectiveQuery = query;
        const hits = result.hits || [];
        const rawImages = result.images || [];

        // 4) Image 下载（include_images=true 才走）
        //    Provider 之间数量差异大（tavily ≤5、exa 可达 count*5、baidu image
        //    模态 + web_extensions 合起来可达 30+）。取 count*2 当下载头空间，
        //    再把最终结果截到 count 张，让 markdown 输出可预期。
        let downloadedImages = [];
        if (include_images && rawImages.length > 0) {
          if (!workspaceRoot) {
            return {
              content: [{
                type: 'text',
                text: 'web_search internal error: workspaceRoot not configured for include_images mode.',
              }],
              isError: true,
            };
          }
          // ⚠️ **下多少就报多少**（2026-08-18 修）。以前按 `count*2` 下载却只
          // `slice(0, count)` 上报 —— 磁盘上留着一半 agent 不知道存在的文件，
          // 而它们照样占空间、照样进导出包。多下的那批本来是为了容错（有些 URL
          // 会 404），现在改成：**下够 count 张就停**，成功几张报几张。
          const dlCandidates = rawImages.slice(0, Math.max(count * 2, 5));
          const downloaded = await downloadReferenceImages(dlCandidates, {
            workspaceRoot, sharedRoot, stopAfter: count,
          });
          downloadedImages = downloaded;
          // 落盘了就发 file_changed —— generate_image 一直在发，这里漏了，
          // 于是参考图落进工作区之后前端毫无感知（素材抽屉要刷新才看得见）
          for (const img of downloadedImages) {
            try { ctx?.emit?.({ type: 'run.file_changed', filePath: img.relPath, event: 'add' }); } catch { /* */ }
          }
        }

        try {
          ctx?.emit?.({
            type: 'run.web_search',
            provider: providerId,
            query: effectiveQuery,
            hits: hits.length,
            referenceImages: downloadedImages.length,
          });
        } catch { /* fail-safe */ }

        // 文本 + 每张图一块 image content block（顺序与 markdown 编号一致）
        // 让 agent 当 turn 直接 vision-check 候选 reference，省掉逐张 Read。
        // 内联图片成本：~1568 token/张（Anthropic image block tokenization）×
        // count 张 + base64 体积。已在上一步通过 count 截断控量。
        const out = [{
          type: 'text',
          text: `${providerNote ? `${providerNote}\n` : ''}${formatMarkdown(query, providerId, hits, { images: downloadedImages })}`,
        }];
        for (const img of downloadedImages) {
          if (img.base64) {
            out.push({
              type: 'image',
              data: img.base64,
              mimeType: img.mimeType,
            });
          }
        }
        return { content: out };
      } catch (err) {
        const msg = err instanceof ProviderError
          ? err.message + (err.code === 401 || err.code === 403
            ? ` (auth failed — check ${PROVIDERS[err.provider].keyEnv})`
            : err.code === 429
              ? ' (rate limit / quota exhausted — try another provider)'
              : '')
          : `web_search error: ${err?.message || String(err)}`;
        return {
          content: [{ type: 'text', text: msg }],
          isError: true,
        };
      }
    },
  );
}
