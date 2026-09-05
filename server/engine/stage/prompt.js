/**
 * engine/stage/prompt.js —— 演出进程的系统提示词从文件拼（2026-09-05 晚，从 manager.js 拆出）
 *
 * 台面（<戏>/台面.md）+ 每张在场者的卡（人写正文 + 机器块里的记忆索引）+ 这场戏的记忆索引 + 几句工具提醒。
 * 顺手记下每份来源文件的 mtime（manager 盯着它决定要不要重开）和卡上读到的名字 / 小字 / 立绘。
 * 纯读，不写盘。老形状（戏.json 里直接存 systemPrompt、没有台面文件）还认。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { readMemoryIndex } from './tools.js';
import { resolveCardPath, readCardForStage, cardHome } from './card.js';
import { TABLE_FILE, MEMORY_DIR, WORLD_DIR, PRESET_DIR, exists } from './play.js';

async function statRel(base, rel) {
  try { return (await fs.stat(path.join(base, rel))).mtimeMs; } catch { return null; }
}

/** @returns {{ text: string, sources: Array<{rel, mtimeMs}>, cast: Array }} */
export async function composeStagePrompt(wsRoot, root, stored) {
  const playAbs = path.join(wsRoot, root);
  const sources = [];
  const parts = [];
  let table = null;
  try { table = (await fs.readFile(path.join(playAbs, TABLE_FILE), 'utf8')).trim(); } catch { /* 没有台面文件 */ }
  if (table) {
    sources.push({ rel: `${root}/${TABLE_FILE}`, mtimeMs: await statRel(wsRoot, `${root}/${TABLE_FILE}`) });
    parts.push(table);
  } else if (stored?.systemPrompt) {
    parts.push(String(stored.systemPrompt).trim());
  } else {
    throw Object.assign(new Error(`这场戏没有台面（${root}/${TABLE_FILE}）：先让 agent 用 open_stage 把世界和规矩交过来`), { status: 409 });
  }

  const cast = [];
  const cardTexts = [];
  for (const c of (stored?.cast || [])) {
    const rel = (c.card && await exists(path.join(wsRoot, c.card))) ? c.card : await resolveCardPath(wsRoot, c.name, { playRoot: root });
    if (!rel) { cast.push({ name: c.name, note: c.note || '', portrait: c.portrait || null, card: null }); continue; }
    let card;
    try { card = await readCardForStage(wsRoot, rel); } catch { cast.push({ name: c.name, note: c.note || '', portrait: null, card: rel }); continue; }
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
    cast.push({ name: card.name || c.name, note: c.note || card.note || '', portrait, card: rel });
    cardTexts.push(`### ${card.name || c.name}（卡在 ${rel}）\n${card.text}`);
  }
  if (cardTexts.length) {
    parts.push(`## 人物\n下面每个人一段，是他们各自的角色卡原文。开口前拿不准腔调就 Read 一遍他的卡。\n\n${cardTexts.join('\n\n')}`);
  }
  const idx = await readMemoryIndex(playAbs);
  if (idx && idx.trim()) parts.push(`## 这场戏记住的事\n${idx.trim()}\n\n索引里的正文要用时自己 Read（在 ${root}/${MEMORY_DIR}/ 下）。`);
  const extra = [];
  for (const d of [WORLD_DIR, PRESET_DIR]) if (await exists(path.join(playAbs, d))) extra.push(`${root}/${d}/`);
  parts.push(
    '## 台面\n'
    + '每一拍都用 write_scene 写到台上（正文 + 2-4 枚把手 + state：改了哪些状态值，没变就传空数组）。'
    + '不可逆的变化用 remember 记一条：某个人记得的事带 who 写进他的卡，这场戏的事不带。掷骰用 roll。'
    + '你的工具就这几件，不用 ToolSearch 去找别的。'
    + (extra.length ? `设定的细节在 ${extra.join(' 和 ')}，用到时 Grep / Read。` : '')
    + '每句话末尾会带一行「此刻：…」是机器报的当前状态值；【场务纸条】是规则表到了阈值，照它说的推。'
    + '**正文之外不要再复述剧情** —— 台上只认 write_scene 写进去的东西，你在工具之外说的话观众看不见。',
  );
  return { text: parts.join('\n\n'), sources, cast };
}

