#!/usr/bin/env node
/**
 * 更新日志单一来源（2026-09-11）：仓库根的 CHANGELOG.md → 官网 changelog.html 的日志区。
 *
 * 为什么不在部署时生成：部署跑在生产检出上，改源文件会把检出弄脏。改成「写 CHANGELOG.md 后在本地跑一次」，
 * 再由 changelog-page.test.js 钉住两边一致 —— 只改了 changelog.html 没改 CHANGELOG.md（或反过来）测试就红。
 *
 * CHANGELOG.md 形状：`## 日期 · 版本`（版本可省）→ 可选 `### 小标题` → `- 要点`；要点里 `反引号` 渲染成 <code>。
 *
 * 用法：node web/scripts/changelog-page.mjs          写入
 *       node web/scripts/changelog-page.mjs --check  只比对，不一致退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MD = path.resolve(HERE, '../../CHANGELOG.md');
export const PAGE = path.resolve(HERE, '../public/welcome/changelog.html');
const BEGIN = /<!-- changelog:begin[^>]*-->/, END = '<!-- changelog:end -->';

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');

export function parse(md) {
  const entries = []; let cur = null;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^## (.+)$/.exec(line))) {
      const [date, ...ver] = m[1].split(' · ');
      cur = { date: date.trim(), ver: ver.join(' · ').trim(), title: '', items: [] }; entries.push(cur);
    } else if (cur && (m = /^### (.+)$/.exec(line))) cur.title = m[1].trim();
    else if (cur && (m = /^- (.+)$/.exec(line))) cur.items.push(m[1].trim());
  }
  return entries;
}

export function render(entries) {
  return entries.map((e) => `
      <article class="log-item reveal">
        <div class="log-date">${esc(e.date)}${e.ver ? `<span class="log-ver">${esc(e.ver)}</span>` : ''}</div>
        <div class="log-body">${e.title ? `
          <h3>${inline(e.title)}</h3>` : ''}
          <ul>
${e.items.map((i) => `            <li>${inline(i)}</li>`).join('\n')}
          </ul>
        </div>
      </article>
`).join('');
}

export function splice(page, body) {
  const b = BEGIN.exec(page); const e = page.indexOf(END);
  if (!b || e < 0) throw new Error('changelog.html 里找不到 changelog:begin / changelog:end 标记');
  const head = page.slice(0, b.index + b[0].length);
  return `${head}${body}      ${page.slice(e)}`;
}

export function build() {
  return splice(fs.readFileSync(PAGE, 'utf8'), render(parse(fs.readFileSync(MD, 'utf8'))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = build(); const cur = fs.readFileSync(PAGE, 'utf8');
  if (process.argv.includes('--check')) {
    if (next !== cur) { console.error('changelog.html 与 CHANGELOG.md 不一致：跑一次 node web/scripts/changelog-page.mjs'); process.exit(1); }
    console.log('changelog: 一致');
  } else if (next !== cur) { fs.writeFileSync(PAGE, next); console.log(`changelog: 已写入 ${parse(fs.readFileSync(MD, 'utf8')).length} 条`); }
  else console.log('changelog: 无变化');
}
