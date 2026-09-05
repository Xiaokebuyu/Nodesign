/**
 * engine/stage/card.js —— 角色卡的格式与读写（2026-09-05，站主提议"角色卡重新利用"）
 *
 * 一张卡 = 一个人的全部，住 `角色/<名>/角色卡.md`，用户在画布上看得见、改得了：
 *
 *   ---
 *   name: 晴可            展示名（显示器名册 / write_scene 的 speakers 都用它）
 *   slug: rp-qingke       cast_role 登记的 id（可无）
 *   note: 同桌 · 靠后门第三排
 *   portrait: 角色/晴可/立绘.png   （可无，工作区相对路径）
 *   ---
 *   # 晴可
 *   （人设 / 语气样本 / 绝不做什么 —— 人写的部分，机器不碰）
 *
 *   <!-- nd:memory:start -->
 *   ## 记住的事
 *   - [qingke-attitude](记忆/qingke-attitude.md) `character` — 对"挂钟"这个绰号的态度
 *   <!-- nd:memory:end -->
 *
 * 两个笔在同一份文件上：**人只改块外，机器只改块内**（标记块的写法跟 prelude 的 nd:mode
 * 同款）。索引正文一事一文件落在 `角色/<名>/记忆/`，`remember` 带 who 就写到这儿，写完
 * 从磁盘重扫重建块内（不做增量 —— 增量索引会跟正文对不上）。
 *
 * 开戏时卡的正文 + 索引块**整份进系统提示词**（快照；之后新记的走对话，重开再并进去），
 * 所以卡是冻结区的一部分：用户改卡 = 下一句话到时进程自动重开（manager 盯 mtime）。
 *
 * 跟 `stage/台面.md` 的分工：卡装"人"，台面装"戏"（世界 / 规矩 / 怎么演）。八个人的戏
 * 写进八张卡就是八份世界副本，所以世界不进卡。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { readCastRegistry } from '../agent/role-card.js';
import { listPlays } from './play.js';

export const ROLES_DIR = '角色';
export const CARD_FILE = '角色卡.md';
export const CARD_MEMORY_DIR = '记忆';
export const MEM_START = '<!-- nd:memory:start -->';
export const MEM_END = '<!-- nd:memory:end -->';

const FM_RE = /^---\r?\n([\s\S]{0,4000}?)\r?\n---\r?\n?/;
const BLOCK_RE = new RegExp(`${MEM_START.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[\\s\\S]*?${MEM_END.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\n?`);

function fmValue(fm, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return null;
  return m[1].trim().replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1') || null;
}

/** 文件夹名：剥路径分隔与点前缀（跟 cast-role.js 的 folderNameFor 同口径） */
export function folderNameFor(displayName, fallback = 'role') {
  const cleaned = String(displayName || '').replace(/[\r\n]+/g, ' ').replace(/[\/\\]/g, '').replace(/^\.+/, '').trim().slice(0, 40);
  return cleaned || fallback;
}

/**
 * 解析一张卡。
 * @returns {{ fm: {name, slug, note, portrait}, body: string, memory: string, raw: string }}
 *   body = 去掉 frontmatter 与机器块之后人写的部分；memory = 机器块内正文（不含标记）
 */
export function parseCard(raw) {
  const text = String(raw || '');
  const fmm = FM_RE.exec(text);
  const fm = fmm ? fmm[1] : '';
  let rest = fmm ? text.slice(fmm[0].length) : text;
  let memory = '';
  const bm = BLOCK_RE.exec(rest);
  if (bm) {
    memory = bm[0].replace(MEM_START, '').replace(MEM_END, '').trim();
    rest = rest.slice(0, bm.index) + rest.slice(bm.index + bm[0].length);
  }
  const body = rest.trim();
  // 没有 frontmatter 的老卡（cast_role 09-05 之前写的）：名字取 `# 标题`
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || null;
  return {
    fm: {
      name: fmValue(fm, 'name') || h1,
      slug: fmValue(fm, 'slug'),
      note: fmValue(fm, 'note'),
      portrait: fmValue(fm, 'portrait'),
    },
    body,
    memory,
    raw: text,
  };
}

/** 把机器块换成新索引（没有块就接在末尾）。人写的部分一个字不动。 */
export function replaceMemoryBlock(raw, indexBody) {
  const block = `${MEM_START}\n${String(indexBody || '').trim()}\n${MEM_END}\n`;
  const text = String(raw || '');
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, block);
  return `${text.replace(/\s*$/, '')}\n\n${block}`;
}

/**
 * 卡上的「可选」条目（2026-09-06）：酒馆卡常有"由玩家决定是否启用"的设定（某条支线、某个癖好、
 * 某段前史）。写卡的人把它们放在一节 `## 可选` 下，一条一行：
 *   - [ ] 有个弟弟 — 家里还有个初中的弟弟，周末要接他
 *   - [x] 会抽烟 — 默认开
 * 显示器开场页把它们画成开关，玩家勾完机器记进 戏.json 的 cardOptions，随卡一起进系统提示词
 * （"玩家开场时选的：启用 A，不启用 B"）。没有这一节的卡就没有开关。
 */
export function parseCardOptions(body) {
  const text = String(body || '');
  // 一节到下一个标题或文件末尾为止（⚠️ 带 m 标志时 $ 是行尾，用"后面没字了"代替）
  const sec = /^#{2,3}[ \t]*可选[^\n]*\n([\s\S]*?)(?=\n#{1,3}[ \t]|(?![\s\S]))/m.exec(text);
  if (!sec) return [];
  const out = [];
  let n = 0;
  for (const raw of sec[1].split('\n')) {
    const m = /^\s*[-*]\s*(?:\[( |x|X|✓|√)\]\s*)?(.+)$/.exec(raw);
    if (!m) continue;
    const on = !!(m[1] && m[1].trim());
    const [label, ...rest] = m[2].split(/\s+[—–:：-]\s+|\s+—\s*|\s*：\s*/);
    const lab = String(label || '').trim();
    if (!lab) continue;
    n += 1;
    out.push({ id: `opt${n}`, label: lab.slice(0, 40), desc: rest.join(' ').trim().slice(0, 200), default: on });
  }
  return out;
}

/** 渲一张新卡（cast_role 用）。机器块先立一个空的，让人一眼知道那块不归他。 */
export function renderCard({ name, slug = null, note = null, portrait = null, persona }) {
  const fm = ['---', `name: ${name}`];
  if (slug) fm.push(`slug: ${slug}`);
  if (note) fm.push(`note: ${note}`);
  if (portrait) fm.push(`portrait: ${portrait}`);
  fm.push('---');
  const body = String(persona || '').trim();
  const head = [
    ...(/^#\s/.test(body) ? [] : [`# ${name}`, '']),   // persona 自带大标题就不再加一个（09-05 的卡顶上叠了两个「# 晴可」）
    `<!-- ${slug ? `${slug} · ` : ''}cast_role 登记。`,
    '     正文是这个人的人设：他是谁、怎么说话、绝不做什么，加两三句语气样本。',
    '     开戏时整份进演出进程的系统提示词；改了正文，下一句话到时进程自动重开。',
    '     下面 nd:memory 那一块是机器维护的记忆索引，别手改 —— 正文在 记忆/ 目录里。 -->',
    '',
    body,
    '',
  ].join('\n');
  return replaceMemoryBlock(`${fm.join('\n')}\n${head}`, '## 记住的事\n（还没有）');
}

/**
 * 角色卡该写在哪个 角色/ 目录下（cast_role 用）。
 * 戏的文件夹自成一体，所以工作区里**只有一场戏**时卡直接写进它；没有戏或有多场（不知道给谁）
 * 时写根上的 角色/，open_stage 开戏时会把在场者的卡搬进戏的文件夹。
 */
export async function rolesDirFor(workspaceRoot) {
  const plays = await listPlays(workspaceRoot);
  return plays.length === 1 ? `${plays[0]}/${ROLES_DIR}` : ROLES_DIR;
}

/**
 * 名字 / slug → 卡的工作区相对路径。查序：戏的文件夹里（给了 playRoot）→ 登记表（cast_role 写的）
 * → 根上的 角色/<名>/。找不到返回 null（调用方决定报什么错）。
 */
export async function resolveCardPath(workspaceRoot, nameOrSlug, { playRoot = null } = {}) {
  const key = String(nameOrSlug || '').trim();
  if (!key) return null;
  const tryRel = async (rel) => { try { await fs.access(path.join(workspaceRoot, rel)); return rel; } catch { return null; } };
  if (playRoot) {
    const hit = await tryRel(path.join(playRoot, ROLES_DIR, folderNameFor(key), CARD_FILE));
    if (hit) return hit;
  }
  const reg = await readCastRegistry(workspaceRoot);
  for (const [slug, e] of Object.entries(reg.roles || {})) {
    if ((slug === key || slug === `rp-${key}` || e?.name === key) && typeof e?.card === 'string') {
      const hit = await tryRel(e.card);
      if (hit) return hit;
      // 登记表还指着根上的路径、卡已经搬进戏的文件夹（open_stage 搬的）
      if (playRoot) { const moved = await tryRel(path.join(playRoot, e.card)); if (moved) return moved; }
    }
  }
  return tryRel(path.join(ROLES_DIR, folderNameFor(key), CARD_FILE));
}

/** 卡所在文件夹（工作区相对） */
export function cardHome(cardRel) { return path.dirname(cardRel); }

/** 读卡给开戏用：名字 / 小字 / 立绘 / 进提示词的正文（人写部分 + 索引块） */
export async function readCardForStage(workspaceRoot, cardRel) {
  const raw = await fs.readFile(path.join(workspaceRoot, cardRel), 'utf8');
  const c = parseCard(raw);
  const memory = c.memory && !/（还没有）/.test(c.memory) ? c.memory : '';
  return {
    card: cardRel,
    name: c.fm.name || path.basename(cardHome(cardRel)),
    slug: c.fm.slug,
    note: c.fm.note || '',
    portrait: c.fm.portrait || null,
    options: parseCardOptions(c.body),
    text: memory
      ? `${c.body}\n\n${memory}\n（索引里的正文在 ${cardHome(cardRel)}/${CARD_MEMORY_DIR}/ 下，要用自己 Read）`
      : c.body,
  };
}

/**
 * 重扫 `角色/<名>/记忆/*.md` 重建卡上的索引块。返回条数。
 * ⭐ 不做增量：增量索引会跟正文对不上（改了正文忘了改索引就是第二个真相源）。
 */
export async function rewriteCardMemoryIndex(workspaceRoot, cardRel) {
  const home = path.join(workspaceRoot, cardHome(cardRel));
  const dir = path.join(home, CARD_MEMORY_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.md'));
  const rows = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
    const d = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    const t = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    rows.push(`- [${f.replace(/\.md$/, '')}](${CARD_MEMORY_DIR}/${f})${t ? ` \`${t}\`` : ''} — ${d}`);
  }
  rows.sort();
  const cardAbs = path.join(workspaceRoot, cardRel);
  const raw = await fs.readFile(cardAbs, 'utf8').catch(() => '');
  const body = rows.length ? `## 记住的事\n${rows.join('\n')}` : '## 记住的事\n（还没有）';
  await fs.writeFile(cardAbs, replaceMemoryBlock(raw, body), 'utf8');
  return rows.length;
}

/**
 * 用户在画布上保存了卡（PUT）：只收人写的部分，机器块以磁盘上的为准接回去。
 * 没有 frontmatter 的提交（用户把头删了）就把磁盘上的头补回来 —— 名字丢了显示器就没人了。
 */
export async function saveCardKeepingMachineBlock(workspaceRoot, cardRel, incoming) {
  const cardAbs = path.join(workspaceRoot, cardRel);
  const onDisk = await fs.readFile(cardAbs, 'utf8').catch(() => '');
  const disk = parseCard(onDisk);
  let text = String(incoming || '');
  text = text.replace(BLOCK_RE, '').replace(/\s*$/, '');
  if (!FM_RE.test(text)) {
    const fmm = FM_RE.exec(onDisk);
    if (fmm) text = `${fmm[0]}${text}`;
  }
  const memBody = disk.memory || '## 记住的事\n（还没有）';
  await fs.writeFile(cardAbs, replaceMemoryBlock(`${text}\n`, memBody), 'utf8');
}
