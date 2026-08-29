/**
 * assets/helpers.js — assets 这一族路由共用的小纯函数。
 *
 * 为什么单独一个文件：2026-08-17 把便签路由拆出去时，这两个函数一个被落下、
 * 一个被误带走 —— `node --check` 不报、vite build 不报、单测也不报，只有
 * `no-undef.lint` 抓到了。给它们一个**双方都 import 的家**，这一类事故就
 * 不会再随下一次拆分复发（谁也不用记得"这个函数该跟着谁走"）。
 */

import { promises as fs } from 'node:fs';
import { parseChalk } from '../../lib/chalk.js';
import { jsonPreview } from '../../lib/json-preview.js';

/** 单层路径片段：不含分隔符、不含 `..`、不以点开头、长度可控 */
export function safeSegment(s) {
  return typeof s === 'string' && !!s && s.length <= 200
    && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.startsWith('.');
}

/**
 * 便签/板书正文上卡（2026-08-23 从 assets.js 抽出）：frontmatter 带 nd: chalk 的是板书
 * （agent/用户写在画布上的话，同一形态另一张脸），其余按便签头解析；正文 ≤4KB 截断。
 * 读不到就静默（agent 正在写的文件可能半途消失）。
 */
export async function decorateNoteText(item, absPath) {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    const parsed = parseChalk(raw);
    const { body, sessionId } = parsed.chalk ? parsed : parseNoteFrontmatter(raw);
    item.text = body.length > 4096 ? body.slice(0, 4096) + '…' : body;
    if (sessionId) item.sessionId = sessionId;
    if (parsed.chalk) item.chalk = parsed.chalk;
  } catch { /* */ }
  return item;
}

/** 便签 frontmatter：只认最简单的 `---\nsession: xxx\n---` 头，其余原样当正文 */
export function parseNoteFrontmatter(raw) {
  const m = /^---\n([\s\S]{0,500}?)\n---\n?/.exec(raw);
  if (!m) return { body: raw, sessionId: null };
  const sm = /(?:^|\n)session:\s*([A-Za-z0-9-]{8,64})\s*(?:\n|$)/.exec(m[1]);
  return { body: raw.slice(m[0].length).replace(/^\n+/, ''), sessionId: sm ? sm[1] : null };
}

/** 能上预览的文本类文件（08-24：md/json 等文件卡从细条升级成带内容预览的卡） */
export const PREVIEW_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml']);

/**
 * 文本文件预览上卡（08-24）：截前 1KB 进 `preview` 字段（不是 `text` —— 那是
 * 便签卡的正文真相，复用会把 NoteFaces 的分面语义漏到文件卡上）。frontmatter
 * 头藏掉（记忆/ 主题文件的 SDK 头对预览是噪音）。完整内容走 artifact-file。
 */
export async function decorateFilePreview(item, absPath) {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    const head = /^---\n[\s\S]{0,1200}?\n---\n?/.exec(raw)?.[0] || '';
    const body = raw.slice(head.length).trimStart();
    // json 走结构裁剪（08-29 刀 B）：产出仍是合法 json，前端才画得出折叠树。
    // 硬截断的 json parse 不动，卡面上只能是半行 `{"name":"…`。
    if (/\.json$/i.test(absPath)) {
      const shrunk = jsonPreview(body);
      if (shrunk !== null) { item.preview = shrunk; item.previewKind = 'json'; return item; }
      // 不是合法 json（写了一半 / 带注释）：退回原样，别假装看得懂
    }
    item.preview = body.length > 1024 ? body.slice(0, 1024) + '…' : body;
  } catch { /* 读不到就没有预览，卡退回细条 */ }
  return item;
}
