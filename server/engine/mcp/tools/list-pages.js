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
import { openArtifactPage, launchPerceptionBrowser, degradedNote } from './helpers/perception-page.js';
import { gatedBrowser } from './helpers/browser-slots.js';
import { resolveDeckSize, extractDeckAspect } from '../../../shared/deck.js';
import {
  resolveCanvasTarget, CANVAS_PATH_DESC, KIND_SITE, taskManifest, requireBrowsable,
} from '../../../lib/artifact-target.js';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeListPagesTool({ workspaceRoot, projectId, sessionId, ctx: _ctx }) {
  return tool(
    'list_pages',
    `List the pages of the current artifact.

DECK — one entry per <section data-page="N">: { index, layout, anchor, title, bbox }.
SITE — one entry per html file in the task folder: { file, title, headings, links, bytes },
plus a broken internal-link report.
The tool figures out which kind it is; you do not pass it.

Use when:
- You want a quick overview before deciding what to change
- You need the page count (deck) or the site map (site)
- Verifying structure after a restructure

Lighter than read_page (which returns full outerHTML of one page).`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
    },
    async ({ path: relPath }) => {
      if (!workspaceRoot) {
        return {
          content: [{ type: 'text', text: 'No workspace bound; cannot list pages.' }],
          isError: true,
        };
      }
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
      const notBrowsable = requireBrowsable(target);
      if (notBrowsable) return { content: [{ type: 'text', text: notBrowsable }], isError: true };

      // 站点：「页」是独立文件，不是同一份文档里的 section。硬按 deck 那套扫
      // `section[data-page]` 会 0 命中，然后回一句"这份画布没有页面"—— 一个内容
      // 完整的站点会被 agent 读成空文件，这正是要避免的静默失败。
      if (target.kind === KIND_SITE && target.taskDir) {
        return listSiteStructure(target);
      }

      const canvasPath = target.absPath;
      let html;
      try {
        html = await fs.readFile(canvasPath, 'utf8');
      } catch {
        return { content: [{ type: 'text', text: `${target.relPath} not found in workspace.` }], isError: true };
      }
      const dims = resolveDeckSize(extractDeckAspect(html));

      let browser;
      try {
        browser = await gatedBrowser(() => launchPerceptionBrowser(), { key: projectId });
        // 走 http（与用户预览同源），不再 file://；理由见 helpers/perception-page.js
        const opened = await openArtifactPage(browser, {
          projectId, workspaceRoot, absPath: canvasPath,
          viewport: { width: dims.width, height: dims.height },
        });
        const page = opened.page;
        await opened.goto();

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
              text: `${target.relPath} has no <section data-page="N"> elements.`,
            }],
          };
        }

        // thumbnail 与真实 src 的差别 08-21 起只在 generate-image cookbook 里说一次，不再每次 list_pages 都带
        const thumbnailHint = '';

        const degraded = degradedNote(opened);   // 契约：note 非空必须写进返回文本
        return {
          content: [{
            type: 'text',
            text: `${degraded ? `${degraded}\n\n` : ''}${thumbnailHint}${pages.length} page(s):`
              + `\n\n${JSON.stringify(pages, null, 2)}`,
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

/**
 * 站点结构：产物根里每个 html 一条，带标题 / 小标题 / 站内外链接 / 体积。
 *
 * 纯文本解析，不开 playwright —— 站点是多文件，逐个起浏览器既慢又没必要；
 * agent 要的是"这站有哪些页、彼此怎么连"，那是源码里就有的信息。
 * 顺带查断链：站内链接指到不存在的文件是站点最常见、也最容易漏的错。
 *
 * 扫的是**产物根**（构建型站点 = dist/ 之类）：预览和发布看的是它，源目录的
 * md / 模板在这里没有意义。`_drafts/` 的试作不算站点页面，单独提一句。
 */
async function listSiteStructure(target) {
  const manifest = await taskManifest(target.taskDir);
  // 多产物平权：报的是**这个站点实例**的结构（resolve 已判好路径属于哪个产物）
  const art = target.artifact
    || manifest?.artifacts?.find(a => a.kind === 'site' && !a.single)
    || null;
  const pages = art?.pages || [];
  const baseDir = target.artifactDir || target.taskDir;
  if (pages.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `这个站点（${art?.root ? `产物根 ${art.root}/` : '任务根'}）还没有 html 页面。`
          + (art?.root ? '（源写完了的话，先跑构建让产物落进去；构建后确认产物真的落在这个目录。）' : ''),
      }],
    };
  }
  const out = [];
  for (const rel of pages) {
    let raw = '';
    try { raw = await fs.readFile(path.join(baseDir, rel), 'utf8'); } catch { continue; }
    const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const headings = [...raw.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .map(m => m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 8);
    const links = [...new Set([...raw.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
      .map(m => (m[1] || m[2]).trim())
      .filter(Boolean))];
    const internal = links.filter(h => !/^(?:[a-z][a-z0-9+\-.]*:|\/\/|#)/i.test(h));
    const stylesheets = [...new Set(
      [...raw.matchAll(/<link\b[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
        .filter(m => /stylesheet/i.test(m[0]))
        .map(m => m[1] || m[2]),
    )];
    out.push({
      file: rel,
      title: titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 100) : null,
      headings,
      internalLinks: internal,
      externalLinkCount: links.length - internal.length,
      stylesheets,
      bytes: Buffer.byteLength(raw),
    });
  }

  // 输出统一成**工作区相对**路径：screenshot_canvas / artifact_open 收的就是这种。
  // 以前 file 是产物根相对（index.html），agent 原样回喂必然 not found（08-24 案）
  const prefix = art?.root ? `${art.root}/` : '';
  const known = new Set(pages);
  const broken = [];
  for (const p of out) {
    for (const href of p.internalLinks) {
      const clean = href.split('#')[0].split('?')[0];
      if (!clean || !/\.html?$/i.test(clean)) continue;
      const dir = p.file.includes('/') ? p.file.slice(0, p.file.lastIndexOf('/') + 1) : '';
      const stack = [];
      for (const seg of (dir + clean).split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') stack.pop();
        else stack.push(seg);
      }
      if (!known.has(stack.join('/'))) broken.push(`${prefix}${p.file} → ${href}`);
    }
  }
  const brokenNote = broken.length
    ? `\n\n⚠️ 站内链接指向不存在的页面（${broken.length} 条）：\n${broken.map(b => `- ${b}`).join('\n')}`
    : '';
  const rootNote = art?.root ? `（产物根 ${art.root}/，改源后要重新构建）` : '';
  // 任务里的其他平等产物（别的站 / deck / 单页）提一句，agent 知道全貌
  const siblings = (manifest?.artifacts || []).filter(a => a.entryRel !== art?.entryRel);
  const siblingNote = siblings.length
    ? `\n\n同任务的其他产物（平等，各自寻址）：${siblings.map(a => a.entryRel).join(' / ')}`
    : '';

  const outWs = prefix ? out.map(p => ({ ...p, file: prefix + p.file })) : out;

  return {
    content: [{
      type: 'text',
      text: `站点${art?.title ? ` ${art.title}` : ''} · ${out.length} 个页面（入口 ${prefix}${pages[0]}）${rootNote}`
        + '，file 是工作区相对路径，可直接传给 screenshot_canvas / artifact_open：\n\n'
        + `${JSON.stringify(outWs, null, 2)}${brokenNote}${siblingNote}`,
    }],
  };
}
