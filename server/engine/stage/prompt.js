/**
 * engine/stage/prompt.js —— 演出进程的系统提示词从文件拼（2026-09-05 晚，从 manager.js 拆出；09-06 加写法与可选条目）
 *
 * 台面（<故事>/台面.md）+ 每张在场者的卡（人写正文 + 机器块里的记忆索引 + 玩家开场勾的可选条目）
 * + 这个故事的记忆索引 + 玩家挑的写法预设（preset.js）+ 几句工具提醒。
 * 顺手记下每份来源文件的 mtime（manager 盯着它决定要不要重开）和卡上读到的名字 / 小字 / 立绘 / 可选条目。
 * 纯读，不写盘。老形状（戏.json 里直接存 systemPrompt、没有台面文件）还认。
 *
 * 整份都是冻结区：每轮原样重发、命中缓存几乎不要钱。每轮会变的（当前状态值、便条）走消息体。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { readMemoryIndex } from './tools.js';
import { resolveCardPath, readCardForStage, cardHome } from './card.js';
import { TABLE_FILE, MEMORY_DIR, WORLD_DIR, PRESET_DIR, exists } from './play.js';
import { renderStyle } from './preset.js';
import { readPanels } from './panels.js';

async function statRel(base, rel) {
  try { return (await fs.stat(path.join(base, rel))).mtimeMs; } catch { return null; }
}

/** 写法 + 可选条目的指纹：这两样不在磁盘文件的 mtime 里，manager 拿它判断要不要重开 */
export function frozenHash(cfg) {
  return crypto.createHash('sha1').update(JSON.stringify({ style: cfg?.style || null, cardOptions: cfg?.cardOptions || null })).digest('hex').slice(0, 12);
}

/** 卡上的可选条目 × 玩家的勾选 → 一句给模型看的话（没有可选条目返回 ''） */
function optionsLine(name, options, cardOptions) {
  if (!options?.length) return '';
  const on = []; const off = [];
  for (const o of options) {
    const v = cardOptions?.[`${name}/${o.id}`];
    const enabled = v === undefined ? !!o.default : !!v;
    (enabled ? on : off).push(o.desc ? `${o.label}（${o.desc}）` : o.label);
  }
  return `\n\n**玩家开场时对这张卡「可选」一节的选择**：${on.length ? `启用 ${on.join('、')}` : '一条都没启用'}${off.length ? `；不启用 ${off.join('、')}` : ''}。没启用的当它不存在。`;
}

/** @returns {{ text: string, sources: Array<{rel, mtimeMs}>, cast: Array, styleNames: string[], hash: string }} */
export async function composeStagePrompt(wsRoot, root, stored) {
  const playAbs = path.join(wsRoot, root);
  const sources = [];
  const parts = [];
  let table = null;
  try { table = (await fs.readFile(path.join(playAbs, TABLE_FILE), 'utf8')).trim(); } catch { /* 没有设定文件 */ }
  if (table) {
    sources.push({ rel: `${root}/${TABLE_FILE}`, mtimeMs: await statRel(wsRoot, `${root}/${TABLE_FILE}`) });
    parts.push(table);
  } else if (stored?.systemPrompt) {
    parts.push(String(stored.systemPrompt).trim());
  } else {
    throw Object.assign(new Error(`这个故事还没有设定文件（${root}/${TABLE_FILE}）：先让 agent 用 open_stage 把世界和规矩交过来`), { status: 409 });
  }

  const cast = [];
  const cardTexts = [];
  for (const c of (stored?.cast || [])) {
    const rel = (c.card && await exists(path.join(wsRoot, c.card))) ? c.card : await resolveCardPath(wsRoot, c.name, { playRoot: root });
    if (!rel) { cast.push({ name: c.name, note: c.note || '', portrait: c.portrait || null, card: null, options: [] }); continue; }
    let card;
    try { card = await readCardForStage(wsRoot, rel); } catch { cast.push({ name: c.name, note: c.note || '', portrait: null, card: rel, options: [] }); continue; }
    sources.push({ rel, mtimeMs: await statRel(wsRoot, rel) });
    // 立绘：卡 frontmatter 写的相对卡所在目录 / 工作区都认；没写就找同目录的 立绘.*
    let portrait = card.portrait || c.portrait || null;
    if (portrait && !(await exists(path.join(wsRoot, portrait)))) {
      const alt = path.join(cardHome(rel), portrait);
      portrait = (await exists(path.join(wsRoot, alt))) ? alt : null;
    }
    if (!portrait) {
      const home = path.join(wsRoot, cardHome(rel));
      const pic = (await fs.readdir(home).catch(() => [])).find(f => /^立绘\.(png|jpe?g|webp)$/i.test(f));
      if (pic) portrait = `${cardHome(rel)}/${pic}`;
    }
    const name = card.name || c.name;
    cast.push({ name, note: c.note || card.note || '', portrait, card: rel, options: card.options || [] });
    cardTexts.push(`### ${name}（卡在 ${rel}）\n${card.text}${optionsLine(name, card.options, stored?.cardOptions)}`);
  }
  if (cardTexts.length) {
    parts.push(`## 人物\n下面每个人一段，是他们各自的角色卡原文。开口前拿不准腔调就 Read 一遍他的卡。\n\n${cardTexts.join('\n\n')}`);
  }
  const idx = await readMemoryIndex(playAbs);
  if (idx && idx.trim()) parts.push(`## 这个故事记住的事\n${idx.trim()}\n\n索引里的正文要用时自己 Read（在 ${root}/${MEMORY_DIR}/ 下）。`);

  const style = await renderStyle(playAbs, stored?.style);
  if (style.text) parts.push(style.text);

  const panels = Object.values(await readPanels(playAbs));
  if (panels.length) {
    const KN = { inventory: '背包', equipment: '装备', shop: '商店', list: '清单' };
    parts.push('## 面板\n这个故事有这几块清单，数量账全在这里记、不进正文：\n'
      + panels.map(p => `- **${p.name}**（${KN[p.kind] || p.kind}${p.who ? `，${p.who} 的` : ''}${p.kind === 'equipment' ? `，槽位 ${(p.slots || []).join(' / ')}` : ''}${p.kind === 'shop' && p.currency ? `，用「${p.currency}」结账，买到的进 ${p.into || '背包'}` : ''}）`).join('\n')
      + '\n得到、用掉、穿上、标价、卖出，**先 update_panel 再 write_scene**（write_scene 一返回这一轮就结束）。玩家自己在显示器里买了、用了东西，会以【便条】告诉你，你在正文里接住就行。每句话末尾「面板：…」是机器报的现况。');
  }
  const extra = [];
  for (const d of [WORLD_DIR, PRESET_DIR]) if (await exists(path.join(playAbs, d))) extra.push(`${root}/${d}/`);
  parts.push(
    '## 怎么把字写到台上\n'
    + '每一段都用 write_scene 写到台上（正文 + 2-4 枚选项 + state：改了哪些状态值，没变就传空数组）。**write_scene 一返回这一轮就结束**，所以要记的（remember）、要掷的（roll）都在它之前做。'
    + '不可逆的变化用 remember 记一条：某个人记得的事带 who 写进他的卡，这个故事的事不带。掷骰用 roll。'
    + '你的工具就这几件，不用 ToolSearch 去找别的。'
    + (extra.length ? `设定的细节在 ${extra.join(' 和 ')}，用到时 Grep / Read。` : '')
    + '每句话末尾会带一行「此刻：…」是机器报的当前状态值；【便条】是规则表到了阈值，照它说的推；'
    + '【世界书 · 某条】是机器按这句话和上一段里的关键词从世界书里挑出来的设定原文，写这一段时照它来，不用再去 Grep 同一条。\n\n'
    + '⛔ **write_scene 返回之后这一轮就结束了，不要再在工具之外说任何话。**工具之外的字观众看不见，'
    + '而且那些话里常常漏出数值（"好感度 +2""好感度 17"）—— 数值只走 state，绝不进正文，也绝不写在工具之外。'
    + '正文里同样不出现任何状态数字、不写括号里的舞台指令、不复述玩家刚说的话之外的东西。',
  );
  return { text: parts.join('\n\n'), sources, cast, styleNames: style.picked, hash: frozenHash(stored) };
}
