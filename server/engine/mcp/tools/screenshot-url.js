/**
 * mcp/tools/screenshot-url.js — screenshot_url MCP tool（2026-07-29）
 *
 * 对任意外部 URL 截图。诞生背景：explorer 找视觉参考只能 WebFetch 拿文本，
 * 再用文字向主 agent 转述"这个站是深色的、图占主导"—— 找视觉参考却看不见
 * 视觉。这个工具让 explorer / 主 agent 直接看到参考站长什么样。
 *
 * 安全：
 *   - 只放 http/https（file:// 会变成任意本地文件读取，硬拒）
 *   - 拒绝内网/环回/link-local 字面量（localhost / 127.* / 10.* / 172.16-31.* /
 *     192.168.* / 169.254.* / *.local / [::1]）—— explorer 会读不可信网页内容，
 *     prompt injection 不该能借它窥探内网服务。DNS rebinding 不在防御范围
 *     （截图只回图片，风险面已经很小）。
 *
 * 加载策略：外站经常永远到不了 networkidle（分析脚本长轮询），goto 超时不算
 * 失败 —— 部分渲染的参考图也比纯文字转述强，超时记进 caption。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { attachPageDiagnostics, runBeforeShot, normalizeShot, FIDELITY_LAUNCH_ARGS, detectPaintTransform } from './helpers/shot-pipeline.js';
import { checkUrl, attachSsrfGuard } from '../../../lib/ssrf-guard.js';
import { denyText } from './browse.js';
import { startBrowseProxy } from '../../../lib/browse-proxy.js';
import { isRegisteredLoopback } from '../../process/registry.js';

const RASTER_SCALE = 0.6;
const DEVICE_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

const PRIVATE_HOST_RE = new RegExp(
  '^(localhost|0\\.0\\.0\\.0|127\\.|10\\.|192\\.168\\.|169\\.254\\.'
  + '|172\\.(1[6-9]|2[0-9]|3[01])\\.'
  + '|\\[::1\\]|\\[fc|\\[fd|\\[fe80)'
  , 'i',
);

function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, message: `not a valid URL: ${raw}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: `only http/https URLs are allowed (got ${u.protocol})` };
  }
  // ⚠️ 这里**只做词法预筛**。真判据是 checkUrl（解析 DNS 按 IP 判）+ 页面上挂的
  // CDP 闸（拦跳转与子资源）。留着这道是因为它便宜、能在解析之前挡掉最常见的字面量。
  const host = u.hostname.toLowerCase();
  // 进程卡起的 dev server（登记表里在跑的端口）是唯一放行的本机地址
  if (u.port && isRegisteredLoopback(host, u.port)) return { ok: true, url: u };
  if (PRIVATE_HOST_RE.test(host) || host.endsWith('.local')) {
    return { ok: false, message: `refusing to screenshot private/internal address: ${host}` };
  }
  return { ok: true, url: u };
}

/**
 * @param {object} deps
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeScreenshotUrlTool({ projectId, ctx } = {}) {
  return tool(
    'screenshot_url',
    `Take a screenshot of any external web page (http/https) and return it as an
image you can see via vision. THE tool for gathering visual design references —
when researching how other sites handle layout, typography, color, or imagery,
look at them instead of reading their HTML and imagining.

- device: render at a real device width (desktop=1440, tablet=834, mobile=390)
- fullPage=true captures the whole scrollable page (auto-scrolls first so
  lazy-loaded images and scroll reveals are triggered); default captures the
  first viewport only — usually enough to judge a site's character, and much
  cheaper in context
- The caption reports console errors / failed resources of the target page —
  ignore those unless they explain a broken-looking render.

External pages can be slow; if the network never settles the shot is taken
anyway after 12s and the caption says so. Only http/https and public hosts.`,
    {
      url: z.string().describe('The http/https URL to screenshot'),
      device: z
        .enum(['desktop', 'tablet', 'mobile'])
        .optional()
        .describe('Viewport width preset: desktop=1440 (default), tablet=834, mobile=390'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page (auto-scrolls through it first to trigger lazyload). Default false = first viewport only, much cheaper.'),
      detail: z
        .enum(['normal', 'high'])
        .optional()
        .describe("Raster detail. 'normal' (default) = 0.6x pixels, enough for layout/palette judgment. 'high' = full resolution, only when you must read small text."),
    },
    async ({ url: rawUrl, device, fullPage, detail }) => {
      const check = validateUrl(rawUrl);
      if (!check.ok) {
        return { content: [{ type: 'text', text: check.message }], isError: true };
      }
      // ⛔ 2026-08-18 补：上面那道 `validateUrl` 是**纯词法**的 —— 挡得住
      // `127.0.0.1` 这种字面量，挡不住一个 DNS 解析到内网的公网域名，也不管 302。
      // 新闸（lib/ssrf-guard.js）本来就是来替换它的，但上线那天**忘了接这个工具**，
      // 于是它自己一直是个活着的 SSRF 洞。现在：按解析出的 IP 判 + 页面上挂 CDP 闸
      // 拦跳转与子资源。
      const pre = await checkUrl(check.url.href);
      if (!pre.ok) {
        // 拒因分种类说（DNS 死域名 ≠ 策略拦截；文案与线上地址提示同 browse 工具）
        const tail = denyText(pre, projectId, check.url.href).join('\n');
        return { content: [{ type: 'text', text: `refusing to screenshot: ${pre.reason}\n${tail}` }], isError: true };
      }

      const vp = DEVICE_VIEWPORTS[device || 'desktop'];
      let browser;
      try {
        const { chromium } = await import('playwright');
        // ⭐ 走同一个出网代理（2026-08-18 二次修）。CDP 那道闸看不见四类东西：
        // WebSocket 握手、`<link rel=prefetch>`、`sendBeacon`、还没装闸的弹窗
        // —— 四条都是攻出来的，而这个工具吃的正是**任意用户给的 URL**，同一批
        // 绕过一字不改就能用在它身上。代理是所有出网的必经之路，且连的是自己
        // 解析并验过的那个 IP（顺带根除 DNS 重绑定）。
        // `bypass: ''`：默认会放过 loopback，那正是最要拦的。
        const { port: proxyPort } = await startBrowseProxy();
        browser = await chromium.launch({
          headless: true,
          args: FIDELITY_LAUNCH_ARGS,
          proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '' },
        });
        const rasterScale = detail === 'high' ? 1 : RASTER_SCALE;
        const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: rasterScale, colorScheme: 'light' });
        const guard = await attachSsrfGuard(ctx, undefined, { proxied: true });
        const page = await ctx.newPage();
        await guard.armPage(page);   // ⭐ 必须 await 完才导航（竞态是攻出来的）
        const diag = attachPageDiagnostics(page);

        let gotoNote = null;
        try {
          await page.goto(check.url.href, { waitUntil: 'networkidle', timeout: 12000 });
        } catch (err) {
          // 超时（页面已部分渲染）→ 照截；真导航失败（DNS/refused）→ 报错
          if (!/Timeout/i.test(String(err?.message))) {
            return {
              content: [{ type: 'text', text: `Failed to load ${rawUrl}: ${err?.message || err}` }],
              isError: true,
            };
          }
          gotoNote = 'network never settled (12s) — captured current render state';
        }

        if (fullPage) {
          // 滚一遍触发 lazyload / scroll reveal，再回顶整页截
          await runBeforeShot(page, 'scrollToBottom');
        }
        const buf = await page.screenshot({ fullPage: fullPage === true, type: 'png' });

        try {
          ctx?.emit?.({
            type: 'run.screenshot_taken',
            sizeBytes: buf.length,
            viewport: vp,
            mode: `url=${check.url.hostname}`,
          });
        } catch { /* emit fail-safe */ }

        const paintNote = await detectPaintTransform(page);
        const shot = await normalizeShot(buf);
        const title = await page.title().catch(() => '');
        const finalUrl = page.url();
        const captionParts = [
          `Screenshot of ${finalUrl}${title ? ` — "${title}"` : ''} (${device || 'desktop'} ${vp.width}x${vp.height} @${rasterScale}x, fullPage=${fullPage === true})`,
        ];
        if (shot.note) captionParts.push(shot.note);
        if (gotoNote) captionParts.push(gotoNote);
        if (paintNote) captionParts.push(paintNote);
        captionParts.push(diag.summary());

        return {
          content: [
            { type: 'text', text: captionParts.join('\n') },
            { type: 'image', data: shot.data, mimeType: shot.mimeType },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `screenshot_url failed: ${err?.message || String(err)}` }],
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
