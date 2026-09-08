/**
 * screenshot-docx.js — screenshot 工具的 docx 分支。
 *
 * 为什么单独一个模块：docx 跟 deck / site 走的是**两条完全不同的管线**
 * （LibreOffice → PDF → PNG vs playwright），共享的只有「返回一张图 + 一句
 * caption」这个出口形状。塞进 screenshot.js 会变成一个大 if 横在中间。
 *
 * agent 那边**动词不变**：还是 screenshot。形态注册表的 `renderable` 能力位
 * 负责分流，工具签名和使用习惯零变化 —— 「做完看一眼」这条纪律是跨形态的，
 * 不该因为产物换了种类就让 agent 重新学一个工具名。
 *
 * ⚠️ 这只眼睛有两处**已知失真**，caption 里必须说出来，不能让 agent 拿它当
 * 终审（写进 SKILL 的同一套话）：
 *   1. 中文字体是替身（服务器没有宋体/黑体/仿宋，用 Noto / LXGW 代显）——
 *      断行一致但**行高不一致**（multiple 行距乘字体自带行高，替身≈1.24 vs
 *      真雅黑≈1.32 / 苹方≈1.4），multiple 行距下页数不可照图判
 *   2. **TOC 域**显示的是缓存占位文案，不是真目录（Word 打开更新域才生成）。
 *      ⚠️ 别把这条写成「域都不更新」—— 实测 PAGE 域 LO 是**正常求值**的，
 *      页脚页码看到几就是几。假警报会训练 agent 忽略警报。
 */

import fs from 'node:fs/promises';
import { checkCjkFonts } from '../../../lib/cjk-fonts.js';
import { execFileSync } from 'node:child_process';
import { renderDocx, cleanupRender } from '../../../lib/docx/render.js';
import { normalizeShot } from './helpers/shot-pipeline.js';

/** 一次最多回几页 —— 40 页文档全渲回来是上下文炸弹 */
const MAX_PAGES = 6;
/** 不指定范围时默认看几页 */
const DEFAULT_PAGES = 2;

const DPI = { normal: 100, high: 150 };

/** PDF 总页数。拿不到就返回 null，不为了一个数字让整次截图失败 */
function pdfPageCount(pdfPath) {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8', timeout: 15000 });
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/**
 * 解析页码范围。`pages` 收 "3"、"2-5"、"all" 三种写法。
 * @returns {{from:number, to:number, explicit:boolean}}
 */
export function parsePageRange(pages) {
  if (!pages) return { from: 1, to: DEFAULT_PAGES, explicit: false };
  const s = String(pages).trim();
  if (/^all$/i.test(s)) return { from: 1, to: MAX_PAGES, explicit: true };
  const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const from = Math.max(1, Number(range[1]));
    return { from, to: Math.max(from, Math.min(Number(range[2]), from + MAX_PAGES - 1)), explicit: true };
  }
  const one = s.match(/^(\d+)$/);
  if (one) { const n = Math.max(1, Number(one[1])); return { from: n, to: n, explicit: true }; }
  return { from: 1, to: DEFAULT_PAGES, explicit: false };
}

/**
 * @param {{absPath:string, relPath:string}} target  已解析的产物目标
 * @param {{pages?:string, detail?:'normal'|'high'}} opts
 * @returns {Promise<{content:Array, isError?:boolean}>}  MCP 工具返回体
 */
export async function screenshotDocx(target, opts = {}) {
  try {
    await fs.access(target.absPath);
  } catch {
    return {
      content: [{ type: 'text', text: `${target.relPath} 还没构建出来。先写 token 源再 build，或者确认文件名。` }],
      isError: true,
    };
  }

  const { from, to, explicit } = parsePageRange(opts.pages);
  const dpi = DPI[opts.detail === 'high' ? 'high' : 'normal'];

  let res;
  try {
    // pdftoppm 的 -l 超过实际页数会自动截断，所以这里不用先问总页数
    res = await renderDocx(target.absPath, { pngPages: [from, to], dpi });
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `渲染失败：${String(err.message || err).slice(0, 400)}\n`
          + '这是渲染链路的问题不是文档的问题，别靠猜改文档 —— 先看 soffice 在不在、文件是不是完整的 docx。',
      }],
      isError: true,
    };
  }

  try {
    const total = pdfPageCount(res.pdf);
    if (!res.pngs.length) {
      return {
        content: [{ type: 'text', text: `${target.relPath} 渲染出来是空的（共 ${total ?? '?'} 页，请求 ${from}-${to}）。` }],
        isError: true,
      };
    }

    const shown = `${from}${res.pngs.length > 1 ? `-${from + res.pngs.length - 1}` : ''}`;
    const caption = [
      `${target.relPath} · 第 ${shown} 页${total ? ` / 共 ${total} 页` : ''} · ${dpi}dpi · ${res.ms}ms`,
    ];
    // 没看完就说没看完 —— 静默只给前两页，agent 会以为自己看过全文
    if (total && from + res.pngs.length - 1 < total) {
      caption.push(`⚠️ 还有 ${total - (from + res.pngs.length - 1)} 页没看：pages:"3-6" 指定范围，一次最多 ${MAX_PAGES} 页。`);
    }
    if (!explicit && total && total > DEFAULT_PAGES) {
      caption.push('（没传 pages 时默认只渲前两页）');
    }
    // 字体那条按平台说实话（09-08）：Windows 上 LibreOffice 用的是本机真字体，五件齐全时字形可判；缺的那几件才是替身
    const fonts = checkCjkFonts();
    const fontNote = !fonts.checked
      ? '① 中文是**替身字体**（雅黑/等线→MiSans、仿宋→朱雀仿宋、宋体→Noto Serif、楷体→LXGW），字形跟用户 Word 里仍有差；'
        + 'CJK 全角等宽所以**断行位置**一致，但行高只有雅黑档对齐了（MiSans 1.326 ≈ 真雅黑 1.32）—— 宋体等其它档、'
        + '以及 Mac 上替到苹方（≈1.4）的行高仍不同（2026-08-19 真 Word 实证：2 页简历在 Word 里变过 4 页）；'
      : fonts.missing.length
        ? `① 本机是 Windows，页图用的是本机字体，但缺 ${fonts.missing.join(' / ')}（用兜底字体替，只这几处字形不可判、行高可能有差）；`
        : '① 本机是 Windows，宋体 / 黑体 / 楷体 / 仿宋 / 雅黑 五件齐全，页图用的是真字体，**字形可以照图判**；';
    caption.push(
      '已知失真：' + fontNote
      + '② **TOC 域**这里显示的是占位文案不是真目录（Word 打开更新域才生成）——'
      + '页码域是正常的，看到几就是几。'
      + '版式、间距、缩进、层级可以照这张图判；目录内容不能，'
      + (fonts.checked && !fonts.missing.length ? '' : '字形观感不能，')
      + '**multiple 行距下的页数和分页位置也不能**（排满的页真 Word 会多出页；'
      + '页数敏感的文档行距用 exact/atLeast 磅值，两边就一样高了）。',
    );

    // 跟全站眼睛同口径（08-21）：过 normalizeShot → 视觉档尺寸 + webp q82。视觉模型按像素
    // 网格计 token，PNG 原图多出来的字节它看不见；公文页 PNG 260KB → webp 97KB，放大
    // 对比字形无差。少的是传给上游的字节和 CLI 按字符估算的假仪表，真 token 账不变。
    const images = await Promise.all(res.pngs.map(async (p) => {
      const n = await normalizeShot(await fs.readFile(p));
      return { type: 'image', data: n.data, mimeType: n.mimeType };
    }));

    return { content: [{ type: 'text', text: caption.join('\n') }, ...images] };
  } finally {
    await cleanupRender(res);
  }
}
