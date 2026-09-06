#!/usr/bin/env node
/**
 * server/scripts/gen-presets-doc.mjs —— 把内置写法预设的模块表写进 stage-setup/SKILL.md（2026-09-06）
 *
 * 主循环预选写法（open_stage.style.on / off）时看的表，唯一真相源是 presets/<id>/preset.json：
 * 模块的 id / 名字 / hint（它管什么）/ cue（玩家大概会怎么说）/ 默认开关 / 分组。
 * 之前那张表是手抄的 presets.md（要 agent 自己再 Read 一次，且文学派两个模块连说明都没有）；
 * 现在由这里生成、直接嵌进 SKILL.md 的两个标记之间，skill 一加载表就在上下文里。
 * presets-doc.lint.test.js 钉着：SKILL.md 里那一段必须等于本脚本此刻的输出 —— 改了 preset.json 就跑一遍：
 *   node server/scripts/gen-presets-doc.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRESETS_DIR = path.join(HERE, '../engine/stage/presets');
export const SKILL_FILE = path.join(HERE, '../engine/plugins/nodesign/skills/stage-setup/SKILL.md');
export const START = '<!-- presets:gen:start -->';
export const END = '<!-- presets:gen:end -->';
const IDS = ['izumi', 'literary'];

const readMeta = (id) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, id, 'preset.json'), 'utf8'));

/** 一个模块的 cue → 表里一行。cue 以「（关）」开头的是关掉这个模块；「（默认）」开头的是默认已开、不用传 */
function cueRow(m, presetId) {
  const off = /^（关）/.test(m.cue); const dflt = /^（默认）/.test(m.cue);
  const say = m.cue.replace(/^（关）|^（默认）/, '');
  const act = dflt ? `\`${m.id}\` 默认已开，不用传` : off ? `\`off: ["${m.id}"]\`` : `\`on: ["${m.id}"]\``;
  return `| ${say} | ${act}${presetId === 'izumi' ? '' : `（预设 \`${presetId}\`）`} |`;
}

export function renderPresetsDoc() {
  const metas = IDS.map(id => [id, readMeta(id)]);
  const out = [];
  out.push('# 写法预设的模块表（机器从 preset.json 生成，⛔ 别手改；改了 preset.json 就跑 `node server/scripts/gen-presets-doc.mjs`）', '');
  out.push('`open_stage.style = { preset, on: [...], off: [...] }`：`on` 在默认勾选之上加开，`off` 关掉。互斥组（★）里开一个，机器自动关掉同组默认的；总是开的组（●）关不掉。',
    '开场页会把你动过的每个开关标成「agent 预选」，玩家能改，改了以他的为准。**他没说的组别动，不传。**', '');
  out.push('## 他说的话 → 该动哪个开关', '', '| 他大概会说 | 动作 |', '|---|---|');
  for (const [id, meta] of metas) for (const m of meta.modules) if (m.cue) out.push(cueRow(m, id));
  out.push('| 像轻小说 / 像武侠 / 像网文 / 像金庸 / 像广播剧… | `on: ["voice-<id>"]`，文风组里挑最像的一个（见下表），只开一个 |');
  out.push('| 想要更文学的质地 / 长句 / 不要比喻 | `preset: "literary"`（文学派整套换掉 Izumi） |');
  out.push('| 他交了自己的酒馆预设 JSON | 文件放 `<故事>/预设/<名>.json`，`preset: "user:<名>"`，⛔ 别传 on/off（条目 id 拆出来才有） |');
  out.push('| 别替我说话 / 我的角色我自己来 | 这是代笔档，写进设定「规矩」，不动预设 |');
  out.push('| 难度 / 世界顺不顺着他 | 写进设定「规矩」，不动预设 |', '');
  for (const [id, meta] of metas) {
    out.push(`## \`${id}\` · ${meta.name}`, '', meta.intro, '');
    const byGroup = new Map();
    for (const m of meta.modules) { if (!byGroup.has(m.group)) byGroup.set(m.group, []); byGroup.get(m.group).push(m); }
    for (const g of meta.groups) {
      const mods = byGroup.get(g.id); if (!mods) continue;
      out.push(`### ${g.name}${g.always ? ' ●' : g.exclusive ? ' ★' : ''}`);
      for (const m of mods) out.push(`- \`${m.id}\` ${m.name} — ${m.hint}${m.default ? '（默认开）' : ''}`);
      out.push('');
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

/** 把生成的表嵌进 SKILL.md 两个标记之间；返回新全文（不写盘） */
export function spliceIntoSkill(skillText, doc) {
  const a = skillText.indexOf(START); const b = skillText.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error(`SKILL.md 里缺标记 ${START} … ${END}`);
  return skillText.slice(0, a + START.length) + '\n' + doc + skillText.slice(b);
}

/** SKILL.md 里标记之间现在是什么（lint 用） */
export function currentSkillSection(skillText) {
  const a = skillText.indexOf(START); const b = skillText.indexOf(END);
  return a < 0 || b < 0 ? null : skillText.slice(a + START.length + 1, b);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const skill = fs.readFileSync(SKILL_FILE, 'utf8');
  fs.writeFileSync(SKILL_FILE, spliceIntoSkill(skill, renderPresetsDoc()), 'utf8');
  console.log('SKILL.md 的写法预设表已更新');
}
