/**
 * engine/stage/manager.js —— 演出进程的起停、直投、计量、广播（2026-09-05；当晚改成一场戏一个文件夹）
 *
 * 一场戏 = 工作区根下的一个文件夹（布局见 play.js），一个项目可以有几场。这里攥着每场的
 * StageRuntime：进程本体、SSE 订户、计量上下文、空闲计时、当前状态、规则表的"已达成"。
 *
 * ## 这条路上没有主 agent
 *
 * 用户在显示器里点一枚把手 / 说一句话 → api/stage.js → sayToStage → 进程队列。
 * 主 agent 只在开戏时出场一次（open_stage：写台面 + 规则、把在场者的卡搬进文件夹），之后退到场务位。
 * 台上写出来的每一拍由 write_scene 落盘（场景/scenes.jsonl），这里顺手推给所有订户。
 *
 * ## 系统提示词从文件拼（prompt.js）
 *
 * 台面（<戏>/台面.md）+ 每张在场者的卡（人写正文 + 机器块里的记忆索引）+ 这场戏的记忆索引 + 几句工具提醒。
 * 拼的时候记下每份来源文件的 mtime；用户改了卡或台面，下一句话到时先重开再说（那一句慢十秒）。
 * 进程自己重写卡上的索引块**不算改**（onCardTouched 把 mtime 跟上），否则每记一条下一句就重开、缓存整份重付。
 *
 * ## 机械层（不是编排）
 *
 *   - 状态：每拍 write_scene 的 state 折进当前值（开场值来自状态面板的 initial），加一个机器补的 拍数。
 *     下一句话的尾巴带一行当前值，模型每拍都看得见自己上一拍改了什么。
 *   - 规则：状态一变就跑一遍 <戏>/规则.json（rules.js 只做比较）。成就达成 → 成就.jsonl + 弹奖杯；
 *     触发成立 → 场务纸条接在工具返回里（模型下一拍就知道阈值到了）。
 *   - 背景：write_scene 带了新的 scene（换场）→ 后台按地点时间 + 台面里的世界描述生一张背景图，
 *     生完推给显示器。同一场景只生一次，一场戏有上限。判据是机械的（scene 字段变了），不是模型决定。
 *
 * ## 进程是贵的，所以三条纪律
 *
 *   1. 同时在跑的场数封顶（NODESIGN_STAGE_MAX，默认 2）：一个 SDK 子进程 300-500MB。满了报 503。
 *   2. 空闲自停（NODESIGN_STAGE_IDLE_MS，默认 30 分钟）；下一句话到了自动再起，用户感知"第一句慢一点"。
 *   3. 每一句一条 run：createRun(skillId:'stage') → absorbResult 差分 → runs + run_model_usage（日限闸门读它）。
 *
 * ## 通路跟主循环同一张表
 * 订阅模型不注 API key（owner 得有 subscription 资格）；API 模型 BASE_URL 指进程内 ingress。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto, { randomUUID } from 'node:crypto';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { StageSession } from './session.js';
import { createStageTools, readMemoryIndex, readScenes, appendUserLine, appendSceneRow, listMemories } from './tools.js';
import { resolveCardPath, cardHome, ROLES_DIR, CARD_FILE } from './card.js';
import {
  TABLE_FILE, SCENES_DIR, BACKDROPS_DIR,
  isPlayDir, playFolderName, listPlays, readPlayConfig, writePlayConfig, readRules, writeRules, readTrophies, appendTrophy,
  migrateLegacyPlay, exists,
} from './play.js';
import { evaluateRules, validateCondition } from './rules.js';
import { composeStagePrompt } from './prompt.js';
export { composeStagePrompt };
import { getProject } from '../../projects/store.js';
import { getWorkspaceRoot } from '../../projects/workspace.js';
import { getProjectBus } from '../../ws/broker.js';
import { getBuiltinPluginsRoot } from '../agent/plugin-loader.js';
import { defaultModel } from '../agent/session-model.js';
import { resolveModelRoute, resolveSdkSpoofModel, pickThinkingConfig } from '../agent/model-context.js';
import { getOrStartIngress, registerIngressSession, unregisterIngressSession } from '../../lib/model-ingress.js';
import { AgentContext, freshTurnCounters } from '../agent/context.js';
import { createRun, markRunStarted, markRunSucceeded, markRunFailed, setRunMetrics, setRunModelUsage } from '../runs/store.js';
import { can } from '../../auth/tier.js';
import { getUserById } from '../../auth/users-store.js';
import { platform } from '../../runtime/platform.js';
import { makeGenerateImageTool } from '../mcp/tools/generate-image.js';

const MAX_RUNNING = Number(process.env.NODESIGN_STAGE_MAX) || 2;
const IDLE_MS = Number(process.env.NODESIGN_STAGE_IDLE_MS) || 30 * 60_000;
const BACKDROPS_ON = process.env.NODESIGN_STAGE_BACKDROPS !== 'off';
const BACKDROP_MAX = Number(process.env.NODESIGN_STAGE_BACKDROP_MAX) || 12;
const STAGE_SKILLS = ['story-voice', 'story-craft', 'story-intimacy'];
export const SKINS = ['paper', 'jiangnan', 'night', 'terminal'];
export { TABLE_FILE };

/** @type {Map<string, StageRuntime>} */
const runtimes = new Map();
const keyOf = (pid, root) => `${pid} ${root}`;

class StageRuntime {
  constructor(pid, root) {
    this.pid = pid;
    this.root = root;
    this.wsRoot = getWorkspaceRoot(pid);
    this.playAbs = path.join(this.wsRoot, root);
    this.session = null;
    this.sdkSid = null;
    this.ingressRegistered = false;
    this.ctx = null;
    this.pendingRuns = [];
    this.subscribers = new Set();
    this.idleTimer = null;
    this.live = '';            // 工具之外流出来的字（观众当旁白看）
    this.thinking = '';        // 这一拍的思考流
    this.blocks = new Map();   // 流中的工具块 index → { name, json }
    this.draft = '';           // write_scene 正在写的正文（partial-json 解出来的）
    this.error = null;
    this.startedAt = null;
    this.sources = [];         // 进了系统提示词的文件 [{rel, mtimeMs}]
    this.promptChars = 0;
    this.state = {};           // 折好的当前状态
    this.seen = { earned: new Set(), fired: new Set() };
    this.pendingNotes = [];    // 用户拨状态触发的纸条，随下一句话带过去
    this.lastUsage = null;
    this.lastScene = null;
    this.genBusy = false;
  }

  get running() { return !!this.session?.running; }
  get busy() { return !!this.session?.busy; }

  broadcast(evt) {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.subscribers) {
      try { res.write(line); } catch { this.subscribers.delete(res); }
    }
  }

  status() {
    return {
      type: 'status', root: this.root,
      running: this.running, busy: this.busy, queued: this.session?.queued || 0,
      error: this.error, startedAt: this.startedAt, usage: this.lastUsage, state: this.state,
    };
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (!this.running) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.session?.queued) { this.touch(); return; }
      stopStage(this.pid, this.root, 'idle').catch(() => {});
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }
}

export function runtimeOf(pid, root) {
  const k = keyOf(pid, root);
  let rt = runtimes.get(k);
  if (!rt) { rt = new StageRuntime(pid, root); runtimes.set(k, rt); }
  return rt;
}
export function getStageRuntime(pid, root) { return runtimes.get(keyOf(pid, root)) || null; }
export function runningStages() { return [...runtimes.values()].filter(r => r.running).length; }

function fileUrl(pid, rel) {
  return `/api/projects/${pid}/artifact-file/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}
export async function statRel(base, rel) {
  try { return (await fs.stat(path.join(base, rel))).mtimeMs; } catch { return null; }
}

/** 老形状收进文件夹（幂等）。返回这个项目所有戏的文件夹名。 */
export async function ensurePlays(pid) {
  const ws = getWorkspaceRoot(pid);
  const migrated = await migrateLegacyPlay(ws);
  if (migrated) {
    console.log(`[stage] ${pid} 老形状 stage/ 已收进文件夹「${migrated}」`);
    getProjectBus(pid).publish({ type: 'stage.changed', root: migrated, running: false });
  }
  return listPlays(ws);
}

// ───────────────────────────── 状态 / 规则 ─────────────────────────────

function foldState(cfg, scenes) {
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

function stateLine(state) {
  const pairs = Object.entries(state || {}).filter(([k]) => k !== '拍数').map(([k, v]) => `${k} ${v}`);
  return pairs.length ? `此刻：${pairs.join(' · ')}（第 ${state['拍数'] || 0} 拍）` : `此刻：第 ${state['拍数'] || 0} 拍`;
}

/** 状态变了 → 跑规则。返回给模型看的那句（成就 / 纸条），没有就空串。 */
async function runRules(rt, cfg) {
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
    parts.push(...notes.map(n => `场务纸条：${n.note}`));
  }
  return parts.length ? `【${parts.join('；')}】` : '';
}

// ───────────────────────────── 背景图 ─────────────────────────────

function sceneKey(scene) {
  return crypto.createHash('sha1').update(String(scene).trim()).digest('hex').slice(0, 10);
}

/** 换场了：有现成的背景就推，没有就后台生一张（有上限、同场景只生一次） */
async function maybeBackdrop(rt, row, cfg) {
  const scene = String(row.scene || '').trim();
  if (!scene || scene === rt.lastScene) return;
  rt.lastScene = scene;
  const key = sceneKey(scene);
  const map = cfg.backdrops || {};
  if (map[key]) { rt.broadcast({ type: 'backdrop', scene, file: fileUrl(rt.pid, map[key]) }); return; }
  if (!BACKDROPS_ON || rt.genBusy || Object.keys(map).length >= BACKDROP_MAX) return;
  rt.genBusy = true;
  rt.broadcast({ type: 'backdrop_pending', scene });
  (async () => {
    try {
      const table = await fs.readFile(path.join(rt.playAbs, TABLE_FILE), 'utf8').catch(() => '');
      const world = (/##\s*世界\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(table)?.[1] || table).trim().slice(0, 500);
      const prompt = `A wide establishing shot of this scene, no people, no text: ${scene}. `
        + `Setting: ${world.replace(/\s+/g, ' ')}. Soft cinematic light, painterly illustration, muted palette suitable as a reading backdrop.`;
      const gen = makeGenerateImageTool({ workspaceRoot: rt.wsRoot, ctx: rt.ctx });
      const outputName = `stage-bg-${key}`;
      const res = await gen.handler({ prompt, aspectRatio: '16:9', assetRole: 'background', outputName }, {});
      if (res?.isError) throw new Error(res.content?.[0]?.text || 'generate failed');
      const genDir = path.join(rt.wsRoot, 'assets', 'generated');
      const made = (await fs.readdir(genDir).catch(() => [])).find(f => f.startsWith(outputName) && /\.(png|jpe?g|webp)$/i.test(f));
      if (!made) throw new Error('生成了但找不到文件');
      const destRel = `${rt.root}/${SCENES_DIR}/${BACKDROPS_DIR}/${made}`;
      await fs.mkdir(path.dirname(path.join(rt.wsRoot, destRel)), { recursive: true });
      await fs.rename(path.join(genDir, made), path.join(rt.wsRoot, destRel)).catch(async () => {
        await fs.copyFile(path.join(genDir, made), path.join(rt.wsRoot, destRel));
      });
      const fresh = (await readPlayConfig(rt.playAbs)) || cfg;
      fresh.backdrops = { ...(fresh.backdrops || {}), [key]: destRel };
      await writePlayConfig(rt.playAbs, fresh);
      rt.broadcast({ type: 'backdrop', scene, file: fileUrl(rt.pid, destRel) });
    } catch (err) {
      console.warn(`[stage] ${rt.pid}/${rt.root} 背景图没生出来: ${err.message}`);
      rt.broadcast({ type: 'backdrop_failed', scene, error: err.message });
    } finally { rt.genBusy = false; }
  })();
}

// ───────────────────────────── 提示词（拼法在 prompt.js；这里只盯来源有没有变） ─────────────────────────────

/** 给显示器看的配置：立绘 / 背景换成能加载的 URL */
function publicConfig(rt, cfg) {
  const url = (rel) => (rel && !/^(https?:)?\//.test(rel) ? fileUrl(rt.pid, rel) : (rel || null));
  const cast = (cfg.cast || []).map(c => ({ ...c, portrait: url(c.portrait) }));
  const backdrops = Object.fromEntries(Object.entries(cfg.backdrops || {}).map(([k, v]) => [k, url(v)]));
  const { systemPrompt, ...pub } = cfg;
  return { ...pub, cast, backdrops, backdrop: url(cfg.backdrop), root: rt.root, promptChars: rt.promptChars || 0, sources: rt.sources.map(s => s.rel) };
}

async function sourcesChanged(rt) {
  for (const s of rt.sources) if ((await statRel(rt.wsRoot, s.rel)) !== s.mtimeMs) return s.rel;
  return null;
}

// ───────────────────────────── 通路 ─────────────────────────────

async function buildEnv(rt, model, owner) {
  const { NODE_ENV: _a, npm_config_production: _b, npm_config_omit: _c, OLDPWD: _d, ...inherited } = process.env;
  const env = { ...inherited, PWD: rt.wsRoot, CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign-stage/0.0.1', CLAUDE_CONFIG_DIR: platform.claudeConfigDir };
  // 不开工具延迟加载：四件 MCP 工具已 alwaysLoad，开了反而让模型找不到 write_scene（09-05 真栽）
  delete env.ENABLE_TOOL_SEARCH;
  const route = resolveModelRoute(model);
  if (route.mode === 'api') {
    const ingress = await getOrStartIngress();
    env.ANTHROPIC_BASE_URL = `${ingress.baseUrl}/__nd/${encodeURIComponent(rt.sdkSid)}`;
    env.ANTHROPIC_API_KEY = 'nd-ingress-managed';
    registerIngressSession(rt.sdkSid, model);
    rt.ingressRegistered = true;
    if (route.fastModel) env.ANTHROPIC_SMALL_FAST_MODEL = route.fastModel;
    if (route.window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(route.window);
  } else {
    if (!can(owner, 'subscription')) throw Object.assign(new Error('这个账号没有订阅通路资格，演出进程起不来'), { status: 403 });
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; else delete env.ANTHROPIC_API_KEY;
    if (process.env.NODESIGN_FAST_MODEL) env.ANTHROPIC_SMALL_FAST_MODEL = process.env.NODESIGN_FAST_MODEL;
  }
  return env;
}

// ───────────────────────────── 开戏 ─────────────────────────────

/**
 * 建一场戏（open_stage 那条路）：写 台面.md / 规则.json / 戏.json，把在场者的卡搬进文件夹。
 * 同名的戏已存在 = 换设定重开（台面 / 规则重写，卡 / 场景 / 记忆都留着）。返回文件夹名。
 */
export async function createPlay(pid, { title, table, cast, vitals, skin, rules, model } = {}) {
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
  const castOut = [];
  for (const c of cast || []) {
    const name = String(c?.name || c || '').trim();
    if (!name) continue;
    let rel = await resolveCardPath(ws, name, { playRoot: root });
    if (!rel) throw Object.assign(new Error(`没有「${name}」的角色卡（${ROLES_DIR}/${name}/${CARD_FILE}）：先用 cast_role 写卡再开戏`), { status: 409 });
    // 卡在根上的 角色/ 里 → 整个家搬进戏的文件夹（卡 / 记忆 / 立绘一起），文件夹才自成一体
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
  const next = {
    ...stored,
    title: String(title || stored.title || root).slice(0, 60),
    cast: castOut.length ? castOut : (stored.cast || []),
    vitals: Array.isArray(vitals) ? vitals : (stored.vitals || []),
    skin: SKINS.includes(skin) ? skin : (stored.skin || 'paper'),
    model: model || stored.model || null,
    startedAt: stored.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete next.systemPrompt;
  await writePlayConfig(playAbs, next);
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: false });
  return root;
}

export async function startStage(pid, root) {
  const project = getProject(pid);
  if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
  const rt = runtimeOf(pid, root);
  if (rt.running) return { ...rt.status(), promptChars: rt.promptChars };
  if (!(await isPlayDir(rt.playAbs))) throw Object.assign(new Error(`没有这场戏（${root}/）：先让 agent 用 open_stage 开戏`), { status: 404 });
  let stored = (await readPlayConfig(rt.playAbs)) || { title: root, cast: [], vitals: [], skin: 'paper' };
  if (runningStages() >= MAX_RUNNING) throw Object.assign(new Error(`同时在演的场数已满（${MAX_RUNNING}），等一场散了再开`), { status: 503 });

  const model = stored.model || defaultModel();
  const owner = project.ownerId ? getUserById(project.ownerId) : null;
  rt.sdkSid = randomUUID();
  rt.error = null; rt.live = ''; rt.draft = ''; rt.thinking = ''; rt.blocks.clear();
  const env = await buildEnv(rt, model, owner);
  const composed = await composeStagePrompt(rt.wsRoot, root, stored);
  rt.sources = composed.sources;
  rt.promptChars = composed.text.length;
  if (JSON.stringify(composed.cast) !== JSON.stringify(stored.cast)) {
    stored = { ...stored, cast: composed.cast };
    await writePlayConfig(rt.playAbs, stored);
  }
  // 当前状态与规则的"已达成"从磁盘接回来
  const scenes = await readScenes(rt.playAbs, { limit: 100000 });
  rt.state = foldState(stored, scenes);
  rt.lastScene = [...scenes].reverse().find(r => r.scene)?.scene || null;
  rt.seen = { earned: new Set((await readTrophies(rt.playAbs)).map(t => t.id)), fired: new Set(stored.firedTriggers || []) };

  rt.ctx = new AgentContext({ runId: '__stage_pending__', skillId: 'stage', workspaceRoot: rt.wsRoot, sessionId: rt.sdkSid, appModel: model });
  const tools = createStageTools({
    workspaceRoot: rt.wsRoot, playRoot: root,
    onScene: async (row) => {
      rt.live = ''; rt.draft = '';
      rt.broadcast({ type: 'scene', row });
      if (row.by !== 'stage') return '';
      const cfg = (await readPlayConfig(rt.playAbs)) || stored;
      if (row.state) Object.assign(rt.state, row.state);
      rt.state['拍数'] = (rt.state['拍数'] || 0) + 1;
      rt.broadcast({ type: 'state', state: rt.state });
      const note = await runRules(rt, cfg);
      maybeBackdrop(rt, row, cfg).catch(() => {});
      return note;
    },
    onCardTouched: async (rel) => {
      const src = rt.sources.find(x => x.rel === rel);
      if (src) src.mtimeMs = await statRel(rt.wsRoot, rel);
    },
  });

  rt.session = new StageSession({
    cwd: rt.wsRoot, model: resolveSdkSpoofModel(model), env, sessionId: rt.sdkSid,
    systemPrompt: composed.text, mcpServers: { stage: tools },
    plugins: [{ type: 'local', path: path.join(getBuiltinPluginsRoot(), 'nodesign') }], skills: STAGE_SKILLS,
    thinking: pickThinkingConfig(model),
    onEvent: (e) => onSessionEvent(rt, e),
  });
  rt.session.start();
  rt.startedAt = new Date().toISOString();
  rt.touch();
  rt.broadcast(rt.status());
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: true });
  console.log(`[stage] ${pid}/${root} 开演 model=${model} sid=${rt.sdkSid.slice(0, 8)} prompt=${composed.text.length}c sources=${rt.sources.map(x => x.rel).join(',')}`);
  return { ...rt.status(), promptChars: composed.text.length };
}

function onSessionEvent(rt, e) {
  switch (e.type) {
    case 'init': {
      const have = (e.tools || []).filter(n => /^mcp__stage__/.test(n));
      if (have.length < 4) {
        rt.error = `演出进程的工具面不齐（只见到 ${have.join(', ') || '无'}），台上写不了字 —— 这是服务端的问题，不是你的`;
        console.error(`[stage] ${rt.pid}/${rt.root} ${rt.error}`);
        rt.broadcast({ type: 'error', error: rt.error }); rt.broadcast(rt.status());
      } else console.log(`[stage] ${rt.pid}/${rt.root} 台面就位 ${have.length} 件，model=${e.model}`);
      return;
    }
    case 'thinking':
      rt.thinking += e.text; rt.broadcast({ type: 'thinking', text: e.text }); return;
    case 'text':
      rt.live += e.text; rt.broadcast({ type: 'text', text: e.text }); return;
    case 'tool_start':
      rt.blocks.set(e.index, { name: e.name, json: '' });
      rt.broadcast({ type: 'tool', name: e.name, phase: 'start' });
      return;
    case 'tool_delta': {
      const b = rt.blocks.get(e.index);
      if (!b) return;
      b.json += e.partial;
      if (b.name !== 'mcp__stage__write_scene') return;
      try {
        const obj = parsePartialJson(b.json, Allow.ALL);
        const text = typeof obj?.text === 'string' ? obj.text : '';
        if (text && text !== rt.draft) { rt.draft = text; rt.broadcast({ type: 'draft', text }); }
      } catch { /* 半截 JSON 解不出就等下一段 */ }
      return;
    }
    case 'block_stop':
      rt.blocks.delete(e.index); return;
    case 'tool':
      return;
    case 'turn_end':
      settleRun(rt, e);
      rt.live = ''; rt.draft = ''; rt.thinking = ''; rt.blocks.clear();
      rt.broadcast({ type: 'turn_end', usage: rt.lastUsage, error: e.error || null });
      rt.broadcast(rt.status());
      rt.touch();
      return;
    case 'error':
      rt.error = e.error;
      for (const id of rt.pendingRuns.splice(0)) { try { markRunFailed(id, e.error); } catch { /* */ } }
      rt.broadcast({ type: 'error', error: e.error }); rt.broadcast(rt.status());
      console.error(`[stage] ${rt.pid}/${rt.root} 演出进程出错: ${e.error}`);
      return;
    default:
  }
}

function settleRun(rt, e) {
  const runId = rt.pendingRuns.shift();
  const ctx = rt.ctx;
  if (!ctx) return;
  ctx.counters = freshTurnCounters();
  try { ctx.absorbResult(e.result); } catch (err) { console.warn('[stage] absorbResult 失败:', err.message); }
  const c = ctx.counters;
  rt.lastUsage = {
    input: c.inputTokens || 0, output: c.outputTokens || 0, cacheRead: c.cacheReadTokens || 0, cacheCreate: c.cacheCreateTokens || 0,
    context: (c.inputTokens || 0) + (c.cacheReadTokens || 0) + (c.cacheCreateTokens || 0),
    costUsd: c.totalCostUsd || 0, durationMs: c.durationMs || 0, model: ctx.appModel,
  };
  if (!runId) return;
  try {
    setRunMetrics(runId, c); setRunModelUsage(runId, c.modelUsage);
    if (e.error) markRunFailed(runId, String(e.error)); else markRunSucceeded(runId, {});
  } catch (err) { console.warn('[stage] 结账失败:', err.message); }
}

// ───────────────────────────── 直投 ─────────────────────────────

export async function sayToStage(pid, root, text, { userId = null } = {}) {
  const rt = runtimeOf(pid, root);
  if (rt.running && !rt.busy && !rt.session?.queued) {
    const changed = await sourcesChanged(rt);
    if (changed) { console.log(`[stage] ${pid}/${root} 设定文件改了（${changed}），重开`); await stopStage(pid, root, 'setup-changed'); }
  }
  if (!rt.running) await startStage(pid, root);
  const project = getProject(pid);
  const run = createRun({ skillId: 'stage', brief: text.slice(0, 200), projectId: pid, userId: userId || project?.ownerId || null, sessionId: rt.sdkSid, metadata: { stage: true, play: root } });
  markRunStarted(run.id);
  rt.pendingRuns.push(run.id);
  rt.ctx.runId = run.id;
  const row = await appendUserLine(rt.playAbs, text);
  rt.broadcast({ type: 'scene', row });
  const notes = rt.pendingNotes.splice(0);
  const about = [stateLine(rt.state), ...notes.map(n => `【场务纸条：${n}】`)].join('\n');
  const r = rt.session.say(text, { about });
  rt.touch();
  rt.broadcast(rt.status());
  return { ...r, runId: run.id };
}

export async function stopStage(pid, root, reason = 'user') {
  const rt = runtimes.get(keyOf(pid, root));
  if (!rt || !rt.session) return { running: false };
  clearTimeout(rt.idleTimer);
  const s = rt.session; rt.session = null;
  try { await s.stop(); } catch { /* 已经退了 */ }
  if (rt.ingressRegistered) { try { unregisterIngressSession(rt.sdkSid); } catch { /* */ } rt.ingressRegistered = false; }
  for (const id of rt.pendingRuns.splice(0)) { try { markRunFailed(id, `stage stopped: ${reason}`); } catch { /* */ } }
  rt.live = ''; rt.draft = ''; rt.thinking = '';
  rt.broadcast({ ...rt.status(), running: false, busy: false, stoppedFor: reason });
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: false });
  console.log(`[stage] ${pid}/${root} 散场（${reason}）`);
  return { running: false };
}

export async function stopAllStages(reason = 'shutdown') {
  await Promise.all([...runtimes.values()].map(rt => stopStage(rt.pid, rt.root, reason).catch(() => {})));
}

// ───────────────────────────── 读 / 改 ─────────────────────────────

export async function stageState(pid, root, { limit = 300 } = {}) {
  const rt = runtimeOf(pid, root);
  if (!(await isPlayDir(rt.playAbs))) return null;
  const cfg = (await readPlayConfig(rt.playAbs)) || { title: root, cast: [], vitals: [], skin: 'paper' };
  const scenes = await readScenes(rt.playAbs, { limit });
  if (!rt.running) rt.state = foldState(cfg, await readScenes(rt.playAbs, { limit: 100000 }));
  return {
    ...rt.status(),   // ⚠️ 先铺 status，再盖 type —— status() 自带 type:'status'，放后面会把 hello 顶掉（09-05 晚栽过：显示器收到的是空 status）
    root,
    config: publicConfig(rt, cfg),
    scenes,
    memoryIndex: await readMemoryIndex(rt.playAbs),
    memories: await listMemories(rt.playAbs),
    trophies: await readTrophies(rt.playAbs),
    rules: await readRules(rt.playAbs),
    live: rt.live, draft: rt.draft, thinking: rt.thinking,
    type: 'hello',
  };
}

export async function patchStageConfig(pid, root, patch) {
  const rt = runtimeOf(pid, root);
  const cfg = await readPlayConfig(rt.playAbs);
  if (!cfg) throw Object.assign(new Error('还没有这场戏'), { status: 404 });
  const next = { ...cfg, updatedAt: new Date().toISOString() };
  if (patch.skin !== undefined) next.skin = SKINS.includes(patch.skin) ? patch.skin : cfg.skin;
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 60);
  if (Array.isArray(patch.vitals)) next.vitals = patch.vitals;
  if (patch.backdrop !== undefined) next.backdrop = patch.backdrop ? String(patch.backdrop) : null;   // 用户手选的背景（戏相对路径）
  await writePlayConfig(rt.playAbs, next);
  const pub = publicConfig(rt, next);
  rt.broadcast({ type: 'config', config: pub });
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: rt.running });
  return pub;
}

/** 用户在状态页拨数值：落一行 by:'user-state' 的 state，跑规则；纸条随下一句话带过去 */
export async function setUserState(pid, root, patch) {
  const rt = runtimeOf(pid, root);
  const cfg = await readPlayConfig(rt.playAbs);
  if (!cfg) throw Object.assign(new Error('还没有这场戏'), { status: 404 });
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (typeof k === 'string' && k && k !== '拍数' && (typeof v === 'string' || typeof v === 'number')) clean[k] = typeof v === 'string' ? v.slice(0, 60) : v;
  if (!Object.keys(clean).length) throw Object.assign(new Error('没有可改的键'), { status: 400 });
  const row = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'user-state', state: clean };
  await appendSceneRow(rt.playAbs, row);
  if (!rt.running) rt.state = foldState(cfg, await readScenes(rt.playAbs, { limit: 100000 }));
  else Object.assign(rt.state, clean);
  rt.broadcast({ type: 'scene', row });
  rt.broadcast({ type: 'state', state: rt.state });
  if (!rt.seen.earned.size && !rt.seen.fired.size) rt.seen = { earned: new Set((await readTrophies(rt.playAbs)).map(t => t.id)), fired: new Set(cfg.firedTriggers || []) };
  const note = await runRules(rt, cfg);
  if (note) rt.pendingNotes.push(note.replace(/^【|】$/g, ''));
  return { state: rt.state, note };
}

export async function subscribeStage(pid, root, res) {
  const rt = runtimeOf(pid, root);
  rt.subscribers.add(res);
  const hello = await stageState(pid, root);
  res.write(`data: ${JSON.stringify(hello || { type: 'hello', root, config: null, scenes: [], ...rt.status() })}\n\n`);
  return () => { rt.subscribers.delete(res); };
}
