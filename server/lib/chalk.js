/**
 * server/lib/chalk.js —— 板书（2026-08-23 黑板三期：真相住文件）
 *
 * 板书 = agent（或用户）写在画布上的一段话，**本体是 `notes/板书/<stamp>-<slug>.md`**，
 * board.json 只存它摆在哪、跟谁连线。为什么是文件而不是 board.json 里的 text 物件：
 *   - agent 要能 Read/Grep/Edit 自己说过的话，git 要有历史（板书是对话，不是记号）
 *   - board.json 512KB 一把锁整份重写，当对话容器撑不住
 *   - 跟「kind 文件即真相」一致：删文件即消失，改名/搬家走同一套对账
 * 草图里的节点仍是画布原生 text（它们是几何的一部分，不是散文）—— 两种东西本来
 * 就不一样，不硬凑。
 *
 * frontmatter（只认这几个键，其余原样当正文）：
 *   nd: chalk            标记（没有它就是普通便利贴）
 *   by: agent|user
 *   at: ISO 时间
 *   anchor: <canvas id>  这段话关于谁（落盘时顺手画 annotates 线）
 *   reply_to: <path>     回应哪一条板书（线程）
 *   tag: <tag>           归哪一组
 *   session: <sid>       （沿用便利贴的归属字段）
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const CHALK_DIR = 'notes/板书';
const FM_RE = /^---\n([\s\S]{0,800}?)\n---\n?/;

export function parseChalk(raw) {
  const m = FM_RE.exec(raw);
  if (!m) return { body: raw, chalk: null, sessionId: null };
  const head = m[1];
  const get = (k) => { const r = new RegExp(`(?:^|\\n)${k}:\\s*(.+?)\\s*(?:\\n|$)`).exec(head); return r ? r[1].trim() : null; };
  const body = raw.slice(m[0].length).replace(/^\n+/, '').replace(/\n+$/, '');
  if (get('nd') !== 'chalk') return { body, chalk: null, sessionId: get('session') };
  return {
    body,
    sessionId: get('session'),
    chalk: {
      by: get('by') === 'user' ? 'user' : 'agent',
      at: get('at'),
      anchor: get('anchor'),
      replyTo: get('reply_to'),
      tag: get('tag'),
    },
  };
}

export function renderChalk({ body, by = 'agent', at = new Date().toISOString(), anchor = null, replyTo = null, tag = null, sessionId = null }) {
  const lines = ['---', 'nd: chalk', `by: ${by}`, `at: ${at}`];
  if (anchor) lines.push(`anchor: ${anchor}`);
  if (replyTo) lines.push(`reply_to: ${replyTo}`);
  if (tag) lines.push(`tag: ${tag}`);
  if (sessionId) lines.push(`session: ${sessionId}`);
  lines.push('---', '', String(body).trim(), '');
  return lines.join('\n');
}

/** 文件名：时间戳 + 正文首行做的短名（只留字母数字中日文，≤24），保证可读可排序 */
export function chalkFileName(body, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const first = String(body || '').split('\n').find(l => l.trim()) || '';
  const slug = first.replace(/^#+\s*/, '').replace(/[*_`>#\[\]()]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'chalk';
  return `${stamp}-${slug}.md`;
}

/** 写一条板书到工作区；返回相对路径 */
export async function writeChalkFile(sharedRoot, fileName, content, { overwrite = false } = {}) {
  const dir = path.join(sharedRoot, CHALK_DIR);
  await fs.mkdir(dir, { recursive: true });
  let name = fileName;
  if (!overwrite) {
    // 同一秒两条同首行的板书会撞名（fable 08-23 P2）：存在就加序号，绝不静默覆盖
    for (let i = 2; i < 100; i += 1) {
      try { await fs.access(path.join(dir, name)); } catch { break; }
      name = fileName.replace(/\.md$/, `-${i}.md`);
    }
  }
  const abs = path.join(dir, name);
  await fs.writeFile(abs, content, 'utf8');
  return `${CHALK_DIR}/${name}`;
}

/**
 * 软删（2026-08-25，信箱 iss_mt8cvn16：板书 rm 后无法恢复）：删除入口一律把文件
 * 挪进 `.nd/trash/<YYYYMMDD>/` 而不是 unlink —— `.nd/` 不上画布不进 git，用户体感
 * 就是删了，但捞得回来。挪不动（跨盘等）才退回真删。
 */
export async function trashChalkFile(sharedRoot, absPath) {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(sharedRoot, '.nd', 'trash', day);
    await fs.mkdir(dir, { recursive: true });
    let dest = path.join(dir, path.basename(absPath));
    for (let i = 2; i < 100; i += 1) {
      try { await fs.access(dest); dest = path.join(dir, path.basename(absPath).replace(/\.md$/, `-${i}.md`)); } catch { break; }
    }
    await fs.rename(absPath, dest);
    return dest;
  } catch {
    try { await fs.unlink(absPath); } catch { /* 已经没了 */ }
    return null;
  }
}

/** 最近的板书（给注入用）：按文件名（=时间戳）倒序，读前几条的首行 */
export async function recentChalk(sharedRoot, { limit = 8 } = {}) {
  const dir = path.join(sharedRoot, CHALK_DIR);
  let names;
  try { names = (await fs.readdir(dir)).filter(n => n.endsWith('.md') && !n.startsWith('.')); } catch { return []; }
  names.sort().reverse();
  const out = [];
  for (const n of names.slice(0, limit)) {
    try {
      const raw = await fs.readFile(path.join(dir, n), 'utf8');
      const { body, chalk } = parseChalk(raw);
      if (!chalk) continue;
      const first = (body.split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 80);
      out.push({ path: `${CHALK_DIR}/${n}`, first, ...chalk });
    } catch { /* 单条读不到就跳 */ }
  }
  return out;
}

/** 给一批画布 id 里的板书读首行（read_board 用）：Map<id, {first, by, anchor, replyTo}> */
export async function chalkExcerpts(sharedRoot, ids) {
  const out = new Map();
  const base = path.resolve(sharedRoot, CHALK_DIR);
  for (const id of ids) {
    if (typeof id !== 'string' || !id.startsWith(`${CHALK_DIR}/`)) continue;
    const name = id.slice(CHALK_DIR.length + 1);
    // 读侧同一道闸：单段文件名、不越界（fable 08-23：id 可控，别拿它直接 join）
    if (!name || name.includes('/') || name.includes('..') || name.startsWith('.')) continue;
    const abs = path.resolve(base, name);
    if (!abs.startsWith(base + path.sep)) continue;
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const { body, chalk } = parseChalk(raw);
      if (!chalk) continue;
      const first = (body.split('\n').find(l => l.trim()) || '').replace(/^#+\s*/, '').replace(/\*\*/g, '').slice(0, 60);
      out.set(id, { first, ...chalk });
    } catch { /* 文件没了：留给对账 */ }
  }
  return out;
}
