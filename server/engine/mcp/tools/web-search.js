/**
 * mcp/tools/web-search.js — web_search MCP tool
 *
 * 多 provider 联网搜索（移植自 ~/.deskclaw/skills/deskclaw-search-pro/scripts/search.py）。
 * Provider 优先级按 query 语言自动路由：CJK → baidu 优先；非 CJK → tavily 优先；
 * zhipu 配额稀缺永远最后。zero 外部依赖（仅 Node 内置 fetch + URL）。
 *
 * key 配置（.env，至少配一个）：
 *   NODESIGN_BAIDU_QIANFAN_KEY=bce-v3/...
 *   NODESIGN_TAVILY_KEY=tvly-...
 *   NODESIGN_EXA_KEY=...
 *   NODESIGN_ZHIPU_KEY=...
 *
 * agent 视角的工具名：mcp__nodesign__web_search
 *
 * 返回 markdown（top N 条 title + source + snippet + url），让 agent 直接消费，
 * 不暴露 raw JSON 避免 context 灌满。
 *
 * # 调用上限（agent 应自律，SKILL.md 强约束）
 * - baidu 中文：≤2 次 / turn（snippet 即正文，单次通常够）
 * - tavily：≤3-4 次（摘要浅 100-200 字，需多 query 三角验证）
 * - exa：≤1-2 次（content 字段 2000+ 字完整正文，3 次以上爆 context）
 * - zhipu：≤1 次（包配额稀缺）
 * - baidu 英文：禁用（实测严重跑题）
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PROVIDERS = {
  tavily: { keyEnv: 'NODESIGN_TAVILY_KEY' },
  exa:    { keyEnv: 'NODESIGN_EXA_KEY' },
  baidu:  { keyEnv: 'NODESIGN_BAIDU_QIANFAN_KEY' },
  zhipu:  { keyEnv: 'NODESIGN_ZHIPU_KEY' },
};

const PRIORITY_CJK = ['baidu', 'tavily', 'exa', 'zhipu'];
const PRIORITY_NON_CJK = ['tavily', 'exa', 'baidu', 'zhipu'];

function looksChinese(text) {
  // U+4E00-U+9FFF Unified CJK
  return /[一-鿿]/.test(text || '');
}

function getKey(providerId) {
  const env = PROVIDERS[providerId]?.keyEnv;
  return env ? (process.env[env] || '') : '';
}

function autoSelectProvider(query) {
  const order = looksChinese(query) ? PRIORITY_CJK : PRIORITY_NON_CJK;
  for (const id of order) if (getKey(id)) return id;
  return null;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── adapters ──

async function searchTavily(query, key, n) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      topic: 'general',
      max_results: n,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new ProviderError('tavily', res.status, await res.text());
  const raw = await res.json();
  return (raw.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    source: domainOf(r.url || ''),
    publishedAt: r.published_date || '',
  }));
}

async function searchExa(query, key, n) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: 'auto',
      num_results: n,
      contents: { highlights: { max_characters: 4000 } },
    }),
  });
  if (!res.ok) throw new ProviderError('exa', res.status, await res.text());
  const raw = await res.json();
  return (raw.results || []).map(r => {
    const highlights = r.highlights || [];
    return {
      title: r.title || '',
      url: r.url || '',
      snippet: highlights[0] || r.text || '',
      source: domainOf(r.url || ''),
      publishedAt: r.publishedDate || '',
    };
  });
}

async function searchBaidu(query, key, n) {
  // Baidu Qianfan content 字段硬上限 72 字符
  const truncated = query.length > 72 ? query.slice(0, 72) : query;
  const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: truncated }] }),
  });
  if (!res.ok) throw new ProviderError('baidu', res.status, await res.text());
  const raw = await res.json();
  let results = raw.search_results || raw.results || [];
  if (!Array.isArray(results) || results.length === 0) {
    results = raw.references || [];
  }
  return results.slice(0, n).map(r => ({
    title: r.title || '',
    url: r.url || r.link || '',
    snippet: r.content || r.abstract || r.segment_text || '',
    source: r.source || domainOf(r.url || r.link || ''),
    publishedAt: r.publish_time || '',
  }));
}

async function searchZhipu(query, key, n) {
  // 用 dedicated tools/web_search endpoint（比 chat completions 路径更直接）
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/tools/web_search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_engine: 'search_pro',
      search_query: query,
      count: n,
    }),
  });
  if (!res.ok) throw new ProviderError('zhipu', res.status, await res.text());
  const raw = await res.json();
  return (raw.search_result || []).slice(0, n).map(r => ({
    title: r.title || '',
    url: r.link || r.url || '',
    snippet: r.content || '',
    source: r.media || domainOf(r.link || r.url || ''),
    publishedAt: '',
  }));
}

const ADAPTERS = {
  tavily: searchTavily,
  exa: searchExa,
  baidu: searchBaidu,
  zhipu: searchZhipu,
};

class ProviderError extends Error {
  constructor(provider, code, body) {
    super(`[${provider}] HTTP ${code}: ${String(body || '').slice(0, 300)}`);
    this.provider = provider;
    this.code = code;
  }
}

function formatMarkdown(query, provider, hits) {
  const lines = [`## Search results (${provider}, ${hits.length} hits)`, '', `> Query: ${query}`, ''];
  if (hits.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }
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
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeWebSearchTool({ ctx } = {}) {
  return tool(
    'web_search',
    `Search the web via tavily / exa / baidu (Qianfan) / zhipu providers. Auto-routes by query language: CJK
queries prefer baidu, English queries prefer tavily.

Use this tool when:
- You need current information (latest design trends, library docs, recent events)
- You need to verify a fact or find a citation
- You need to find a URL to web_fetch later

DO NOT:
- Run more than 2-3 queries per turn (context bloat)
- Use baidu for English queries (returns severely off-topic results)
- Re-issue the same query to retry — change the wording instead

For Chinese queries baidu's snippet field already contains 500-3000 chars of body text;
you usually don't need to web_fetch the URL afterwards. Tavily snippets are short (100-200
chars) and may need a follow-up fetch.

Add a year hint (e.g., "2025 2026") to the query — search engines especially Chinese ones
often return stale results without it.`,
    {
      query: z.string().min(2).max(500).describe('Search query. Add year hints (2025/2026) for time-sensitive results. Baidu truncates content to 72 chars — keep CJK queries short.'),
      provider: z
        .enum(['tavily', 'exa', 'baidu', 'zhipu', 'auto'])
        .optional()
        .describe('Force a provider; default "auto" routes by query language.'),
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Max results to return (default 5).'),
    },
    async ({ query, provider = 'auto', count = 5 }) => {
      try {
        const providerId = provider === 'auto' ? autoSelectProvider(query) : provider;
        if (!providerId) {
          return {
            content: [{
              type: 'text',
              text: 'web_search failed: no provider configured. Set at least one of '
                + Object.values(PROVIDERS).map(p => p.keyEnv).join(' / ')
                + ' in NoDesign .env.',
            }],
            isError: true,
          };
        }
        const key = getKey(providerId);
        if (!key) {
          return {
            content: [{
              type: 'text',
              text: `web_search failed: ${PROVIDERS[providerId].keyEnv} not set in .env.`,
            }],
            isError: true,
          };
        }

        const adapter = ADAPTERS[providerId];
        const hits = await adapter(query, key, count);

        try {
          ctx?.emit?.({
            type: 'run.web_search',
            provider: providerId,
            query,
            hits: hits.length,
          });
        } catch { /* fail-safe */ }

        return {
          content: [{ type: 'text', text: formatMarkdown(query, providerId, hits) }],
        };
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
