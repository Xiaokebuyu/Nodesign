/**
 * hooks/site-validate.js — 站点页面的两条硬规则 lint（2026-08-21）
 *
 * 起手模板（site.template.html / style.template.css）08-21 删了：它把"别把预览弄坏"
 * 的硬规则和"站长什么样"的默认审美捆在一个文件里，后者同化了一半的成品（11/28 个
 * 站保留着模板骨架）。硬规则不能靠"注释写在模板顶上、agent 记得 Read"传播 ——
 * 契约要配 lint。这里就是那两条：
 *
 *   1. `<meta name="viewport">` 缺失 → 手机端按 980px 虚拟视口渲染，媒体查询
 *      看着"没生效"
 *   2. 根路径 `href="/x"` / `src="/x"` → 预览走 `/api/projects/<id>/artifact-file/…`
 *      前缀，根路径跳出前缀直接 404（发布到独立域名后反而正常，所以本地更容易漏）
 *
 * 实测（08-21，27 个站）两条违反都是 0 —— 模型本来就守。lint 的意义是把"本来就守"
 * 变成"守不守都查得到"，弱模型/长会话漂移时兜底。只报不改，跟 canvas-validate 同款。
 *
 * 只看**子目录里的 .html**（站点住自己的文件夹）；工作区根上的 .html 是 deck，
 * 不归这里（deck 有自己的 canvas-validate）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

const strip = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '');

/**
 * 纯函数：html 文本 → 问题列表（空数组 = 干净）。
 * @returns {Array<{title:string, detail:string}>}
 */
export function lintSiteHtml(html) {
  const src = strip(html);
  const issues = [];
  if (!/<meta\s[^>]*name\s*=\s*["']viewport["']/i.test(src)) {
    issues.push({
      title: '缺 <meta name="viewport">',
      detail: '没有它手机端按 980px 虚拟视口渲染，媒体查询看着"没生效"。加 <meta name="viewport" content="width=device-width, initial-scale=1">。',
    });
  }
  // 根路径：href="/x" 或 src="/x"，排除协议相对 "//cdn…"；"/" 单独一个也算（回首页应写 index.html）
  const roots = [...src.matchAll(/\b(?:href|src|action)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)].map(m => m[1]);
  if (roots.length) {
    const uniq = [...new Set(roots)].slice(0, 5);
    issues.push({
      title: `根路径链接 ${roots.length} 处（${uniq.join(' ')}${roots.length > uniq.length ? ' …' : ''}）`,
      detail: '预览和导出都走 artifact-file/<路径> 前缀，根路径会跳出前缀直接 404。站内一律相对路径：about.html / assets/x.png / ../assets/generated/x.png。',
    });
  }
  return issues;
}

/** 相对工作区的 .html，且在子目录里（站点页）—— deck 在根上，不归这里 */
export function isSitePagePath(workspaceRoot, fp) {
  if (!fp || !/\.html?$/i.test(fp)) return false;
  const rel = path.relative(workspaceRoot, path.resolve(workspaceRoot, fp)).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || !rel.includes('/')) return false;
  // _drafts/ 里的试作也按站点页 lint：site-craft 方法论第一步就写它，嗅探器也把它当站点注入技术参考（09-07 C1）
  if (/^(exports|node_modules|\.)/.test(rel)) return false;   // _drafts/ 里的试作也按站点页 lint（09-07 C1：方法论第一步就写它）
  return true;
}

export function makePostToolUseSiteValidationHandler({ workspaceRoot }) {
  return async (input) => {
    try {
      const fp = input?.tool_input?.file_path;
      if (!workspaceRoot || !isSitePagePath(workspaceRoot, fp)) return {};
      const abs = path.resolve(workspaceRoot, fp);
      let html;
      try {
        const st = await fs.stat(abs);
        if (st.size > MAX_BYTES) return {};
        html = await fs.readFile(abs, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
      }
      if (html.includes('__nd-deck-wrap')) return {};   // 收进文件夹的 deck，不是站点页
      const issues = lintSiteHtml(html);
      if (!issues.length) return {};
      const body = issues.map((i, idx) => `${idx + 1}. ${i.title}\n   ${i.detail}`).join('\n\n');
      return {
        systemMessage:
          `<system-reminder>\n[site-validate] 你刚改完 ${fp}，系统检测到 ${issues.length} 项会让预览出错的硬规则违反：\n\n`
          + body
          + '\n\n有意为之就忽略；否则下一轮先修这几处再继续。\n</system-reminder>',
      };
    } catch (err) {
      console.warn('[hooks/site-validate] threw:', err.message);
      return {};
    }
  };
}
