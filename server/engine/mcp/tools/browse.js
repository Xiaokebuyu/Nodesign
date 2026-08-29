/**
 * mcp/tools/browse.js — agent 真的会用浏览器（2026-08-18）
 *
 * 四个工具共用 `engine/browse/registry.js` 的常驻实例：
 *   browser_navigate / browser_read / browser_click / browser_screenshot
 *
 * ## 跟 screenshot_url 的分工
 *
 * `screenshot_url` 是**一次性一张图**：开一个全新 chromium、截、关。便宜，适合
 * 「我只想看一眼这个站长什么样」。它留着不动。
 *
 * 这一组是**有会话的浏览**：点链接、翻子页、登录态留得住、Cookie 同意弹窗点一次就
 * 不再弹。用户提这条的原话是「很多时候可以让 agent 主动去访问相关内容的网站获取
 * 灵感」——而在这之前想看一个站第三层的页面只能猜 URL。
 *
 * ## 搜索不归这里管
 *
 * agent 先用现有搜索通道找到目标站，**再用 URL 直接访问**（用户拍板）。所以这里
 * 没有内建搜索，只有导航/读/点/截。
 *
 * ## 出网闸
 *
 * 每个请求（含跳转的每一跳、iframe、子资源）都过 `lib/ssrf-guard.js`。闸长在工具的
 * 实现体里 —— agent 关不掉它。被拦的东西会**如实写进返回值**：闸静默拦掉再让 agent
 * 对着一个半残的页面猜，比拦不住只好一点。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withBrowser, peek, hold, _limits } from '../../browse/registry.js';
import { requestHelp } from '../../browse/handover.js';
import { checkUrl } from '../../../lib/ssrf-guard.js';
import { listPublishedByProject } from '../../../lib/publish-store.js';
import { normalizeShot } from './helpers/shot-pipeline.js';
import { capture } from '../../browse/capture.js';
import { collectPage, formatPage } from '../../browse/page-digest.js';
import { recordVisit } from '../../browse/state.js';
import { formatMotionInventory } from '../../motion/inventory.js';

const NAV_TIMEOUT = _limits.NAV_TIMEOUT_MS;
const asText = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/**
 * 网络闸的拒因要按种类说话：DNS 解析失败 ≠ 策略拦截。第一版对 NXDOMAIN 也甩
 * 「内网与本机地址是硬边界」，agent 据此推出「代理有两个解析器」的错误理论 ——
 * 真因只是访问了一个已下线的旧发布域名。所以：
 *  ① dns 一档说清"域名指不到任何地方"；
 *  ② 撞的是本站发布域（slug 迁移后老域名成批死掉）就顺手把项目**现在**的
 *    线上地址查出来给它 —— 别让它拿着一个死地址继续猜。
 */
export function denyText(pre, projectId, url) {
  const lines = [];
  if (pre.kind === 'dns') {
    lines.push('这是域名解析失败（域名可能不存在、拼错或已下线），不是出网策略拦截。');
    try {
      const domain = process.env.NODESIGN_PUBLISH_DOMAIN;
      const host = new URL(url).hostname.toLowerCase();
      if (domain && (host === domain || host.endsWith(`.${domain}`))) {
        const sites = projectId ? listPublishedByProject(projectId) : [];
        lines.push(sites.length
          ? `这个地址不是本项目当前的线上地址。本项目现在的线上地址：${sites.map(s => s.url).join('、')}`
          : '这个域名形如本站的发布域，但本项目当前没有任何已发布的站点记录。');
      }
    } catch { /* 提示查不出来就只说 DNS 那一句，别把拒因本身弄丢 */ }
  } else {
    lines.push('内网与本机地址是硬边界（不是可配置项）。');
  }
  return lines;
}

/** 被闸拦掉的东西要如实报，但别把一页的几十个第三方追踪器全倒出来 */
function blockedNote(guard, since) {
  const fresh = guard.blocked.slice(since);
  if (!fresh.length) return null;
  const shown = fresh.slice(0, 4).map(b => `  ${b.url.slice(0, 90)} ← ${b.reason}`);
  return `⛔ 网络闸拦掉了 ${fresh.length} 个请求（内网/本机地址一律禁，这是硬边界，不是可配置项）：\n`
    + shown.join('\n') + (fresh.length > 4 ? `\n  …还有 ${fresh.length - 4} 个` : '');
}

/** 页面的一句话现状 —— 每个工具的返回值都带上，agent 不用再问"我现在在哪" */
async function where(page) {
  const [title, url] = await Promise.all([page.title().catch(() => ''), Promise.resolve(page.url())]);
  return `${title || '(无标题)'} — ${url}`;
}

export function makeBrowserNavigateTool({ projectId, ctx }) {
  return tool(
    'browser_navigate',
    `Open a URL in this project's persistent browser. Returns a digest of the page
it landed on: heading outline, a text excerpt, and the in-site links — so you
usually do NOT need a follow-up browser_read.

This is a REAL browser session, not a one-shot fetch: cookies, logins and
dismissed consent banners persist — across turns and across conversations for
this project. So you can go three levels into a site instead of guessing URLs.

## web_search finds sites; this one looks at them

Search snippets carry no layout, no type, no colour. The normal move is
search → open → read → CLICK DEEPER → capture. Both halves, every time you
need a visual reference.

## Go deeper than the homepage

⭐ A site's homepage is its most polished and most generic screen. What is
actually worth learning lives on the inner pages: case studies, product detail,
pricing, a single blog post, the about page. **When a site turns out to be
good, do not screenshot the front page and leave** — follow the in-site links
two or three levels in. That capability is the entire reason this tool exists
instead of screenshot_url (which is a one-shot glance). Then decide what to
browser_capture.

Only http/https. Internal and private addresses are refused by a hard network
gate — that is a security boundary, not a setting. If a site is behind a
verification wall that you cannot get past, say so plainly instead of retrying;
some walls score the server's IP and no amount of retrying changes that.

Note: one browser per project, at most ${_limits.MAX_RESIDENT} on this machine
(1 vCPU). It shuts down after ${Math.round(_limits.IDLE_MS / 60000)} minutes idle
and reopens on the next call — the profile survives, so you stay logged in.
The user has a browser card on their desktop and can watch, or take over.`,
    {
      url: z.string().min(4).describe('Absolute http(s) URL.'),
      waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional()
        .describe("How long to wait. Default 'domcontentloaded' — fastest and enough to read; measured on this machine, 'networkidle' costs an extra 1.6-4s per page, so do not reach for it by reflex. Use it only when a JS-built page comes back empty."),
      digest: z.boolean().optional()
        .describe('Include the page digest (default true). Set false only when you are navigating purely to screenshot and do not want the text.'),
    },
    async ({ url, waitUntil, digest }) => {
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          // ⭐ 先判再动，不要让浏览器为一个我们已经知道会被拒的地址离开当前页面。
          // 真跑发现的：agent 正看着 MDN，试了一次内网地址被闸拦下，**页面留在
          // chrome-error:// 上**——它原来那一页没了，后面的 read/screenshot 全对着
          // 一张错误页。闸不该让 agent 丢掉浏览上下文。
          // 这不削弱安全：CDP 闸照旧拦跳转与子资源（那些是预检看不见的）。
          const pre = await checkUrl(url);
          if (!pre.ok) {
            return asText([
              `没打开，也没离开当前页面 —— 网络闸拒了这个地址：${pre.reason}`,
              ...denyText(pre, projectId, url),
              '你还在：' + await where(page),
            ].join('\n'), true);
          }

          const since = guard.blocked.length;
          const before = page.url();
          let status = null;
          let navErr = null;
          try {
            const resp = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: waitUntil || 'domcontentloaded' });
            status = resp?.status() ?? null;
          } catch (err) {
            navErr = err.message.split('\n')[0];
          }
          const gate = blockedNote(guard, since);
          // 跳转中途被拦（预检看不到的那种）会把页面留在错误页 —— 退回原处，
          // 别让 agent 的下一次 read/screenshot 对着一张 chrome 错误页
          if (navErr && /ERR_ACCESS_DENIED|BLOCKED_BY_CLIENT/.test(navErr)) {
            // ⚠️ 按**结果**判断退没退回去，不是按 goto 有没有抛错。
            // 真跑时 goto 抛了（导航被打断）但页面其实已经回到原处，于是我给 agent
            // 报了个假警报 —— 而假警报会训练 agent 忽略警报，比不报更坏。
            if (before && /^https?:/.test(before)) {
              await page.goto(before, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
              // goto 会「抛错但导航仍在进行」—— 抛错那一刻地址栏还是错误页，
              // 等它真落到 before 上再判，否则又是一个假警报（第二次栽在同一处）
              await page.waitForURL(before, { timeout: 8000 }).catch(() => {});
            }
            const restored = (() => { try { return page.url() === before; } catch { return false; } })();
            return asText([
              '没打开 —— 这个地址在跳转中途指向了内网，被网络闸拦下。',
              gate,
              restored ? `已退回你原来那一页：${await where(page)}`
                : '⚠️ 也没能退回原来那一页，现在这个标签是空的 —— 重新 browser_navigate 一个地址。',
            ].filter(Boolean).join('\n'), true);
          }
          if (navErr) {
            // 超时 ≠ 全失败：commit 之后页面往往已有内容。半张页面也交回去 ——
            // agent 拿到骨架就能决定继续还是换站（08-19 上报：原建议「试
            // waitUntil:"load"」是往错方向推 —— load 比 domcontentloaded 严，
            // 连 DOMContentLoaded 都没到换 load 只会更慢地再失败一次）
            const timedOut = /Timeout/i.test(navErr);
            let landedUrl = null;
            try { const u = page.url(); if (timedOut && u !== before && /^https?:/.test(u)) landedUrl = u; } catch { /* */ }
            if (landedUrl) {
              let lines = [];
              try {
                const data = await collectPage(page);
                if (!data.missing) lines = formatPage(data, { compact: true });
              } catch { /* 半张页面读不出摘要也照样交回 */ }
              try { ctx?.emit?.({ type: 'run.browser_opened', url: landedUrl, ts: new Date().toISOString() }); } catch { /* */ }
              return asText([
                `⚠️ 等待超时（${navErr}），但页面已部分加载 —— 当前状态如下，够用就继续（read/screenshot 都可），不够就换站：`,
                ...lines,
                gate,
              ].filter(Boolean).join('\n'));
            }
            return asText([
              `导航失败：${navErr}`,
              timedOut
                ? '超时多半是广告/追踪脚本卡死或站点反自动化，不是"等得不够久"。别换 waitUntil:"load"（更严只会更慢地失败）；可试 waitUntil:"commit"（一有响应就接手，配 read/screenshot 看拿到多少），或者直接换一个参考站。'
                : '站点可能在挡自动化访问；换一个参考站。',
              gate,
            ].filter(Boolean).join('\n'), true);
          }
          // 让用户看得见 agent 在逛什么：低频信号走现有 EventBus，前端开/更新那扇窗。
          // 像素不走这里（那是 /ws/projects/:pid/browser 的活）。
          try { ctx?.emit?.({ type: 'run.browser_opened', url: page.url(), ts: new Date().toISOString() }); } catch { /* */ }
          await recordVisit(projectId, page);

          // 摘要跟导航同一个回合回来 —— 省掉的是一整次模型往返，见 page-digest.js
          let lines = [];
          if (digest !== false) {
            try {
              const data = await collectPage(page);
              if (!data.missing) lines = formatPage(data, { compact: true });
            } catch (err) {
              // 采不到摘要不该让"已经打开了"这件事变成失败
              lines = [`（页面摘要没取到：${err.message.split('\n')[0]} —— 用 browser_read 再试）`];
            }
          }
          return asText([
            `已打开${status ? `（HTTP ${status}）` : ''}：${await where(page)}`,
            gate,
            ...lines,
          ].filter(Boolean).join('\n'));
        });
      } catch (err) {
        return asText(`browser_navigate 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserReadTool({ projectId }) {
  return tool(
    'browser_read',
    `Read the current page in full: heading outline, text, and every link on it.

browser_navigate already gives you a short digest, so reach for this when you
want MORE than that: the whole text, one region in detail, or the full link
list.

The link list is how you go deeper without guessing URLs. Links come with their
visible text and their region tag, so you can tell a real content link from a
footer legal link — and content links are the ones worth following. A good
site's substance is on its inner pages, not its front page.

Pass a selector to read one region instead of the whole page (e.g. "main",
"article", ".pricing") when the page is long and you only need one part.`,
    {
      selector: z.string().optional().describe('Read only this element (first match). Plain CSS only.'),
      maxChars: z.number().int().min(200).max(20000).optional()
        .describe('Cap on the text returned (default 4000). Text is truncated, never silently dropped.'),
      links: z.boolean().optional().describe('Include the link list (default true).'),
    },
    async ({ selector, maxChars, links }) => {
      const cap = maxChars ?? 4000;
      const wantLinks = links !== false;
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          const since = guard.blocked.length;
          const data = await collectPage(page, { selector: selector || null, links: wantLinks });

          if (data.missing) return asText(`选择器没匹配到元素：${selector}`, true);

          return asText([
            `页面：${await where(page)}`,
            ...formatPage(data, { cap }),
            blockedNote(guard, since),
          ].filter(Boolean).join('\n'));
        });
      } catch (err) {
        return asText(`browser_read 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserClickTool({ projectId }) {
  return tool(
    'browser_click',
    `Click something on the current page and report where you ended up.

Use this instead of browser_navigate when the destination is not a plain href:
JS-driven navigation, tabs, accordions, "load more", cookie consent buttons
(dismiss those once and the profile remembers).

Prefer text= for buttons and links you can see, CSS selectors for structure.
When neither fits (canvas UIs, icon buttons, drag handles, anything you can
only point at), use browser_find to get a ref or browser_computer to click a
coordinate off a screenshot.
If a click opens a new tab, that tab is closed on purpose — the network gate
cannot be installed on it in time, and an unguarded tab is a hole. Navigate to
the URL directly instead.`,
    {
      selector: z.string().min(1)
        .describe('What to click. Either a plain CSS selector, or text= followed by visible text (e.g. text=接受全部). First match wins.'),
      waitNav: z.boolean().optional()
        .describe('Wait for a navigation to finish after clicking (default true). Set false for in-page things like opening an accordion.'),
    },
    async ({ selector, waitNav }) => {
      try {
        return await withBrowser(projectId, async ({ page, guard }) => {
          const since = guard.blocked.length;
          const before = page.url();
          const loc = page.locator(selector).first();
          if (!(await loc.count())) {
            return asText([
              `点不到：${selector} 没匹配到元素。`,
              '先用 browser_read 看页面上到底有什么文字 —— 链接文案经常跟你以为的不一样。',
              'text= 是**子串**匹配（`text=更多` 能命中「了解更多」），所以写短一点更容易命中。',
            ].join('\n'), true);
          }
          let clickErr = null;
          try {
            if (waitNav === false) await loc.click({ timeout: 8000 });
            else {
              await Promise.all([
                page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {}),
                loc.click({ timeout: 8000 }),
              ]);
              await page.waitForTimeout(300);   // 让 JS 路由把地址栏改完
            }
          } catch (err) { clickErr = err.message.split('\n')[0]; }

          const after = page.isClosed() ? '(页面被关了)' : page.url();
          if (after !== before) await recordVisit(projectId, page);   // 点击也会换页，桌面那张卡要跟上
          return asText([
            clickErr ? `点击报错：${clickErr}` : `点了 ${selector}`,
            after === before ? `地址没变（${before}）—— 可能是页内交互，或者那个元素不是链接。`
              : `${before}\n  → ${await where(page)}`,
            blockedNote(guard, since),
          ].filter(Boolean).join('\n'), !!clickErr && after === before);
        });
      } catch (err) {
        return asText(`browser_click 失败：${err.message}`, true);
      }
    },
  );
}

// browser_screenshot 08-21 搬去 browse-screenshot.js（加了胶片条 + 元素探针，行数棘轮）

export function makeBrowserRequestHelpTool({ projectId, ctx }) {
  return tool(
    'browser_request_help',
    `Ask the user to take over the browser for a moment, then wait for them.

Use it when you are stuck on something only a human can clear: a "prove you are
human" check, a login, an age gate, a consent dialog you cannot find the button
for. **Do not use it for slow pages or ordinary errors** — retry or move on.

What happens: the browser window opens on the user's canvas with your reason
shown on it, they click "我来接手", do the thing, then click "好了继续". You get
back control plus the page they left you on. If nobody answers within two
minutes you get told that, and it is then your call — usually: tell the user
plainly that this site cannot be reached from here and pick another reference.

Be honest with the user in your reason. Some walls score the server's IP and no
click will help; say that rather than making them try three times.`,
    {
      reason: z.string().min(4).max(300)
        .describe('What you need them to do, in one sentence, in the user\'s language. E.g. "这个站要过一个人机验证，帮我点一下就好".'),
    },
    async ({ reason }) => {
      try {
        const live = peek(projectId);
        if (!live) return asText('现在没有在跑的浏览器 —— 先 browser_navigate 打开一个页面再求助。', true);
        // 让前端把窗开起来 / 顶到前台 + 亮 banner（低频信号走现有 EventBus）
        ctx?.emit?.({ type: 'run.browser_help', reason, url: live.page.url(), ts: new Date().toISOString() });
        // 钉住这个实例：等人的这两分钟里它在 registry 眼里是"空闲最久"的那个，
        // 不钉就可能被 LRU 挤掉 —— 挤掉的正是人正在过验证码的浏览器
        const unhold = hold(projectId, 'human takeover');
        let r;
        try { r = await requestHelp(projectId, reason); } finally { unhold(); }
        if (!r.released) {
          return asText([
            `等了 ${Math.round(r.waitedMs / 1000)} 秒没人接手。`,
            '别在这站上继续耗 —— 跟用户说清楚"这个站从这台机器过不去"，换一个参考站。',
            '（有些墙看的是服务器 IP 的信誉，人点多少次都一样。）',
          ].join('\n'));
        }
        const nowAt = await withBrowser(projectId, async ({ page }) => where(page));
        return asText([
          `用户接手完了（等了 ${Math.round(r.waitedMs / 1000)} 秒）。`,
          `现在的页面：${nowAt}`,
          '⚠️ 页面被人动过，你之前对它的判断可能都不成立了 —— 先 browser_read 或者截一张图重新对齐，再继续。',
        ].join('\n'));
      } catch (err) {
        return asText(`browser_request_help 失败：${err.message}`, true);
      }
    },
  );
}

export function makeBrowserCaptureTool({ projectId, workspaceRoot, sessionId, ctx }) {
  return tool(
    'browser_capture',
    `Take something reusable off the page you are looking at and save it into the
workspace, so it survives this conversation.

The point is NOT just a screenshot. What is actually reusable from a reference
site is usually the parts you can turn straight into code:

- palette   the colours WITH their roles (page background, body text, link,
            button) read off computed styles — the author's choices, not a
            quantised bitmap full of nameless near-duplicates
- fonts     family + the sizes/weights/line-heights actually in use (a family
            name alone is not enough to copy a type system)
- css       every rule that matched one element you name, in cascade order —
            you can read it and re-derive the technique. Needs "selector".
- skeleton  three counts: how many sections, how many DISTINCT section shapes,
            how many interaction points. ⚠️ heuristic — use it as a comparison
            against the site you are building, not as fact. This is the same
            three numbers site-craft asks you to count when the user says a page
            is boring; having them for a reference site turns "it feels thin"
            into "theirs has 6 shapes, yours has 1".
- screenshot the picture, for the things numbers cannot carry
- motion    ⭐ WHAT the site uses to move: every stylesheet (cross-origin CDN
            ones too, via CDP) scanned for @keyframes / animation / transition /
            CSS scroll-driven animation (animation-timeline, scroll(), view()) /
            scroll-snap / sticky / reduced-motion; the browser's own running
            animations (getAnimations: durations, easings, keyframes); motion
            libraries (GSAP + every ScrollTrigger's start/end/scrub/pin, Lenis,
            Locomotive, AOS, Swiper, three.js, framer-motion…); and a REAL wheel
            scroll through the page that tells apart reveal-on-scroll elements
            (with their transition), scrub/parallax elements, and scroll
            hijacking. This is how you learn HOW an effect is built. ⚠ it scrolls
            the page (restores to top); canvas/WebGL motion is invisible to it —
            for the look and feel of motion use browser_screenshot frames.

Everything lands in assets/references/web/ with a provenance sidecar (source
URL, when, what you were looking for). It is there in the NEXT conversation too
— that is the whole reason it goes to disk instead of just into your context.

Write "lookingFor" honestly: in three days a folder of screenshots with no note
about why they were taken is landfill.`,
    {
      kinds: z.array(z.enum(['screenshot', 'palette', 'fonts', 'css', 'skeleton', 'motion'])).min(1)
        .describe('What to take. Cheap ones (palette/fonts/skeleton) can all go in one call; motion takes a few seconds (it scrolls the page).'),
      lookingFor: z.string().min(4).max(200)
        .describe('Why you are taking this, in one line — e.g. "刊物式开场的版面节奏与配色".'),
      name: z.string().max(48).optional()
        .describe('Filename stem. Defaults to the host plus a timestamp.'),
      selector: z.string().optional()
        .describe('Required for "css"; also narrows "screenshot" to one component.'),
    },
    async ({ kinds, lookingFor, name, selector }) => {
      try {
        if (kinds.includes('css') && !selector) {
          return asText('css 那一种要指一块：加上 selector（用 browser_read 先看页面上有什么）。', true);
        }
        return await withBrowser(projectId, async ({ page }) => {
          const r = await capture({
            page, workspaceRoot, kinds, name, lookingFor, selector,
            ids: { sessionId, runId: ctx?.runId ?? null },
            normalize: normalizeShot,
          });
          for (const f of r.files) {
            try { ctx?.emit?.({ type: 'run.file_changed', filePath: f.rel, event: 'add' }); } catch { /* */ }
          }
          const lines = [`从 ${r.data.title || r.data.url} 采下来了：`];
          for (const f of r.files) lines.push(`  ${f.rel}（${(f.bytes / 1024).toFixed(0)} KB，${f.kind}）`);
          if (r.data.palette?.length) {
            lines.push('', '调色板：' + r.data.palette.slice(0, 8)
              .map(c => `${c.role}=${c.value}`).join('  '));
          }
          if (r.data.fonts?.length) {
            lines.push('字体：' + r.data.fonts.map(f => `${f.role}=${f.family.split(',')[0]} ${f.size}/${f.weight}`).join('  ·  '));
          }
          if (r.data.skeleton) {
            const sk = r.data.skeleton;
            if (!sk.sectionCount) {
              // 数不出来就说数不出来。报一个 0 会让 agent 以为"这站真的没有结构"
              lines.push('', '结构：这一页量不出横带（可能整页是一张大图、或者内容靠 JS '
                + '后填 —— 试 browser_navigate 带 waitUntil:"networkidle" 再采一次）。');
            } else {
              lines.push('', `结构（⚠️ 启发式，当对照不当真相）：${sk.sectionCount} 节 · `
                + `**${sk.shapeKinds} 种节的形状** · ${sk.interactivePoints} 个交互点`);
              lines.push('  拿它跟你正在做的那个站比 —— 形状种类差得多，就是"薄"的量化形态。');
              lines.push('  （跨站比看数量级：各家标记方式不同，个位数差别别当结论。'
                + '同一页改前改后比最准。）');
            }
          }
          if (r.data.css) lines.push('', `CSS：${r.data.css.length} 条命中规则已写进 json`);
          if (r.data.motion) {
            lines.push('', '动效清单（这站靠什么在动）：', ...formatMotionInventory(r.data.motion).map(l => `  ${l}`));
            lines.push('  → 动起来的样子：browser_screenshot frames/scrollBy');
          }
          if (r.failed?.length) {
            lines.push('', `⚠️ 有 ${r.failed.length} 种没采到（其余的已经落盘了）：`,
              ...r.failed.map(f => `  ${f}`));
          }
          return asText(lines.join('\n'));
        });
      } catch (err) {
        return asText(`browser_capture 失败：${err.message}`, true);
      }
    },
  );
}
