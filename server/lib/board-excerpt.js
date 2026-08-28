/**
 * lib/board-excerpt.js —— 板书的一句话预览（首页卡片用）
 *
 * 为什么单开一个而不是并进封面管线（lib/cover.js）：**板书不是产物**。
 * 封面管线的输入是 taskManifest 里的 artifacts（deck / site / docx …），
 * 拿 chromium 截一张印样贴到卡上。板书是写在画布上的字，没有入口文件、
 * 没有画幅，截图这条路对它没有意义 —— 结果就是整个演出项目的卡常年一片空白
 * 加一行"还没出东西"，而里面躺着一整个故事。
 *
 * 它该有的样子不是"贴一张印样"，是**这张纸上写着什么**：把最近一条板书的开头
 * 直接写在卡的空白纸上。所以这里只出文本，不出图。
 *
 * 便宜是硬要求：首页 /projects/stats 一次要过一遍所有项目。所以
 *   - 按**文件名**倒序（板书文件名以 YYYYMMDD-HHMMSS 打头），不 stat 每个文件
 *   - 只读最新那一个文件的前几 KB
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/** 板书本体的落点（跟 write-on-board 里那份一致） */
export const CHALK_DIR = path.join('notes', '板书');

/** 读文件只取头一截：一条板书可能很长，预览只要开头几行 */
const HEAD_BYTES = 4096;

/**
 * 去掉 frontmatter 和几个行首记号，压成能直接写在卡上的几行。
 * 不做完整 markdown 渲染 —— 卡上那几行是"笔迹"，不是排版好的正文。
 */
export function excerptOf(raw, max) {
  const body = String(raw || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    // ⛔ 围栏块整段扔掉。板书里最常见的围栏是 ```nd:controls（画布上那排控件的
    // 声明）—— 它在卡上会变成一坨源码，而它根本不是这段故事的字。
    // 后半个 |``` 收尾未闭合的围栏：宁可少几行，也不能把源码倒到卡上。
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$|^[ \t]*```[\s\S]*$/gm, '');
  const lines = body.split(/\r?\n/)
    // 行首：标题 / 引用 / 列表点 / 任务框，都是排版记号不是字
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+)/, '').replace(/^\s*\[[ xX]\]\s*/, ''))
    // 行内：强调和行内码只留字。卡上那几行是笔迹，星号和反引号原样显示就是噪音
    .map((l) => l.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  let out = '';
  for (const l of lines) {
    if (out.length + l.length > max && out) break;
    out += (out ? '\n' : '') + l;
    if (out.length >= max) break;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * @returns {Promise<null | { count: number, text: string }>} 没有板书就 null
 */
export async function chalkPreview(sharedDir, { max = 150 } = {}) {
  const dir = path.join(sharedDir, CHALK_DIR);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
  } catch { return null; }          // 没这个目录 = 这个项目没写过板书
  if (!names.length) return null;
  // 文件名带时间戳前缀，按名倒序就是按时间倒序（省掉 N 次 stat）
  names.sort().reverse();
  let raw = '';
  try {
    const fh = await fs.open(path.join(dir, names[0]), 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      // ⚠️ 按字节截会把最后一个多字节字符劈成两半，转字符串时变成替换字符。
      // 预览允许丢尾巴，但不允许出现乱码 —— 所以砍掉可能不完整的那一个。
      raw = buf.subarray(0, bytesRead).toString('utf8').replace(/�+$/, '');
    } finally { await fh.close(); }
  } catch { return null; }
  const text = excerptOf(raw, max);
  return text ? { count: names.length, text } : null;
}
