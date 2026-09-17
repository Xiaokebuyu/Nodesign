/**
 * rewrite-refs.js —— 搬文件后把全工作区的引用改写到新路径（2026-08-24，iss_mt38uih6；09-14 重写）
 *
 * 用户的方法论原话：「新建一个文件夹然后改个索引」。organize_board 归纳素材时
 * 磁盘和画布身份跟着走了，但 HTML/MD 里的 src/href 还指旧路径 —— 裂图。这里把
 * "改索引"那半补上。
 *
 * ⛔ 09-14 重写的原因（桌面 0.1.43 实报，改坏了用户三个页面）：旧版对「自己被搬过的文件」
 * 用一条自由 token 正则扫全文 —— 引号/括号/= 后面跟一个带点的串就当相对路径改，也不看
 * 目标在不在。`rgba(255,255,255,.045)` → `rgba(../_drafts/255,255,255,.045)`，`scale(4.2)`、
 * SVG `stroke-width="1.6"`、`<meta content="width=device-width,initial-scale=1.0">` 全中。
 * 另外搬文件夹时夹里的文件不换基准，`decodeURI` 遇到 `%` 抛异常把整趟打断在半路。
 *
 * 现在的两条硬规矩：
 *   1. **只在真正的引用位置取值**（按扩展名分派）：HTML/SVG/MD 的 src/href/poster/data-src/
 *      xlink:href/srcset 属性值，CSS 的 url() 与 @import，MD 的 `](…)` 链接，JS/JSON 的整段
 *      字符串字面量。别的地方（CSS 数值、SVG 数值属性、meta、正文）一个字不碰。
 *   2. **只改确实指向文件的**：解析出来的目标要么是被搬的条目（或在被搬的文件夹里），
 *      要么（引用文件自己被搬时）磁盘上真有这个东西。数字、`Math.PI` 这类解析不到文件的一律不动。
 *
 * 引用是相对路径（站点路径铁律），同一个目标在不同文件里写法不同，逐文件按目录换算。
 * 改了多少处如实报给调用方，并带前几处「旧 → 新」 —— 自动改写用户内容必须可核对。
 * 所有文件先在内存里算完再写盘：算到一半出错不会留下改了一半的工作区。
 */

import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { walkTaskFiles, loadIgnore } from './task-scan.js';

const TEXT_EXTS = /\.(html?|css|md|markdown|js|mjs|json|svg)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const relFrom = (dirRel, targetRel) => path.posix.relative(dirRel || '.', targetRel);
const dirOf = (rel) => (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));

/** 标记语言属性（`(?<![.\w-])` 挡 JS 里的 `img.src = '…'`；引号分支写，见 asset-refs.js 的说明） */
const ATTR_RE = /(?<![.\w:-])(?:src|href|poster|data-src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;
const SRCSET_RE = /(?<![.\w-])srcset\s*=\s*(?:"([^"]*)"|'([^']*)')/dgi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/dgi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/dgi;
const MD_LINK_RE = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/dg;
const MD_DEF_RE = /^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/dgm;
/** JS / JSON：整段字符串字面量。值里不许有空白、模板插值 —— 那是算出来的，不是路径 */
const STRING_RE = /(["'`])([^"'`\s<>{}$\\]+)\1/dg;

function patternsFor(ext) {
  if (/^html?$|^svg$/.test(ext)) return [ATTR_RE, SRCSET_RE, CSS_URL_RE, CSS_IMPORT_RE];
  if (ext === 'css') return [CSS_URL_RE, CSS_IMPORT_RE];
  if (ext === 'md' || ext === 'markdown') return [MD_LINK_RE, MD_DEF_RE, ATTR_RE, SRCSET_RE];
  if (ext === 'js' || ext === 'mjs' || ext === 'json') return [STRING_RE];
  return [];
}

/** 一段文本里所有引用值的位置：[{ start, end, value }] */
function findRefSpans(text, ext) {
  const spans = [];
  for (const re of patternsFor(ext)) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // STRING_RE 的第 1 组是引号，值在第 2 组；其余规则取被命中的那个分支
      const groups = re === STRING_RE ? [2] : m.indices.map((_, i) => i).slice(1);
      const gi = groups.find((i) => m[i] != null);
      if (gi == null) continue;
      const [start, end] = m.indices[gi];
      // 代码里的字符串大多不是路径：要么带 `/`，要么以字母开头的扩展名结尾（`'1.6'` / `'images'` 不算）
      if (re === STRING_RE && !m[gi].includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(m[gi])) continue;
      if (re === SRCSET_RE) {
        // `a.png 1x, b.png 2x`：每个候选的第一个 token 才是路径
        const inner = m[gi];
        const cand = /(^|,)\s*([^\s,]+)/g;
        for (const c of inner.matchAll(cand)) {
          const off = c.index + c[0].length - c[2].length;
          spans.push({ start: start + off, end: start + off + c[2].length, value: c[2] });
        }
        continue;
      }
      spans.push({ start, end, value: m[gi] });
    }
  }
  // 同一处被两条规则命中（md 里的 HTML 属性）只算一次
  spans.sort((a, b) => a.start - b.start);
  return spans.filter((s, i) => i === 0 || s.start >= spans[i - 1].end);
}

/**
 * 纯函数：改写一段文本里的引用。
 * @param {string} text
 * @param {object} o
 * @param {string} o.ext          扩展名（不带点，小写）
 * @param {string} o.oldDir       这段文本**写下时**所在目录（工作区相对，'' = 根）
 * @param {string} o.newDir       现在所在目录（自己没被搬则与 oldDir 相同）
 * @param {(rel: string) => string|null} o.resolveMove  旧路径 → 搬后路径（没搬返回 null；含文件夹前缀）
 * @param {(rel: string) => boolean} [o.exists]         搬完之后磁盘上有没有这个路径（自己被搬时用）
 * @returns {{ text: string, hits: number, samples: string[] }}
 */
export function rewriteRefsInText(text, { ext, oldDir, newDir, resolveMove, exists = () => false }) {
  const selfMoved = (oldDir || '') !== (newDir || '');
  const edits = [];
  for (const s of findRefSpans(text, ext)) {
    const raw = s.value;
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i.test(raw)) continue;   // 协议 / 协议相对 / 绝对 / 锚点
    const cut = raw.search(/[?#]/);
    const pathPart = cut >= 0 ? raw.slice(0, cut) : raw;
    const suffix = cut >= 0 ? raw.slice(cut) : '';
    if (!pathPart) continue;
    let decoded = pathPart;
    try { decoded = decodeURI(pathPart); } catch { /* 坏编码（比如裸 %）：按原文比，不抛 */ }
    const target = path.posix.normalize(path.posix.join(oldDir || '.', decoded));
    if (target === '.' || target.startsWith('../') || target === '..') continue;   // 出工作区的不碰
    const moved = resolveMove(target);
    if (!moved) {
      // 目标没搬：只有引用文件自己搬了才需要换基准，而且目标必须真在磁盘上
      if (!selfMoved || !exists(target)) continue;
    }
    const finalTarget = moved || target;
    let next = relFrom(newDir, finalTarget) || '.';
    if (raw.startsWith('./') && !next.startsWith('.')) next = `./${next}`;
    if (decoded !== pathPart) next = encodeURI(next);
    next += suffix;
    if (next === raw) continue;
    edits.push({ ...s, next });
  }
  if (!edits.length) return { text, hits: 0, samples: [] };
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.next + out.slice(e.end);
  }
  return { text: out, hits: edits.length, samples: edits.slice(0, 3).map((e) => `${e.value} → ${e.next}`) };
}

/** moves → 查表函数：精确命中文件，或落在被搬文件夹里（按前缀，长的优先） */
export function makeMoveResolver(moves) {
  const exact = new Map(moves.map((m) => [m.from, m.to]));
  const byLen = [...moves].sort((a, b) => b.from.length - a.from.length);
  return {
    forward(rel) {
      if (exact.has(rel)) return exact.get(rel);
      const hit = byLen.find((m) => rel.startsWith(`${m.from}/`));
      return hit ? hit.to + rel.slice(hit.from.length) : null;
    },
    /** 搬后路径 → 搬前路径（文件本身或所在文件夹被搬过） */
    backward(rel) {
      const hit = [...moves].sort((a, b) => b.to.length - a.to.length)
        .find((m) => rel === m.to || rel.startsWith(`${m.to}/`));
      return hit ? hit.from + rel.slice(hit.to.length) : null;
    },
  };
}

/**
 * 扫全工作区文本文件，改写指向被搬条目的引用；被搬的文件（含被搬文件夹里的）自己的相对引用换基准。
 * @param {string} root   工作区根（绝对路径）
 * @param {Array<{from: string, to: string}>} moves  已完成的搬家（工作区相对）
 * @returns {Promise<{files: number, hits: number, lines: string[]}>}
 */
export async function rewriteWorkspaceRefs(root, moves) {
  const resolver = makeMoveResolver(moves);
  const exists = (rel) => existsSync(path.join(root, ...rel.split('/')));
  const ignore = await loadIgnore(root);
  const all = await walkTaskFiles(root, { maxDepth: 6, ignore, includeDrafts: true });
  const pending = [];
  for (const f of all) {
    if (!TEXT_EXTS.test(f.name) || f.size > MAX_BYTES) continue;
    let raw;
    try { raw = await fs.readFile(f.abs, 'utf8'); } catch { continue; }
    const selfOld = resolver.backward(f.rel);
    const r = rewriteRefsInText(raw, {
      ext: path.extname(f.name).slice(1).toLowerCase(),
      oldDir: dirOf(selfOld || f.rel),
      newDir: dirOf(f.rel),
      resolveMove: resolver.forward,
      exists,
    });
    if (r.hits > 0 && r.text !== raw) pending.push({ f, r });
  }
  let files = 0; let hits = 0; const lines = [];
  for (const { f, r } of pending) {
    try { await fs.writeFile(f.abs, r.text, 'utf8'); } catch { continue; }
    files += 1; hits += r.hits;
    lines.push(`  ↻ ${f.rel}：${r.hits} 处（${r.samples.join('；')}${r.hits > r.samples.length ? '；…' : ''}）`);
  }
  return { files, hits, lines };
}
