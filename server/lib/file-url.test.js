/**
 * file-url 单测 + 全仓看门狗（2026-09-08，站主在 Windows 上撞到 LibreOffice「bootstrap.ini 已经损坏」之后）。
 *
 * 病根不是难写的东西，是**在 Linux 上恰好对**：`'file://' + 绝对路径` 在这台机器上永远拼出合法的
 * `file:///…`，测试全绿、生产全绿，只有 Windows 用户会看到一句指不到根因的报错。这种「平台一换就错、
 * 本机永远测不出」的写法只能靠 grep 拦，所以除了单测再加一条扫全仓的断言。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileUrl } from './file-url.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('fileUrl', () => {
  it('绝对路径 → 三斜杠的 file URL，能原样转回去', () => {
    const p = path.resolve('/tmp/nd-file-url/loprofile');
    const href = fileUrl(p);
    expect(href.startsWith('file:///')).toBe(true);
    expect(fileURLToPath(href)).toBe(p);
  });

  it('非 ASCII 和空格 percent 编码（Windows 的 C:\\Users\\笑不语 就是这一类）', () => {
    const href = fileUrl(path.resolve('/tmp/笑 不语/in.docx'));
    expect(href).not.toMatch(/[^\x20-\x7e]/);   // eslint-disable-line no-control-regex
    expect(href).toContain('%20');
    expect(fileURLToPath(href)).toContain('笑 不语');
  });

  it('跟 pathToFileURL 是同一件事（换实现别换语义）', () => {
    const p = path.resolve('/tmp/a b/c');
    expect(fileUrl(p)).toBe(pathToFileURL(p).href);
  });
});

/** 只看代码行：整行注释和块注释里的例子不算（file-url.js 自己的文档就在讲这个反面教材） */
function codeLines(text) {
  return text.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lab') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('全仓：别再拼 file:// 字符串', () => {
  it('server/ 下没有 `\'file://\' + 路径` 或 `file://${…}`（Windows 上会拼成主机名 C:）', () => {
    const bad = [];
    for (const file of walk(SERVER_ROOT)) {
      if (file.endsWith(path.join('lib', 'file-url.js')) || file === fileURLToPath(import.meta.url)) continue;
      for (const line of codeLines(fs.readFileSync(file, 'utf8'))) {
        if (/['"`]file:\/\/['"`]\s*\+/.test(line) || /file:\/\/\$\{/.test(line)) {
          bad.push(`${path.relative(SERVER_ROOT, file)}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(bad, `用 lib/file-url.js 的 fileUrl()：\n${bad.join('\n')}`).toEqual([]);
  });
});
