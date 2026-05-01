/**
 * mcp/tools/web-fetch.js — web_fetch MCP tool
 *
 * 直接 HTTP GET URL → 简单 HTML→text 转换 → 返回前 N 字符给 agent。
 * 不依赖任何 LLM API（不像 SDK 内置 WebFetch 用 prompt 总结）— 走纯 stdlib
 * fetch + 正则提取 title/text/links。
 *
 * agent 视角的工具名：mcp__nodesign__web_fetch
 *
 * # 跟 web_search 配合
 *
 * web_search 已经返完整 snippet（baidu 500-3000 字 / exa 2000+ 字），通常足够。
 * web_fetch 只在以下场景才用：
 *   - tavily/exa snippet 缺关键数字、需要看原页面
 *   - 用户给 URL 要求阅读
 *   - 需要从已知 URL 抓最新内容（如官方文档某页）
 *
 * # 限制
 *
 * - maxBytes 默认 30k chars，硬上限 200k（防爆 context）
 * - 仅 http/https，不接 file:// / ftp:// 等危险协议
 * - 不跑 JS（静态 HTML），SPA / 客户端渲染拿不到内容
 * - timeout 30s
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DEFAULT_MAX_BYTES = 30000;
const HARD_MAX_BYTES = 200000;
const TIMEOUT_MS = 30000;

/**
 * 极简 HTML → 纯文本转换。不依赖 cheerio / jsdom，走正则。
 * 返回 { title, text }。text 是去除 script/style/HTML tag 后的文本。
 */
function htmlToText(html) {
  // 提取 title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  // 干掉 script/style/noscript 完整块（含内容）
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // 块级元素后加换行（让段落分明）
  text = text.replace(/<\/?(p|br|div|h[1-6]|li|tr|article|section|header|footer|aside|nav)\b[^>]*>/gi, '\n');

  // 干掉所有剩余 tag
  text = text.replace(/<[^>]+>/g, '');

  // 解码常见 HTML entities
  text = decodeEntities(text);

  // 折叠空白：连续空格 → 1 个，连续换行 ≥3 → 2
  text = text.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return { title, text };
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|ldquo|rdquo|lsquo|rsquo);/g,
      m => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeWebFetchTool({ ctx } = {}) {
  return tool(
    'web_fetch',
    `Fetch a URL and return its plain text content (title + body). No LLM summarization —
returns raw extracted text up to maxBytes characters.

Use this tool when:
- web_search snippet is too short and you need the full article body
- The user gives a URL to read
- You need current content from a known doc/page

DO NOT use this tool when:
- web_search snippet (especially baidu's) already has 500+ chars of body — that's
  usually enough for design/research questions
- The page is a SPA / client-rendered (this tool fetches static HTML only, won't see JS-loaded content)
- You're doing speculative browsing — each fetch is one round-trip + bytes into context

Returns extracted plain text (HTML tags / scripts / styles stripped, entities decoded,
whitespace collapsed). Truncated to maxBytes (default 30000 chars) to protect context.`,
    {
      url: z
        .string()
        .url()
        .describe('Fully-qualified http/https URL to fetch'),
      maxBytes: z
        .number()
        .int()
        .min(500)
        .max(HARD_MAX_BYTES)
        .optional()
        .describe(`Max chars to return (default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_MAX_BYTES})`),
    },
    async ({ url, maxBytes = DEFAULT_MAX_BYTES }) => {
      try {
        // 安全：仅 http/https
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) {
          return {
            content: [{ type: 'text', text: `web_fetch refused: only http/https supported, got ${parsed.protocol}` }],
            isError: true,
          };
        }

        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

        let res;
        try {
          res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              // 一些站点拒纯 Node UA — 用通用 desktop UA
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
            },
          });
        } finally {
          clearTimeout(tid);
        }

        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `web_fetch failed: HTTP ${res.status} ${res.statusText} — ${url}` }],
            isError: true,
          };
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const isHtml = contentType.includes('html') || contentType.includes('xml');
        const isJson = contentType.includes('json');
        const isText = contentType.startsWith('text/');

        if (!isHtml && !isJson && !isText) {
          return {
            content: [{ type: 'text', text: `web_fetch refused: unsupported content-type "${contentType}" — this tool only handles HTML/text/JSON.` }],
            isError: true,
          };
        }

        // 流式读防超大下载（如视频文件 content-type 标错）
        const reader = res.body?.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let raw = '';
        const READ_HARD_CAP = HARD_MAX_BYTES * 4;  // 字节级硬保险（防 binary 流爆内存）
        if (reader) {
          let bytesRead = 0;
          while (bytesRead < READ_HARD_CAP) {
            const { value, done } = await reader.read();
            if (done) break;
            bytesRead += value.byteLength;
            raw += decoder.decode(value, { stream: true });
            if (raw.length >= HARD_MAX_BYTES * 2) break;  // 字符级也截一次
          }
          raw += decoder.decode();  // flush
          try { reader.cancel(); } catch { /* ignore */ }
        } else {
          raw = await res.text();
        }

        let title = '';
        let text;
        if (isHtml) {
          ({ title, text } = htmlToText(raw));
        } else {
          // text/* 或 json：直接当文本，不去 tag
          text = raw;
        }

        const fullLen = text.length;
        const truncated = fullLen > maxBytes;
        if (truncated) text = text.slice(0, maxBytes) + '\n\n…[truncated, original length ' + fullLen + ' chars]';

        const headerLines = [
          `URL: ${url}`,
          ...(title ? [`Title: ${title}`] : []),
          `Content-Type: ${contentType}`,
          `Length: ${fullLen} chars${truncated ? ` (returning first ${maxBytes})` : ''}`,
          '',
          '---',
          '',
        ];

        try {
          ctx?.emit?.({
            type: 'run.web_fetch',
            url,
            title,
            length: fullLen,
            truncated,
          });
        } catch { /* fail-safe */ }

        return {
          content: [{ type: 'text', text: headerLines.join('\n') + text }],
        };
      } catch (err) {
        const msg = err?.name === 'AbortError'
          ? `web_fetch timed out after ${TIMEOUT_MS / 1000}s`
          : `web_fetch error: ${err?.message || String(err)}`;
        return {
          content: [{ type: 'text', text: msg }],
          isError: true,
        };
      }
    },
  );
}
