/**
 * engine/stage/create.js —— 建一个故事（open_stage 那条路）。2026-09-07 从 manager.js 拆出：
 * 行数棘轮 613 > 600，规矩是「胖了就拆，别抬上限」。
 *
 * 挑这一段拆是因为它是叶子：manager 自己一次都不调它，只有 open_stage 与 api/stage 调，
 * 所以搬出来不产生任何循环依赖（它反向 import manager 的 ensurePlays / SKINS）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkspaceRoot } from '../../projects/workspace.js';
import { getProjectBus } from '../../ws/broker.js';
import { validateCondition } from './rules.js';
import { resolveCardPath, cardHome, ROLES_DIR, CARD_FILE } from './card.js';
import { readPanels, writePanels, declarePanels } from './panels.js';
import { resolveAgentStyle } from './preset.js';
import {
  TABLE_FILE, playFolderName, readPlayConfig, writePlayConfig, writeRules,
  exists, linesOf, currentLine, adoptRootDirs,
} from './play.js';
import { ensurePlays, SKINS } from './manager.js';

/**
 * 建一个故事（open_stage 那条路）：写 台面.md / 规则.json / 戏.json，把在场者的卡搬进文件夹。
 * 同名的已存在 = 换设定重开（设定 / 规则重写，卡 / 场景 / 记忆都留着）。返回文件夹名。
 * **不起进程**：进程在玩家点「开始」或说第一句话时才起（09-06 起，之前 open_stage 一调就先烧 400MB）。
 */
export async function createPlay(pid, { title, table, cast, vitals, skin, rules, model, style, panels, opening, lore, images } = {}) {
  const ws = getWorkspaceRoot(pid);
  await ensurePlays(pid);
  const root = playFolderName(title);
  const playAbs = path.join(ws, root);
  await fs.mkdir(playAbs, { recursive: true });
  if (table) await fs.writeFile(path.join(playAbs, TABLE_FILE), String(table).trim() + '\n', 'utf8');
  if (rules) {
    for (const r of [...(rules.achievements || []), ...(rules.triggers || [])]) {
      const bad = validateCondition(r.when);
      if (bad) throw Object.assign(new Error(`规则「${r.id || r.title || '?'}」的条件不合法：${bad}`), { status: 400 });
    }
    await writeRules(playAbs, { achievements: rules.achievements || [], triggers: rules.triggers || [] });
  }
  const stored = (await readPlayConfig(playAbs)) || {};
  if (Array.isArray(panels) && panels.length) await writePanels(playAbs, declarePanels(await readPanels(playAbs), panels));
  const castOut = [];
  for (const c of cast || []) {
    const name = String(c?.name || c || '').trim();
    if (!name) continue;
    let rel = await resolveCardPath(ws, name, { playRoot: root });
    if (!rel) throw Object.assign(new Error(`没有「${name}」的角色卡（${ROLES_DIR}/${name}/${CARD_FILE}）：先用 cast_role 写卡再开`), { status: 409 });
    // 卡在根上的 角色/ 里 → 整个家搬进故事的文件夹（卡 / 记忆 / 立绘一起），文件夹才自成一体
    if (!rel.startsWith(`${root}/`)) {
      const home = cardHome(rel);
      const dest = path.join(root, ROLES_DIR, path.basename(home));
      if (!(await exists(path.join(ws, dest)))) {
        await fs.mkdir(path.dirname(path.join(ws, dest)), { recursive: true });
        await fs.rename(path.join(ws, home), path.join(ws, dest));
        rel = path.join(dest, CARD_FILE);
      }
    }
    castOut.push({ name, card: rel, ...(c?.note ? { note: String(c.note).slice(0, 60) } : {}) });
  }
  await adoptRootDirs(ws, root);   // 根上的 世界书/ 预设/ 随开戏搬进故事文件夹（09-07 B1/C1）
  const next = {
    ...stored,
    title: String(title || stored.title || root).slice(0, 60),
    cast: castOut.length ? castOut : (stored.cast || []),
    vitals: Array.isArray(vitals) ? vitals : (stored.vitals || []),
    skin: SKINS.includes(skin) ? skin : (stored.skin || 'paper'),
    model: model || stored.model || null,
    ...(opening ? { opening: String(opening).slice(0, 6000) } : {}),   // 酒馆卡的开场白 / 场景，开场指令带给进程当底
    ...(lore?.off?.length ? { lore: { off: lore.off.map(String).slice(0, 500), by: 'agent' } } : {}),
    ...(typeof images === 'boolean' ? { images: { allow: images, by: 'agent' } } : {}),   // 演出进程能不能配图（玩家开场页还能改）   // agent 按玩家回答预先关掉的世界书条目（开场页能改）
    lines: linesOf(stored),
    currentLine: currentLine(stored).id,
    startedAt: stored.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (style?.preset) next.style = await resolveAgentStyle(playAbs, style);   // agent 的预选：差量存 style.agent，开场页逐个标出来；预设对不上会抛 409（09-07 D2）
  delete next.systemPrompt;
  await writePlayConfig(playAbs, next);
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: false });
  return root;
}
