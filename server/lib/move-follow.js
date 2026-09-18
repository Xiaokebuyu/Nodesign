/**
 * move-follow.js —— 搬家的后半件（2026-09-18，站主定「真搬文件，画布位置变动代表文件变动」）
 *
 * moveEntry 把一个条目 fs.rename 过去、改完画布身份，是搬家的前半件。这里是后半件，三样：
 *
 * 1. **伴随件一起走**。一张生成图在磁盘上是一组文件：母版 `x.png`、页面里真正引用的显示副本
 *    `x.webp`（image-variant.writeWebpSibling）、`.meta/x.json`（prompt 与来历）、
 *    `x.grounding.json`（搜索出处）、`.thumbnails/x.thumb.webp`（缩略缓存）。画布扫描把
 *    png+webp 当**一张卡**（有 png 就藏起 webp），所以只搬其中一个等于把一张卡劈成两张：
 *    留下的 webp 失去 png 兄弟，当场冒成第二张生成图卡，还按同名继承 meta。
 * 2. **全工作区引用改写**（lib/rewrite-refs.js，原来只有 organize_board 调用）。拖卡、
 *    pin_to_board 带 place 都是真搬，站点里写着的 `../assets/generated/x.webp` 不跟着改就裂图。
 * 3. **板书 frontmatter 的 anchor / reply_to**。那是画布 id（相对工作区根），不在 rewrite-refs
 *    的取值位置里；不改的话读板大纲按 anchor 推父节点时认不出搬走的那张卡。
 *
 * 失败不回滚前半件（文件已经搬成）：调用方把错误原样报出去，引用要人或 agent 自己补。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { rewriteWorkspaceRefs, makeMoveResolver } from './rewrite-refs.js';
import { parseChalk, CHALK_DIR } from './chalk.js';

/** png 与 webp 互为一组（扫描口径：同目录同名有 png 就藏起 webp，见 api/assets.js scanDir） */
const PAIR = { '.png': '.webp', '.webp': '.png' };
const IMAGE_OR_VIDEO = /\.(png|webp|jpe?g|gif|avif|mp4|webm|mov)$/i;

const exists = async (abs) => { try { await fs.access(abs); return true; } catch { return false; } };
const dirRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/**
 * 一个文件的伴随件（只列磁盘上真在的）。`to` 是按主文件的新目录算好的落点。
 * @param {string} root   工作区根（绝对路径）
 * @param {string} from   主文件搬前的工作区相对路径
 * @param {string} to     主文件搬后的工作区相对路径
 * @returns {Promise<Array<{from: string, to: string}>>}
 */
export async function companionsOf(root, from, to) {
  const name = path.posix.basename(from);
  const ext = path.posix.extname(name).toLowerCase();
  if (!IMAGE_OR_VIDEO.test(name)) return [];
  const stem = name.slice(0, name.length - ext.length);
  const newStem = path.posix.basename(to).slice(0, path.posix.basename(to).length - ext.length);
  const [src, dst] = [dirRel(from), dirRel(to)];
  const cands = [
    ...(PAIR[ext] ? [[join(src, stem + PAIR[ext]), join(dst, newStem + PAIR[ext])]] : []),
    [join(src, `.meta/${stem}.json`), join(dst, `.meta/${newStem}.json`)],
    [join(src, `${stem}.grounding.json`), join(dst, `${newStem}.grounding.json`)],
    [join(src, `.thumbnails/${stem}.thumb.webp`), join(dst, `.thumbnails/${newStem}.thumb.webp`)],
  ];
  const out = [];
  for (const [f, t] of cands) {
    if (await exists(path.join(root, f))) out.push({ from: f, to: t });
  }
  return out;
}

/**
 * 把伴随件搬过去。落点已有同名文件的**跳过不覆盖**（报在 skipped 里）；
 * 一件搬不动不挡其余几件，主文件已经搬成了。
 * @returns {Promise<{moves: Array<{from,to}>, skipped: string[]}>}
 */
export async function moveCompanions(root, from, to) {
  const moves = []; const skipped = [];
  for (const c of await companionsOf(root, from, to)) {
    const absTo = path.join(root, c.to);
    if (await exists(absTo)) { skipped.push(c.from); continue; }
    try {
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(path.join(root, c.from), absTo);
      moves.push(c);
    } catch { skipped.push(c.from); }
  }
  return { moves, skipped };
}

/** 画布 id 去掉形态前缀后的路径段；不是带路径的 id 返回 null */
const idPath = (id) => {
  const m = /^([a-z]+:)?(.+)$/.exec(String(id || '').trim());
  return m ? { prefix: m[1] || '', rel: m[2] } : null;
};

/**
 * 板书 frontmatter 里指向被搬条目的 anchor / reply_to 改到新路径（只动那一行，正文不碰）。
 * @returns {Promise<number>} 改了几个文件
 */
export async function rewriteChalkAnchors(root, moves) {
  const { forward } = makeMoveResolver(moves);
  const dir = path.join(root, CHALK_DIR);
  let names = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.')); } catch { return 0; }
  let changed = 0;
  for (const n of names) {
    const abs = path.join(dir, n);
    let raw;
    try { raw = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const { chalk } = parseChalk(raw);
    if (!chalk || !(chalk.anchor || chalk.replyTo)) continue;
    let next = raw;
    for (const key of ['anchor', 'reply_to']) {
      const cur = key === 'anchor' ? chalk.anchor : chalk.replyTo;
      const p = cur && idPath(cur);
      const moved = p && forward(p.rel);
      if (!moved) continue;
      next = next.replace(new RegExp(`(^|\\n)${key}:[ \\t]*${cur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?=\\n)`), `$1${key}: ${p.prefix}${moved}`);
    }
    if (next === raw) continue;
    try { await fs.writeFile(abs, next, 'utf8'); changed += 1; } catch { /* 写不动就留旧锚，大纲退回按线推 */ }
  }
  return changed;
}

/**
 * 搬完之后的引用跟随：全工作区文本引用 + 板书锚点。
 * @param {string} root
 * @param {Array<{from,to}>} moves  已完成的搬家（含伴随件）
 * @returns {Promise<{files: number, hits: number, lines: string[], anchors: number}>}
 */
export async function followMoves(root, moves) {
  if (!moves?.length) return { files: 0, hits: 0, lines: [], anchors: 0 };
  const refs = await rewriteWorkspaceRefs(root, moves);
  const anchors = await rewriteChalkAnchors(root, moves);
  return { ...refs, anchors };
}

/** 引用改写的一句话摘要（给 agent 的工具返回与用户侧提示共用） */
export function describeFollow(r) {
  if (!r) return '';
  const parts = [];
  if (r.hits) parts.push(`改写了 ${r.files} 个文件里的 ${r.hits} 处引用`);
  if (r.anchors) parts.push(`${r.anchors} 条板书的锚点`);
  return parts.length ? parts.join('，') : '全工作区没有指向它的引用';
}
