/**
 * engine/stage/opening.js —— 引导开场（2026-09-06）
 *
 * 之前的显示器打开就是一个空输入框，玩家得自己说第一句。现在有一个开场页：看世界与人物、挑写法预设、
 * 勾角色卡上的可选条目，然后点「开始」。「开始」做三件事：
 *   1. 把写法 / 可选条目写进 戏.json（它们是系统提示词的一部分，冻结区）；
 *   2. 起进程，先按设定里的世界生一张开场背景（第一段到之前就有图）；
 *   3. 给进程发第一条消息 —— 机器写的开场指令，记录里落成一行 by:'system'（显示器画成一道分隔线，不是"你"说的话）。
 *
 * 开场指令借了 Izumi 预设的路子：先在思考里过一遍此刻的时间 / 地点 / 谁在场 / 各自知道什么，再从一个具体
 * 时刻切入，让人物带着自己的事出现，结尾停在别人的动作或一句话上，把下一步留给玩家，不总结不抒情。
 */

import { runtimeOf, loadConfig, sayToStage, patchStageConfig } from './manager.js';
import { readScenes } from './tools.js';
import { pregenOpeningBackdrop } from './mechanics.js';
import { resolvePreset, normalizeSelection, importTavernPreset, saveImportedPreset, DEFAULT_PRESET, PRESET_META } from './preset.js';

function kickoffText(cfg, { presetName, picked, castOptions, castNames }) {
  const vitals = (cfg.vitals || []).filter(v => v.initial !== undefined).map(v => `${v.key} = ${v.initial}`).join('，');
  const opts = Object.entries(castOptions || {}).filter(([, on]) => on).map(([k]) => k.split('/').pop());
  return [
    '【开场】故事从这里开始。这是第一段，按下面的顺序写：',
    '1. 先在你自己的思考里过一遍：现在是什么时候、在哪、谁在场、彼此是什么关系、每个人此刻知道什么；玩家扮演的是谁（设定里写了）。',
    '2. 正文从一个具体的时刻切入：光线、声音、气味里挑两三样落实，让人一眼看见地方和时候；让在场的人带着自己的事出现，别等玩家开口。',
    '3. 结尾停在别人的一个动作或一句话上，把接下来怎么办留给玩家；不写总结，不抒情，不替玩家的角色做任何决定。',
    `4. write_scene 里带上 scene（一句话的地点和时间）、speakers、state（开场值${vitals ? `：${vitals}` : '照设定'}），choices 两到四枚。`,
    `玩家开场时选的：写法预设「${presetName}」${picked?.length ? `（${picked.join(' / ')}）` : ''}${opts.length ? `；角色卡可选条目启用了：${opts.join('、')}` : ''}${castNames?.length ? `。在场：${castNames.join('、')}` : ''}。`,
    ...(cfg.opening ? [`开场参考（原卡的开场白 / 场景，照它的地点、时刻、气氛和头几句来写，不照抄；{{user}} 之类的占位符是玩家的角色）：\n${String(cfg.opening).slice(0, 6000)}`] : []),
  ].join('\n');
}

/**
 * 玩家点「开始」。style = {preset, modules}；cardOptions = {"<名>/<optId>": bool}。
 * 已经有记录的故事（改完写法再点）只存设置不再发开场指令。
 */
export async function openStory(pid, root, { style = null, cardOptions = null, lore = null, userId = null } = {}) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  const presetId = style?.preset || cfg.style?.preset || DEFAULT_PRESET;
  const preset = await resolvePreset(rt.playAbs, presetId);
  const modules = preset ? normalizeSelection(preset, style?.modules ?? cfg.style?.modules) : null;
  const pub = await patchStageConfig(pid, root, { style: { preset: preset ? presetId : 'none', modules }, cardOptions: cardOptions || cfg.cardOptions || {}, ...(lore ? { lore } : {}), opened: true });
  const scenes = await readScenes(rt.playAbs, { limit: 5, rel: rt.scenesRel });
  if (scenes.length) return { ok: true, started: false, config: pub };

  const picked = preset ? preset.modules.filter(m => modules[m.id] && m.group !== 'core').map(m => m.name) : [];
  const text = kickoffText(cfg, { presetName: preset?.name || '不用预设', picked, castOptions: cardOptions, castNames: (cfg.cast || []).map(c => c.name) });
  const rowText = `故事开始了 · 写法：${preset?.name || '不用预设'}${picked.length ? ` · ${picked.slice(0, 6).join(' / ')}${picked.length > 6 ? ' …' : ''}` : ''}`;
  const r = await sayToStage(pid, root, text, { userId, row: { by: 'system', text: rowText, extra: { kind: 'opening' } } });
  pregenOpeningBackdrop(rt).catch(() => {});
  return { ok: true, started: true, ...r };
}

/** 玩家在开场页上传预设：酒馆 JSON 或我们自己的形状（有 groups + modules）。返回预设 id。 */
export async function uploadPreset(pid, root, { name, data }) {
  const rt = runtimeOf(pid, root);
  const clean = String(name || '').replace(/\.json$/i, '').replace(/[\/\\]/g, '').trim().slice(0, 60) || '上传的预设';
  let json = data;
  if (typeof json === 'string') { try { json = JSON.parse(json); } catch { throw Object.assign(new Error('不是合法的 JSON'), { status: 400 }); } }
  if (json && Array.isArray(json.modules) && Array.isArray(json.groups)) {
    const files = {};
    const meta = { ...json, id: `user:${clean}`, name: json.name || clean, modules: json.modules.map((m, i) => { const file = m.file || `${String(m.name || m.id || i).replace(/[^\p{L}\p{N}_-]/gu, '')}.md`; files[file] = String(m.text || '') + '\n'; const { text, ...rest } = m; return { ...rest, file }; }) };
    await saveImportedPreset(rt.playAbs, clean, { meta, files });
    return { ok: true, id: `user:${clean}` };
  }
  const imported = importTavernPreset(json, { name: clean });
  if (!imported) throw Object.assign(new Error('看不出这是哪种预设：要么是酒馆（SillyTavern）的预设 JSON，要么是本平台的（含 groups 和 modules）'), { status: 400 });
  await saveImportedPreset(rt.playAbs, clean, imported);
  return { ok: true, id: `user:${clean}`, modules: imported.meta.modules.length, metaFile: PRESET_META };
}
