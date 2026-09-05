/**
 * engine/stage/mechanics.js —— 演出的机械层（2026-09-06 从 manager.js 拆出，行数棘轮）
 *
 * 这里没有编排，只有三件机械活：
 *   - 状态：把每一段 write_scene 报的 state 折成当前值（开场值来自状态面板的 initial），加一个机器补的 拍数。
 *   - 规则：状态一变就跑一遍 <故事>/规则.json（rules.js 只做比较）。成就达成 → 成就.jsonl + 弹奖杯；
 *     触发成立 → 便条接在工具返回里。
 *   - 背景：换场（write_scene 带了新的 scene）→ 后台按地点时间 + 设定里的世界描述生一张背景图。
 *     同一场景只生一次，一个故事有上限；开场那张在玩家点「开始」时就先生（opening 键），
 *     第一段到了直接顶上，之后再换场才另生。判据全是机械的（scene 字段变了），不是模型决定。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { TABLE_FILE, SCENES_DIR, BACKDROPS_DIR, readRules, readPlayConfig, writePlayConfig, appendTrophy } from './play.js';
import { evaluateRules } from './rules.js';
import { makeGenerateImageTool } from '../mcp/tools/generate-image.js';

const BACKDROPS_ON = process.env.NODESIGN_STAGE_BACKDROPS !== 'off';
const BACKDROP_MAX = Number(process.env.NODESIGN_STAGE_BACKDROP_MAX) || 12;
export const OPENING_KEY = 'opening';

export function fileUrl(pid, rel) {
  return `/api/projects/${pid}/artifact-file/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

// ───────────────────────────── 状态 ─────────────────────────────

export function foldState(cfg, scenes) {
  const s = {};
  for (const v of cfg?.vitals || []) if (v?.key && v.initial !== undefined) s[v.key] = v.initial;
  let beats = 0;
  for (const r of scenes) {
    if (r.by === 'stage') beats += 1;
    if (r.state && typeof r.state === 'object') Object.assign(s, r.state);
  }
  s['拍数'] = beats;
  return s;
}

export function stateLine(state) {
  const pairs = Object.entries(state || {}).filter(([k]) => k !== '拍数').map(([k, v]) => `${k} ${v}`);
  return pairs.length ? `此刻：${pairs.join(' · ')}（第 ${state['拍数'] || 0} 段）` : `此刻：第 ${state['拍数'] || 0} 段`;
}

// ───────────────────────────── 规则 ─────────────────────────────

/** 状态变了 → 跑规则。返回给模型看的那句（成就 / 纸条），没有就空串。 */
export async function runRules(rt, cfg) {
  const rules = await readRules(rt.playAbs);
  if (!rules.achievements.length && !rules.triggers.length) return '';
  const { trophies, notes } = evaluateRules(rules, rt.state, rt.seen);
  const parts = [];
  for (const t of trophies) {
    rt.seen.earned.add(t.id);
    const row = { ...t, at: new Date().toISOString(), beat: rt.state['拍数'] || 0 };
    await appendTrophy(rt.playAbs, row);
    rt.broadcast({ type: 'trophy', trophy: row });
    parts.push(`成就达成「${t.title}」`);
  }
  if (notes.length) {
    const fired = new Set(cfg.firedTriggers || []);
    for (const n of notes) { rt.seen.fired.add(n.id); fired.add(n.id); }
    cfg.firedTriggers = [...fired];
    await writePlayConfig(rt.playAbs, cfg);
    parts.push(...notes.map(n => `便条：${n.note}`));
  }
  return parts.length ? `【${parts.join('；')}】` : '';
}

// ───────────────────────────── 背景图 ─────────────────────────────

/** 场景键：去掉日期 / 钟点 / 标点再哈希 —— "教室 · 2022年3月1日 08:00" 和 "教室 · 08:05" 是同一个地方，别生两张 */
export function normalizeScene(scene) {
  return String(scene || '').replace(/\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}[:：]\d{2}|\d+/g, '').replace(/[\s·,，。、;；:：\-—]+/g, ' ').trim();
}
export function sceneKey(scene) {
  return crypto.createHash('sha1').update(normalizeScene(scene)).digest('hex').slice(0, 10);
}
const PLACE_RE = /地点|场景|场所|地方|位置|location|place|scene/i;
const TIME_RE = /^(时间|时刻|钟点|time)$/i;
function timeOfDay(v) {
  const m = /^(\d{1,2})[:：]\d{2}/.exec(String(v || '').trim());
  if (!m) return String(v || '').trim().slice(0, 12);
  const h = Number(m[1]);
  return h < 6 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : '夜里';
}
/**
 * 这一段在哪：优先 write_scene 的 scene 字段；模型不给（09-06 exp 真机 12 段一次都没给）就从状态值推 ——
 * 找叫"地点"那类的键，再拼上"时间"折成的时段。没有就 null（不生图）。
 */
export function sceneOf(row, state) {
  if (row?.scene && String(row.scene).trim()) return String(row.scene).trim();
  const S = state || {};
  const placeKey = Object.keys(S).find(k => PLACE_RE.test(k));
  if (!placeKey || !String(S[placeKey] || '').trim()) return null;
  const timeKey = Object.keys(S).find(k => TIME_RE.test(k));
  const tod = timeKey ? timeOfDay(S[timeKey]) : '';
  return `${String(S[placeKey]).trim()}${tod ? ` · ${tod}` : ''}`;
}

async function worldBlurb(rt) {
  const table = await fs.readFile(path.join(rt.playAbs, TABLE_FILE), 'utf8').catch(() => '');
  return (/##\s*世界\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(table)?.[1] || table).trim().slice(0, 500).replace(/\s+/g, ' ');
}

/** 真生一张。成功返回故事相对路径；失败抛错。 */
async function generateBackdrop(rt, key, scene) {
  const world = await worldBlurb(rt);
  const prompt = `A wide establishing shot of this scene, no people, no text: ${scene}. `
    + `Setting: ${world}. Soft cinematic light, painterly illustration, muted palette suitable as a reading backdrop.`;
  const gen = makeGenerateImageTool({ workspaceRoot: rt.wsRoot, ctx: rt.ctx });
  const outputName = `stage-bg-${key}`;
  const res = await gen.handler({ prompt, aspectRatio: '16:9', assetRole: 'background', outputName }, {});
  if (res?.isError) throw new Error(res.content?.[0]?.text || 'generate failed');
  const genDir = path.join(rt.wsRoot, 'assets', 'generated');
  const made = (await fs.readdir(genDir).catch(() => [])).find(f => f.startsWith(outputName) && /\.(png|jpe?g|webp)$/i.test(f));
  if (!made) throw new Error('生成了但找不到文件');
  const destRel = `${rt.root}/${SCENES_DIR}/${BACKDROPS_DIR}/${made}`;
  await fs.mkdir(path.dirname(path.join(rt.wsRoot, destRel)), { recursive: true });
  // 复制不搬：generate_image 生完还会异步给原文件做 webp/avif 变体，搬走它就报 ENOENT（09-06 真见）。原件两分钟后再删
  await fs.copyFile(path.join(genDir, made), path.join(rt.wsRoot, destRel));
  setTimeout(() => { fs.rm(path.join(genDir, made), { force: true }).catch(() => {}); for (const ext of ['webp', 'avif']) fs.rm(path.join(genDir, made.replace(/\.(png|jpe?g|webp)$/i, `.${ext}`)), { force: true }).catch(() => {}); }, 120_000).unref?.();
  return destRel;
}

async function recordBackdrop(rt, cfg, key, destRel) {
  const fresh = (await readPlayConfig(rt.playAbs)) || cfg;
  fresh.backdrops = { ...(fresh.backdrops || {}), [key]: destRel };
  await writePlayConfig(rt.playAbs, fresh);
  return fresh;
}

/** 后台生一张（有上限、同键只生一次），生完推给显示器。 */
function spawnBackdrop(rt, cfg, key, scene) {
  if (!BACKDROPS_ON || cfg.backdropsAuto === false) return false;
  if (Object.keys(cfg.backdrops || {}).length >= BACKDROP_MAX) return false;
  if (rt.genBusy) { rt.pendingBackdrop = { key, scene }; return false; }   // 正在生上一张：记着，生完接着生（之前是直接丢）
  rt.genBusy = true;
  rt.broadcast({ type: 'backdrop_pending', scene });
  (async () => {
    try {
      const destRel = await generateBackdrop(rt, key, scene);
      await recordBackdrop(rt, cfg, key, destRel);
      rt.broadcast({ type: 'backdrop', scene, file: fileUrl(rt.pid, destRel) });
    } catch (err) {
      console.warn(`[stage] ${rt.pid}/${rt.root} 背景图没生出来: ${err.message}`);
      rt.broadcast({ type: 'backdrop_failed', scene, error: err.message });
    } finally {
      rt.genBusy = false;
      const next = rt.pendingBackdrop; rt.pendingBackdrop = null;
      if (next) { const fresh = (await readPlayConfig(rt.playAbs)) || cfg; if (!fresh.backdrops?.[next.key]) spawnBackdrop(rt, fresh, next.key, next.scene); }
    }
  })();
  return true;
}

/** 玩家点「开始」：先按设定里的世界生一张开场背景，第一段到之前就有图 */
export async function pregenOpeningBackdrop(rt) {
  const cfg = (await readPlayConfig(rt.playAbs)) || {};
  if (cfg.backdrops?.[OPENING_KEY]) { rt.broadcast({ type: 'backdrop', scene: '开场', file: fileUrl(rt.pid, cfg.backdrops[OPENING_KEY]) }); return; }
  const cast = (cfg.cast || []).map(c => c.note).filter(Boolean).join('; ');
  spawnBackdrop(rt, cfg, OPENING_KEY, `the opening scene of this story${cast ? ` (${cast})` : ''}`);
}

/** 换场了：有现成的背景就推，没有就后台生一张。开场那张（opening）给第一次换场顶上。 */
/** 此刻该铺哪张背景（显示器刷新时 hello 带上）：当前场景那张，没有就开场那张 */
export function currentBackdrop(rt, cfg, scene) {
  const map = cfg?.backdrops || {};
  const rel = (scene && map[sceneKey(scene)]) || map[OPENING_KEY] || null;
  return rel ? fileUrl(rt.pid, rel) : null;
}

export async function maybeBackdrop(rt, row, cfg) {
  const scene = sceneOf(row, rt.state);
  if (!scene) return;
  const key = sceneKey(scene);
  if (rt.lastScene && sceneKey(rt.lastScene) === key) return;   // 同一个地方换了钟点不算换场
  rt.lastScene = scene;
  const map = cfg.backdrops || {};
  if (map[key]) { rt.broadcast({ type: 'backdrop', scene, file: fileUrl(rt.pid, map[key]) }); return; }
  const firstScene = (rt.state?.['拍数'] || 0) <= 1;
  if (firstScene && map[OPENING_KEY]) {
    await recordBackdrop(rt, cfg, key, map[OPENING_KEY]);
    rt.broadcast({ type: 'backdrop', scene, file: fileUrl(rt.pid, map[OPENING_KEY]) });
    return;
  }
  spawnBackdrop(rt, cfg, key, scene);
}
