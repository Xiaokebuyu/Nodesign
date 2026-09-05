/**
 * engine/stage/preset.js —— 写法预设（2026-09-06，站主要求"开始前有一个文风设置阶段"）
 *
 * 一份预设 = 一组可勾选的**模块**（文风 / 叙事 / 人物 / 篇幅 / 动笔前的思考清单…），每个模块一份 md，
 * 元数据在 preset.json（分组、默认开关、互斥）。玩家在显示器的开场页挑一套、勾选模块，选中的模块
 * 拼成系统提示词里的「写法」一节 —— 那是冻结区，改选 = 下一句话到时进程重开。
 *
 * 三种来源：
 *   1. 内置：presets/izumi（拆解自泉此方的 Izumi 0828）、presets/literary（一位 RP 写手的私人预设）。
 *   2. 用户自己的：<故事>/预设/<名>/preset.json + 模块 md，形状跟内置一样，可在显示器里改正文。
 *   3. 酒馆（SillyTavern）预设 JSON：丢进 <故事>/预设/ 或从显示器上传，这里自动拆成 2 的形状 ——
 *      每个条目一个模块、启用状态照搬、{{setvar/getvar}} 宏按顺序展开。拆一次落盘，之后跟 2 同款。
 *
 * ⛔ 酒馆预设里的破甲话术 / 输出格式 / 引擎件也会被拆成模块（我们分不出哪条是哪条），默认按原启用状态。
 *    玩家在开场页看得见每一条，不想要的取消勾选。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PRESET_DIR, exists } from './play.js';

export const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export const BUILTIN_IDS = ['izumi', 'literary'];
export const DEFAULT_PRESET = 'izumi';
export const PRESET_META = 'preset.json';

/** 读一套预设（目录里有 preset.json）。模块正文一起读进来。 */
export async function loadPreset(dirAbs, { id = null, builtin = false } = {}) {
  let meta;
  try { meta = JSON.parse(await fs.readFile(path.join(dirAbs, PRESET_META), 'utf8')); } catch { return null; }
  const modules = [];
  for (const m of meta.modules || []) {
    let text = '';
    try { text = (await fs.readFile(path.join(dirAbs, m.file), 'utf8')).trim(); } catch { /* 缺文件的模块空着 */ }
    modules.push({ ...m, text });
  }
  return {
    id: id || meta.id, name: meta.name || id || meta.id, source: meta.source || '', intro: meta.intro || '',
    builtin, dir: dirAbs, groups: meta.groups || [], modules,
  };
}

async function loadBuiltin(id) {
  return BUILTIN_IDS.includes(id) ? loadPreset(path.join(BUILTIN_DIR, id), { id, builtin: true }) : null;
}

/** 预设 id → 目录。`user:<文件夹名>` 是玩家自己的，其余是内置。 */
export async function resolvePreset(playAbs, presetId) {
  const id = String(presetId || DEFAULT_PRESET);
  if (id === 'none') return null;
  if (id.startsWith('user:')) {
    const folder = id.slice(5).replace(/[\/\\]/g, '');
    return folder ? loadPreset(path.join(playAbs, PRESET_DIR, folder), { id }) : null;
  }
  return loadBuiltin(id);
}

/**
 * 这个故事能选的预设清单（内置 + 预设/ 下的）。顺手把还没拆的酒馆 JSON 拆成文件夹。
 * 只回元数据不回正文（显示器开场页用）；正文要看走 file 接口。
 */
export async function listPresets(playAbs) {
  const out = [];
  for (const id of BUILTIN_IDS) {
    const p = await loadBuiltin(id);
    if (p) out.push(summary(p));
  }
  const dir = path.join(playAbs, PRESET_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && /\.json$/i.test(e.name)) {
      const folder = e.name.replace(/\.json$/i, '');
      if (!(await exists(path.join(dir, folder, PRESET_META)))) {
        try {
          const json = JSON.parse(await fs.readFile(path.join(dir, e.name), 'utf8'));
          const imported = importTavernPreset(json, { name: folder });
          if (imported) await saveImportedPreset(playAbs, folder, imported);
        } catch (err) { console.warn(`[stage] 预设 ${e.name} 拆不动: ${err.message}`); }
      }
    }
  }
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const p = await loadPreset(path.join(dir, e.name), { id: `user:${e.name}` });
    if (p) out.push(summary(p));
  }
  return out;
}

function summary(p) {
  return {
    id: p.id, name: p.name, source: p.source, intro: p.intro, builtin: p.builtin, groups: p.groups,
    modules: p.modules.map(({ text, ...m }) => ({ ...m, chars: text.length })),
  };
}

/** 默认勾选：每个模块的 default。 */
export function defaultSelection(preset) {
  const sel = {};
  for (const m of preset?.modules || []) sel[m.id] = !!m.default;
  return sel;
}

/**
 * 把玩家的勾选整理成合法状态：always 组全开；互斥组最多留一个（留玩家勾的第一个）；
 * 没提到的模块按 default。返回 {moduleId: bool}。
 */
export function normalizeSelection(preset, selection) {
  if (!preset) return {};
  const groups = new Map((preset.groups || []).map(g => [g.id, g]));
  const sel = { ...defaultSelection(preset), ...(selection || {}) };
  const taken = new Set();
  for (const m of preset.modules) {
    const g = groups.get(m.group);
    if (g?.always) { sel[m.id] = true; continue; }
    if (g?.exclusive && sel[m.id]) {
      if (taken.has(g.id)) sel[m.id] = false; else taken.add(g.id);
    }
    sel[m.id] = !!sel[m.id];
  }
  return sel;
}

/** 选中的模块拼成「写法」一节。返回 { text, hash, preset, picked }；没预设返回 text '' */
export async function renderStyle(playAbs, style) {
  const preset = await resolvePreset(playAbs, style?.preset);
  if (!preset) return { text: '', hash: 'none', preset: null, picked: [] };
  const sel = normalizeSelection(preset, style?.modules);
  const order = new Map((preset.groups || []).map((g, i) => [g.id, i]));
  const picked = preset.modules
    .filter(m => sel[m.id] && m.text)
    .sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99));
  const groupName = (id) => (preset.groups || []).find(g => g.id === id)?.name || id;
  const parts = picked.map(m => `### ${groupName(m.group)} · ${m.name}\n${m.text}`);
  const text = parts.length
    ? `## 写法\n玩家开场时为这个故事挑的写作规矩（预设「${preset.name}」）。跟上面设定里的文风规矩一起守；`
      + '只在两条正面冲突时以设定为准，那是为这个故事专门写的。\n\n' + parts.join('\n\n')
    : '';
  return { text, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12), preset: summary(preset), picked: picked.map(m => m.name) };
}

// ───────────────────────────── 酒馆预设 → 模块 ─────────────────────────────

const MACRO_DROP = /\{\{(random|roll|trim|date|time|lastUserMessage|lastCharMessage|newline|noop|idle_duration|pick)\b[^}]*\}\}/g;

/** 去宏：注释删、setvar 留载荷、getvar 换值、其余杂项删；酒馆的 {{user}}/{{char}} 换成我们的说法 */
export function expandMacros(text, vars) {
  let s = String(text || '');
  s = s.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
  s = s.replace(/\{\{setvar::([\s\S]*?)\}\}/g, (_m, body) => { const i = body.indexOf('::'); return i >= 0 ? body.slice(i + 2) : ''; });
  s = s.replace(/\{\{getvar::([^}]*)\}\}/g, (_m, k) => vars?.[k.trim()] ?? '');
  s = s.replace(MACRO_DROP, '');
  s = s.replace(/\{\{user\}\}/gi, '玩家的角色').replace(/\{\{char\}\}/gi, '角色');
  s = s.replace(/<user>/g, '玩家的角色');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 收集启用条目里 setvar 的值（后声明的赢），供 getvar 展开 */
function collectVars(entries) {
  const vars = {};
  for (const e of entries) {
    if (!e.enabled) continue;
    for (const m of String(e.content || '').matchAll(/\{\{setvar::([\s\S]*?)\}\}/g)) {
      const body = m[1]; const i = body.indexOf('::');
      if (i >= 0) vars[body.slice(0, i).trim()] = body.slice(i + 2);
    }
  }
  return vars;
}

const STRUCTURAL_RE = /(说明|贩子|初始化|别动|开始|结束|↓|↑|缝合处|选一|必开|过渡|二楼|加强区|尾部)/;
const GROUP_RULES = [
  [/文风|writing.?style|散文|漫改|视觉小说/i, 'voice', '文风（只选一种）', true],
  [/思维链|CoT|思考/i, 'think', '思考方式（只选一种）', true],
  [/难度/, 'difficulty', '难度（只选一种）', true],
  [/人称/, 'person', '人称（只选一种）', true],
  [/对白量/, 'dialogue', '对白占比（只选一种）', true],
  [/NSFW|nsfw|色|涩|本子|ASMR/i, 'nsfw', '成人内容', false],
  [/摘要|总结|格式|字数|前端|选项栏|弹幕|截断|防429/i, 'format', '格式与输出', false],
];

/**
 * 酒馆预设 JSON → 我们的形状。返回 { meta, files } 或 null（不像预设）。
 * 条目顺序照 prompt_order（挑 character_id 100001 那份，没有就第一份）；marker（角色描述 / 世界书 /
 * 聊天记录这些占位）跳过；纯结构条目（"文风开始""格式要求结束"）跳过；空条目跳过。
 */
export function importTavernPreset(json, { name = '导入的预设' } = {}) {
  if (!json || !Array.isArray(json.prompts)) return null;
  const byId = new Map(json.prompts.map(p => [p.identifier, p]));
  const orders = Array.isArray(json.prompt_order) ? json.prompt_order : [];
  const order = (orders.find(o => String(o.character_id) === '100001') || orders[0])?.order || json.prompts.map(p => ({ identifier: p.identifier, enabled: true }));
  const entries = order.map(o => ({ ...(byId.get(o.identifier) || {}), enabled: !!o.enabled })).filter(e => e.identifier);
  const vars = collectVars(entries);
  const groups = new Map([['misc', { id: 'misc', name: '规则条目' }]]);
  const modules = []; const files = {};
  const used = new Set();
  entries.forEach((e, idx) => {
    if (e.marker) return;
    const title = String(e.name || e.identifier || `条目 ${idx + 1}`).trim();
    if (STRUCTURAL_RE.test(title) && !/文风-|思维链-/.test(title)) return;
    const text = expandMacros(e.content, vars);
    if (text.length < 8) return;
    let gid = 'misc';
    for (const [re, id, gname, exclusive] of GROUP_RULES) {
      if (re.test(title)) { gid = id; if (!groups.has(id)) groups.set(id, { id, name: gname, exclusive }); break; }
    }
    let base = title.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40) || `entry-${idx}`;
    let file = `${base}.md`; let n = 2;
    while (used.has(file)) file = `${base}-${n++}.md`;
    used.add(file);
    files[file] = text + '\n';
    modules.push({ id: `m${idx}`, group: gid, name: title, hint: e.role && e.role !== 'system' ? `（${e.role} 角色的话）` : '', file, default: !!e.enabled });
  });
  if (!modules.length) return null;
  // 互斥组里酒馆开了不止一个的：照它的顺序留第一个
  const meta = {
    id: `user:${name}`, name, source: '从酒馆（SillyTavern）预设导入，条目原文、启用状态照搬；宏已展开。', intro: `${modules.length} 个条目，${modules.filter(m => m.default).length} 个默认启用。`,
    groups: [...groups.values()], modules,
  };
  return { meta, files };
}

/** 把拆好的预设落成 <故事>/预设/<名>/。返回目录。 */
export async function saveImportedPreset(playAbs, name, { meta, files }) {
  const folder = String(name).replace(/[\/\\]/g, '').replace(/^\.+/, '').slice(0, 60) || '导入的预设';
  const dir = path.join(playAbs, PRESET_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(dir, f), text, 'utf8');
  await fs.writeFile(path.join(dir, PRESET_META), JSON.stringify({ ...meta, id: `user:${folder}` }, null, 1), 'utf8');
  return dir;
}
