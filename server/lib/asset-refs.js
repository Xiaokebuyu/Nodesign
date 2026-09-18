/**
 * lib/asset-refs.js — 产物真正引用到了哪些素材（2026-08-17）
 *
 * 为什么要这个：旧的工程交付包把**整个** `shared/assets` 递归塞进 zip。那是
 * **项目级**共享目录，不是这份产物引用的东西 —— 生产上最大的一个项目 assets
 * 有 280MB，导出一份 deck 会把项目里每一张图（包括别的任务的）一起交出去。
 *
 * 所以改成扫引用：产物的 html/css/js 里写了哪些素材，就带哪些。
 *
 * ⚠️ **扫不到的一律不猜，但必须说出来。** 静态引用是确定的；算不出来的（动态拼
 * 路径、脚本里的字面量、`<base href>` 改了解析基准）**不往包里多塞**，而是记进
 * `unresolved` 由调用方写成清单放进包里。用户拍的板：宁可在纸面上说清缺什么，
 * 也不靠多塞蒙混过去。**「既不进包也不进清单」是这条规矩里最坏的状态** —— 那是
 * 假装没这回事，比多塞还糟。
 *
 * ── 2026-08-17 评审后重写，六条实测出来的病（每条都有单测钉着）──
 *   1. `<script src="x.js">` 随整块脚本被摘掉 → 真引用静默丢失
 *   2. HTML 注释里的旧引用照收 → 别的任务的图混进包
 *   3. `src="it's.png"` 用混合字符类解析 → 幻影路径 `it`
 *   4. `file:` 之类 scheme 漏过滤（原来是枚举表）→ 幻影 ref
 *   5. 脚本里的字面量素材（`['a.png','b.png']`）既不进包也不进清单
 *   6. 树外引用全域放行 → `<a href="../别的任务/x.html">` 把别人的产物收进来
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { MEDIA_EXT } from './outside-media.js';

/** 会被扫的文本类型（二进制不扫） */
const SCANNABLE = /\.(html?|css|jsx?|mjs|cjs)$/i;

/**
 * 不是本地素材的引用。**用泛化判据不用枚举表** —— 枚举表漏一个 scheme（`file:`）
 * 就会产出幻影 ref。代价是 `x:30.png` 这种带冒号的文件名会被当 scheme 滤掉，
 * 但浏览器本来也按 scheme 解析它，滤掉才是对齐浏览器语义。
 */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * 静态引用的抓取规则。
 *
 * ⚠️ **引号必须分支写**（`"([^"]*)"|'([^']*)'`），不能用 `["']([^"']+)["']` 那种
 * 混合字符类：后者遇到 `src="it's.png"` 会在撇号处截断，抓出幻影 `it`。
 * ⚠️ 属性名前的 `(?<![.\w-])` 挡的是 JS 里的 `img.src = '...'` —— 没有它，属性
 * 规则会把代码里的赋值当成 HTML 属性，同样抓出幻影。
 */
/**
 * **只对标记语言成立**的规则。`src=` / `href=` 是 HTML 属性 —— 拿它去扫 .js
 * 会把 `const data = 'hello world'` 当成引用，捞出幻影路径 `站/hello world`
 * 塞进 missing，交付物里印出假警报（实测踩过）。
 */
const MARKUP_PATTERNS = [
  /(?<![.\w-])(?:src|href|poster|data-src|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
];

/** 在 html / css / js 里语义都成立的规则 */
const UNIVERSAL_PATTERNS = [
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")][^)]*?))\s*\)/gi,
  /@import\s+(?:"([^"]*)"|'([^']*)')/gi,
  /\bfrom\s+["']([^"']+\.(?:css|png|jpe?g|webp|gif|svg))["']/gi,
  // `new URL('x.png', import.meta.url)` 的第一个参数是**字面量**，静态可判，
  // 不该只当成"算不出来"记进清单。
  /new\s+URL\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*,\s*import\.meta\.url/gi,
];

/** 从一次匹配里取出那个真正被捕获的分支 */
function capturedOf(m) {
  for (let i = 1; i < m.length; i++) if (m[i] != null) return m[i];
  return null;
}

/**
 * 摘掉脚本体但**保留开标签** —— `<script src="lib/chart.js"></script>` 里的 src
 * 是真引用，整块摘掉会静默丢失它（实测踩过）。
 */
const SCRIPT_BLOCK = /(<script\b[^>]*>)[\s\S]*?<\/script>/gi;
/** HTML 注释：里面的引用是历史残留，收进来就是把别的任务的旧图打进包 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** CSS / JS 的块注释。**不摘 `//` 行注释** —— 会误杀 `https://` */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/** 动态拼路径：抓到只报告不解析 */
const DYNAMIC_HINTS = [
  { re: /["'][^"']*assets\/[^"']*["']\s*\+/gi,        why: '字符串拼接' },
  { re: /`[^`]*assets\/[^`]*\$\{[^`]*`/gi,            why: '模板字符串插值' },
  { re: /\+\s*["'][^"']*\.(?:png|jpe?g|webp|gif|svg|mp4)["']/gi, why: '字符串拼接' },
];

/** 脚本里的素材字面量（画廊 / lightbox 的常见写法），只进清单不进包 */
const SCRIPT_LITERAL = /["'`]([^"'`\n]{1,200}\.(?:png|jpe?g|webp|gif|svg|mp4|webm|pdf|woff2?))["'`]/gi;

/** 去掉查询串和锚点（`x.webp?w=480` → `x.webp`）、反斜杠归一、URL 解码 */
function cleanRef(raw) {
  const s = String(raw).trim().replace(/\\/g, '/').split('#')[0].split('?')[0];
  try { return decodeURIComponent(s); } catch { return s; }
}

/** srcset 拆成一组候选：`a.png 1x, b.png 2x` → ['a.png','b.png'] */
function splitSrcset(value) {
  return value.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * 扫一批产物文件，收出它们引用到的素材。
 *
 * @param {object} opts
 * @param {Array<{abs:string, rel:string}>} opts.files  要扫的文件（rel 相对 baseRoot）
 * @param {string}   opts.baseRoot       解析基准（工作区根）。返回的路径都相对它
 * @param {string[]} [opts.allowPrefixes] 允许收的前缀白名单（树外只认这些，通常是
 *   产物自己的根 + `assets/`）。**留空 = 不设闸**（根层产物就是这种情况，它的树
 *   本来就是整个工作区）。被挡下的引用不静默丢，进 unresolved。
 * @returns {Promise<{refs:string[], unresolved:Array<{from,why,snippet}>}>}
 */
export async function collectAssetRefs({ files, baseRoot, allowPrefixes = [], allowMedia = false }) {
  const own = new Set(files.map(f => f.rel.replace(/\\/g, '/')));
  const refs = new Set();
  const unresolved = [];
  const candidates = [];              // 脚本里的字面量，等调用方按"磁盘上真有"再提升
  const seenHint = new Set();          // 同一句话被多条规则命中时去重

  const pushHint = (from, why, snippet) => {
    const s = String(snippet).replace(/\s+/g, ' ').slice(0, 120);
    const key = `${from}|${s}`;
    if (seenHint.has(key)) return;
    seenHint.add(key);
    unresolved.push({ from, why, snippet: s });
  };

  // allowMedia（09-18）：树外的**素材文件**也收。生成图被拖出 assets/ 摆到桌面或别的文件夹后，
  // 页面引用会被改写成 `../hero.webp`；只认 assets/ 的话导出静默丢图。页面类（html）仍挡在外面
  const allowed = (rel) => {
    if (!allowPrefixes.length) return true;
    if (allowMedia && MEDIA_EXT.test(rel)) return true;
    return allowPrefixes.some(p => (p === '' ? true : rel === p || rel.startsWith(p)));
  };

  for (const f of files) {
    if (!SCANNABLE.test(f.rel)) continue;
    let text;
    try { text = await fs.readFile(f.abs, 'utf8'); } catch { continue; }

    const fileDirAbs = path.dirname(f.abs);
    const isMarkup = /\.html?$/i.test(f.rel);
    const isScript = /\.(m?js|cjs|jsx)$/i.test(f.rel);
    // 静态引用只在「非注释、非脚本体」的部分找；动态线索照旧扫全文
    const staticText = text
      .replace(HTML_COMMENT, ' ')
      .replace(BLOCK_COMMENT, ' ')
      .replace(SCRIPT_BLOCK, '$1</script>');

    for (const pattern of (isMarkup ? [...MARKUP_PATTERNS, ...UNIVERSAL_PATTERNS] : UNIVERSAL_PATTERNS)) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(staticText)) !== null) {
        const captured = capturedOf(m);
        if (captured == null) continue;
        const isSrcset = /srcset/i.test(pattern.source);
        for (const c of (isSrcset ? splitSrcset(captured) : [captured])) {
          if (!c || EXTERNAL.test(c.trim())) continue;
          const cleaned = cleanRef(c);
          if (!cleaned || cleaned.startsWith('/')) continue;   // 根路径引用平台本来就禁
          const abs = path.resolve(fileDirAbs, cleaned);
          const rel = path.relative(baseRoot, abs).replace(/\\/g, '/');
          if (!rel || rel.startsWith('..')) continue;          // 逃出工作区的不收
          if (own.has(rel)) continue;                          // 产物自己的页面不算素材
          if (!allowed(rel)) {
            pushHint(f.rel, '引用落在产物树外（只有 assets/、产物自己的目录和素材文件会进包）', cleaned);
            continue;
          }
          refs.add(rel);
        }
      }
    }

    // `<base href>` 会改写整页相对路径的解析基准，扫描器按文件目录解析就会整体偏移
    if (/<base\b[^>]*\bhref/i.test(text)) {
      pushHint(f.rel, '页面有 <base href>，本页所有相对引用的解析基准可能跟打包时算的不一样', '<base href=…>');
    }

    for (const { re, why } of DYNAMIC_HINTS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) pushHint(f.rel, why, m[0]);
    }

    // 脚本里的素材字面量（画廊 / lightbox 的常见写法）。
    // **完整字面量是静态可判的**，所以不直接判死：能落进工作区、又过得了树外闸的
    // 交给调用方按「磁盘上真有这个文件」提升成素材；剩下的才进清单。
    // 这不违反「扫不到的不多塞」—— 它扫得到，只是来源是脚本而不是标签。
    const scanLiterals = (body) => {
      SCRIPT_LITERAL.lastIndex = 0;
      let lit;
      while ((lit = SCRIPT_LITERAL.exec(body)) !== null) {
        const cleaned = cleanRef(lit[1]);
        const snippet = lit[0].slice(0, 120);
        if (!cleaned || EXTERNAL.test(cleaned) || cleaned.startsWith('/')) {
          pushHint(f.rel, '脚本里的字符串字面量（打包时不解析）', snippet); continue;
        }
        const rel = path.relative(baseRoot, path.resolve(fileDirAbs, cleaned)).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..') || own.has(rel) || !allowed(rel)) {
          pushHint(f.rel, '脚本里的字符串字面量（打包时不解析）', snippet); continue;
        }
        candidates.push({ rel, from: f.rel, snippet });
      }
    };
    // ⚠️ 从**剥过注释**的文本里取脚本体：标签侧早就剥了注释，字面量侧漏剥的话，
    // 注释里的旧图会被提升进包 —— 同一条规矩两个半边，只修一半等于没修。
    const commentFree = text.replace(HTML_COMMENT, ' ');
    for (const sm of commentFree.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scanLiterals(sm[1]);
    // ⚠️ 独立的 .js 文件**整个就是脚本体**，没有 <script> 标签可匹配。
    // 不加这条的话，同一份画廊代码写在 HTML 里能收、抽成 js 文件就双失踪。
    if (isScript) scanLiterals(text.replace(BLOCK_COMMENT, ' '));
  }

  return { refs: [...refs].sort(), candidates, unresolved };
}

/**
 * 把 unresolved 渲染成放进包里的清单。没有动态引用时返回 null（不放空文件 ——
 * 旧交付包里那个常年空着的 prompt.txt 就是这么来的）。
 */
export function renderUnresolvedReport(unresolved) {
  if (!unresolved?.length) return null;
  const lines = [
    '# 没能解析的素材引用',
    '',
    '下面这些地方打包时算不出具体引用了哪个文件，**素材可能没进包**。',
    '如果打开后有图裂了，照这个清单去原工程里找对应文件补进来。',
    '',
  ];
  const byFile = new Map();
  for (const u of unresolved) {
    if (!byFile.has(u.from)) byFile.set(u.from, []);
    byFile.get(u.from).push(u);
  }
  for (const [file, items] of [...byFile.entries()].sort()) {
    lines.push(`## ${file}`, '');
    for (const it of items) lines.push(`- （${it.why}）\`${it.snippet}\``);
    lines.push('');
  }
  return lines.join('\n');
}
