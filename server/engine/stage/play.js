/**
 * engine/stage/play.js —— 一场戏一个文件夹（2026-09-05 晚，站主提议目录重构）
 *
 * 此前一场戏的东西散在工作区根上六个地方（stage/、角色/、世界书/、预设/、记忆/、用户内容/），
 * CLAUDE.md 里还抄了一遍台面规矩。现在**一场戏 = 工作区根下的一个文件夹**，里面自成一体：
 *
 *   晴可同桌/                 ← 画布上那张演出卡就是这个文件夹
 *     戏.json                 标题 / 在场者 / 状态面板 / 皮肤（原 stage.json）
 *     台面.md                 世界 / 规矩 / 怎么演
 *     规则.json               成就与触发（主 agent 按酒馆卡和难度写，机械层只做比较）
 *     成就.jsonl              达成记录，一行一枚
 *     角色/<名>/角色卡.md      人 + 他的记忆索引；同目录 记忆/、立绘.png
 *     记忆/ INDEX.md          这场戏的记忆（演到哪 / 伏笔 / 世界新事实）
 *     场景/scenes.jsonl       一拍一行；场景/背景/ 换场时生的背景图
 *     世界书/ 预设/            导入的酒馆料，进程按需 grep
 *     素材/                   用户丢进来的图
 *
 * 一个文件夹就是一份能整个搬走的存档，比酒馆卡多带了记忆和剧情。一个项目可以放几场戏。
 * `CLAUDE.md` 刻意**不**进来：那是主 agent 那一侧的档案，SDK 只从工作区根读它。
 *
 * 老形状（根上的 stage/ + 根上的 角色/ 等）由 migrateLegacyPlay 一次性收进文件夹。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export const PLAY_CONFIG = '戏.json';
export const TABLE_FILE = '台面.md';
export const RULES_FILE = '规则.json';
export const TROPHIES_FILE = '成就.jsonl';
export const SCENES_DIR = '场景';
export const SCENES_FILE = 'scenes.jsonl';
export const BACKDROPS_DIR = '背景';          // 场景/背景/
export const MEMORY_DIR = '记忆';
export const MEM_INDEX = 'INDEX.md';
export const ROLES_DIR = '角色';
export const ASSETS_DIR = '素材';
export const WORLD_DIR = '世界书';
export const PRESET_DIR = '预设';
/** 09-05 下午那一版的落点，只在迁移时认 */
export const LEGACY_DIR = 'stage';

export async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** 这个目录是不是一场戏（有 戏.json 或 台面.md） */
export async function isPlayDir(abs) {
  return (await exists(path.join(abs, PLAY_CONFIG))) || (await exists(path.join(abs, TABLE_FILE)));
}

/** 文件夹名：剥路径分隔与点前缀（跟 card.js 的 folderNameFor 同口径） */
export function playFolderName(title, fallback = '演出') {
  const cleaned = String(title || '').replace(/[\r\n]+/g, ' ').replace(/[\/\\]/g, '').replace(/^\.+/, '').replace(/[<>:"|?*]/g, '').trim().slice(0, 40);
  return cleaned || fallback;
}

/** 工作区根下所有戏的文件夹名（一级） */
export async function listPlays(workspaceRoot) {
  let entries = [];
  try { entries = await fs.readdir(workspaceRoot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === LEGACY_DIR) continue;   // 老 stage/ 不算戏，等迁移
    if (await isPlayDir(path.join(workspaceRoot, e.name))) out.push(e.name);
  }
  return out.sort();
}

export async function readPlayConfig(playAbs) {
  try { return JSON.parse(await fs.readFile(path.join(playAbs, PLAY_CONFIG), 'utf8')); } catch { return null; }
}
export async function writePlayConfig(playAbs, cfg) {
  await fs.mkdir(playAbs, { recursive: true });
  await fs.writeFile(path.join(playAbs, PLAY_CONFIG), JSON.stringify(cfg, null, 2), 'utf8');
}

export async function readRules(playAbs) {
  try {
    const r = JSON.parse(await fs.readFile(path.join(playAbs, RULES_FILE), 'utf8'));
    return { achievements: Array.isArray(r?.achievements) ? r.achievements : [], triggers: Array.isArray(r?.triggers) ? r.triggers : [] };
  } catch { return { achievements: [], triggers: [] }; }
}
export async function writeRules(playAbs, rules) {
  await fs.mkdir(playAbs, { recursive: true });
  await fs.writeFile(path.join(playAbs, RULES_FILE), JSON.stringify(rules, null, 2), 'utf8');
}

// ───────────────────────────── 线路（分支）─────────────────────────────
//
// 一个故事可以有几条线：主线的记录在 场景/scenes.jsonl，别的线在 场景/线-<id>.jsonl。
// 戏.json 里 `lines: [{id, name, sdkSid, createdAt, forkedFrom:{line, rowId}}]`、`currentLine`。
// sdkSid 是这条线在 SDK 那边的会话 id（转录在 CLAUDE_CONFIG_DIR 下）：重开时 resume 它，模型才记得前文；
// 回退 = 截转录 + 截记录文件；分叉 = forkSession 出一个新 sdkSid + 复制记录前半段。
// 老配置没有 lines → 视作只有主线，第一次写配置时补上。

export const MAIN_LINE = 'main';

/** 配置里的线路表（老配置补一条主线） */
export function linesOf(cfg) {
  const lines = Array.isArray(cfg?.lines) && cfg.lines.length ? cfg.lines : [{ id: MAIN_LINE, name: '主线', sdkSid: cfg?.sdkSid || null, createdAt: cfg?.startedAt || null }];
  return lines;
}
export function currentLineId(cfg) {
  const lines = linesOf(cfg);
  return lines.some(l => l.id === cfg?.currentLine) ? cfg.currentLine : lines[0].id;
}
export function currentLine(cfg) {
  const id = currentLineId(cfg);
  return linesOf(cfg).find(l => l.id === id);
}
/** 某条线的记录文件（故事文件夹相对） */
export function sceneFileOf(lineId) {
  return (!lineId || lineId === MAIN_LINE) ? `${SCENES_DIR}/${SCENES_FILE}` : `${SCENES_DIR}/线-${String(lineId).replace(/[^a-z0-9-]/gi, '')}.jsonl`;
}
export function newLineId() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export async function readTrophies(playAbs) {
  try {
    return (await fs.readFile(path.join(playAbs, TROPHIES_FILE), 'utf8')).split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export async function appendTrophy(playAbs, row) {
  await fs.appendFile(path.join(playAbs, TROPHIES_FILE), JSON.stringify(row) + '\n', 'utf8');
}

async function moveIfExists(from, to) {
  if (!(await exists(from))) return false;
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (await exists(to)) {
    // 目标已有：逐项搬进去（两边都是目录时），文件冲突以目标为准
    const st = await fs.stat(from);
    if (st.isDirectory()) {
      for (const e of await fs.readdir(from)) await moveIfExists(path.join(from, e), path.join(to, e));
      await fs.rm(from, { recursive: true, force: true }).catch(() => {});
      return true;
    }
    return false;
  }
  await fs.rename(from, to);
  return true;
}

/**
 * 把 09-05 下午那一版的散件收进一个文件夹：
 *   stage/stage.json → <戏>/戏.json；stage/台面.md → <戏>/台面.md；stage/scenes.jsonl → <戏>/场景/；
 *   stage/memory → <戏>/记忆；根上的 角色/ 世界书/ 预设/ 用户内容/ → <戏>/ 下同名（用户内容 → 素材）。
 * 只在根上有 stage/stage.json 且还没有任何戏文件夹时做；做完 stage/ 删掉。返回新文件夹名或 null。
 */
export async function migrateLegacyPlay(workspaceRoot) {
  const legacy = path.join(workspaceRoot, LEGACY_DIR);
  if (!(await exists(path.join(legacy, 'stage.json')))) return null;
  if ((await listPlays(workspaceRoot)).length) return null;
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(path.join(legacy, 'stage.json'), 'utf8')); } catch { /* 坏配置也搬 */ }
  const name = playFolderName(cfg.title);
  const play = path.join(workspaceRoot, name);
  await fs.mkdir(play, { recursive: true });
  await moveIfExists(path.join(legacy, '台面.md'), path.join(play, TABLE_FILE));
  await moveIfExists(path.join(legacy, 'scenes.jsonl'), path.join(play, SCENES_DIR, SCENES_FILE));
  await moveIfExists(path.join(legacy, 'memory'), path.join(play, MEMORY_DIR));
  for (const d of [ROLES_DIR, WORLD_DIR, PRESET_DIR]) await moveIfExists(path.join(workspaceRoot, d), path.join(play, d));
  await moveIfExists(path.join(workspaceRoot, '用户内容'), path.join(play, ASSETS_DIR));
  // cast 里的卡路径从 角色/… 改成 <戏>/角色/…；立绘同理
  const fix = (p) => (typeof p === 'string' && (p.startsWith(`${ROLES_DIR}/`) || p.startsWith('用户内容/'))
    ? `${name}/${p.replace(/^用户内容\//, `${ASSETS_DIR}/`)}` : p);
  const next = {
    ...cfg,
    cast: (cfg.cast || []).map(c => ({ ...c, card: fix(c.card), portrait: fix(c.portrait) })),
    migratedFrom: 'stage/', migratedAt: new Date().toISOString(),
  };
  delete next.systemPrompt;   // 台面文件是真相；没有台面文件的老戏留一份在 legacySystemPrompt
  if (cfg.systemPrompt && !(await exists(path.join(play, TABLE_FILE)))) {
    await fs.writeFile(path.join(play, TABLE_FILE), String(cfg.systemPrompt).trim() + '\n', 'utf8');
  }
  await writePlayConfig(play, next);
  await fs.rm(legacy, { recursive: true, force: true }).catch(() => {});
  return name;
}
