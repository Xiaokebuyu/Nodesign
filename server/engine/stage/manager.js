/**
 * engine/stage/manager.js —— 演出进程的起停、直投、计量、广播（2026-09-05；09-06 拆出 mechanics / lines / opening）
 *
 * 一个故事 = 工作区根下的一个文件夹（布局见 play.js），一个项目可以有几个。这里攥着每个故事的
 * StageRuntime：进程本体、SSE 订户、计量上下文、空闲计时、当前状态、规则表的"已达成"、当前线路。
 *
 * ## 这条路上没有主 agent
 *
 * 用户在显示器里点一枚选项 / 说一句话 → api/stage.js → sayToStage → 进程队列。
 * 主 agent 只在开场前出场一次（open_stage：写设定 + 规则、把在场者的卡搬进文件夹），之后退到后台。
 * 台上写出来的每一段由 write_scene 落盘（场景/*.jsonl），这里顺手推给所有订户。
 *
 * ## 系统提示词从文件拼（prompt.js）
 *
 * 设定 + 每张在场者的卡 + 这个故事的记忆索引 + 玩家挑的写法预设 + 几句工具提醒。
 * 拼的时候记下每份来源文件的 mtime 和写法 / 可选条目的指纹；用户改了任何一样，下一句话到时先重开再说。
 * 进程自己重写卡上的索引块**不算改**（onCardTouched 把 mtime 跟上），否则每记一条下一句就重开、缓存整份重付。
 *
 * ## 重开 = resume（09-06）
 *
 * 每条线路记着自己的 SDK 会话 id。空闲自停、改设定重开、回退、分叉之后再起进程，一律 `resume` 那个 id，
 * 模型才记得前文 —— 09-05 那版每次重开都是新会话，模型除了记忆索引什么都不记得，玩家感知是"她忘了刚说的话"。
 *
 * ## 机械层在 mechanics.js（状态折叠 / 规则 / 背景图），线路在 lines.js，开场在 opening.js。
 *
 * ## 进程是贵的，所以三条纪律
 *
 *   1. 同时在跑的故事数封顶（NODESIGN_STAGE_MAX，默认 2）：一个 SDK 子进程 300-500MB。满了报 503。
 *   2. 空闲自停（NODESIGN_STAGE_IDLE_MS，默认 30 分钟）；下一句话到了自动再起（resume），用户感知"第一句慢一点"。
 *   3. 每一句一条 run：createRun(skillId:'stage') → absorbResult 差分 → runs + run_model_usage（日限闸门读它）。
 *
 * ## 通路跟主循环同一张表
 * 订阅模型不注 API key（owner 得有 subscription 资格）；API 模型 BASE_URL 指进程内 ingress。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse as parsePartialJson, Allow } from 'partial-json';
import { StageSession } from './session.js';
import { createStageTools, readMemoryIndex, readScenes, appendUserLine, appendSceneRow, listMemories } from './tools.js';
import { resolveCardPath, cardHome, readCardForStage, ROLES_DIR, CARD_FILE } from './card.js';
import {
  TABLE_FILE, MAIN_LINE,
  isPlayDir, playFolderName, listPlays, readPlayConfig, writePlayConfig, readRules, writeRules, readTrophies,
  migrateLegacyPlay, exists, linesOf, currentLine, sceneFileOf,
} from './play.js';
import { validateCondition } from './rules.js';
import { composeStagePrompt, frozenHash } from './prompt.js';
import { foldState, stateLine, runRules, maybeBackdrop, currentBackdrop, sceneOf, fileUrl } from './mechanics.js';
import { resolvePreset, normalizeSelection, defaultSelection, DEFAULT_PRESET } from './preset.js';
import { loadWorldbook, matchEntries, loreNote, LORE_COOLDOWN_BEATS } from './worldbook.js';
import { readPanels, writePanels, declarePanels, applyOp as applyPanelOp, digest as panelDigest } from './panels.js';
export { composeStagePrompt };
import { getProject } from '../../projects/store.js';
import { getWorkspaceRoot } from '../../projects/workspace.js';
import { jsonlExistsForSession } from '../../projects/session-jsonl.js';
import { getProjectBus } from '../../ws/broker.js';
import { getBuiltinPluginsRoot } from '../agent/plugin-loader.js';
import { defaultModel } from '../agent/session-model.js';
import { brandOfModel } from '../agent/model-context.js';
import { resolveSdkSpoofModel, pickThinkingConfig } from '../agent/model-context.js';
import { buildEnv } from './env.js';
import { unregisterIngressSession } from '../../lib/model-ingress.js';
import { AgentContext, freshTurnCounters } from '../agent/context.js';
import { createRun, markRunStarted, markRunSucceeded, markRunFailed, setRunMetrics, setRunModelUsage } from '../runs/store.js';
import { getUserById } from '../../auth/users-store.js';

const MAX_RUNNING = Number(process.env.NODESIGN_STAGE_MAX) || 2;
const IDLE_MS = Number(process.env.NODESIGN_STAGE_IDLE_MS) || 30 * 60_000;
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
    this.live = '';            // 工具之外流出来的字（显示器收进"台下"，不进正文）
    this.thinking = '';        // 这一段的思考流
    this.blocks = new Map();   // 流中的工具块 index → { name, json }
    this.draft = '';           // write_scene 正在写的正文（partial-json 解出来的）
    this.error = null;
    this.startedAt = null;
    this.sources = [];         // 进了系统提示词的文件 [{rel, mtimeMs}]
    this.frozen = null;        // 写法 + 可选条目的指纹（prompt.js frozenHash）
    this.promptChars = 0;
    this.styleNames = [];
    this.state = {};           // 折好的当前状态
    this.seen = { earned: new Set(), fired: new Set() };
    this.pendingNotes = [];    // 用户拨状态触发的纸条，随下一句话带过去
    this.lastUsage = null;
    this.lastScene = null;
    this.genBusy = false;
    this.line = MAIN_LINE;     // 当前线路
    this.scenesRel = sceneFileOf(MAIN_LINE);
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
      type: 'status', root: this.root, line: this.line,
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

export async function statRel(base, rel) {
  try { return (await fs.stat(path.join(base, rel))).mtimeMs; } catch { return null; }
}

/** 老形状收进文件夹（幂等）。返回这个项目所有故事的文件夹名。 */
export async function ensurePlays(pid) {
  const ws = getWorkspaceRoot(pid);
  const migrated = await migrateLegacyPlay(ws);
  if (migrated) {
    console.log(`[stage] ${pid} 老形状 stage/ 已收进文件夹「${migrated}」`);
    getProjectBus(pid).publish({ type: 'stage.changed', root: migrated, running: false });
  }
  return listPlays(ws);
}

/** 读配置并把当前线路对到 runtime 上（不跑时 runtime 只是个壳，线路要每次从配置对） */
export async function loadConfig(rt) {
  const cfg = (await readPlayConfig(rt.playAbs)) || { title: rt.root, cast: [], vitals: [], skin: 'paper' };
  const line = currentLine(cfg);
  rt.line = line.id;
  rt.scenesRel = sceneFileOf(line.id);
  return cfg;
}

/** 每张卡上的「可选」条目（开场页画开关用）：{名: [{id,label,desc,default}]}。进程没起也要能读，所以直接读卡 */
async function cardOptionsOf(rt, cfg) {
  const out = {};
  for (const c of cfg.cast || []) {
    if (!c.card) continue;
    try { const card = await readCardForStage(rt.wsRoot, c.card); if (card.options?.length) out[c.name] = card.options; } catch { /* 卡读不到就没有开关 */ }
  }
  return out;
}

/** 给显示器看的配置：立绘 / 背景换成能加载的 URL；线路表、写法、可选条目原样带上 */
function publicConfig(rt, cfg) {
  const url = (rel) => (rel && !/^(https?:)?\//.test(rel) ? fileUrl(rt.pid, rel) : (rel || null));
  const cast = (cfg.cast || []).map(c => ({ ...c, portrait: url(c.portrait) }));
  const backdrops = Object.fromEntries(Object.entries(cfg.backdrops || {}).map(([k, v]) => [k, url(v)]));
  const { systemPrompt, ...pub } = cfg;
  return {
    ...pub, cast, backdrops, backdrop: url(cfg.backdrop), root: rt.root,
    lines: linesOf(cfg).map(({ sdkSid, ...l }) => ({ ...l, hasMemory: !!sdkSid })), currentLine: currentLine(cfg).id,
    style: cfg.style || { preset: DEFAULT_PRESET, modules: null }, cardOptions: cfg.cardOptions || {}, opened: !!cfg.opened,
    brand: brandOfModel(cfg.model || defaultModel()) || 'custom',   // 显示器画身份标：服务端声明的 brand，前端不猜
    promptChars: rt.promptChars || cfg.promptChars || 0, sources: rt.sources.length ? rt.sources.map(s => s.rel) : (cfg.promptSources || []), styleNames: rt.styleNames?.length ? rt.styleNames : (cfg.styleNames || []),
  };
}

/** 设定文件的 mtime 或写法 / 可选条目的指纹变了 → 返回变的那一样 */
async function sourcesChanged(rt) {
  for (const s of rt.sources) if ((await statRel(rt.wsRoot, s.rel)) !== s.mtimeMs) return s.rel;
  const cfg = await readPlayConfig(rt.playAbs);
  if (cfg && rt.frozen && frozenHash(cfg) !== rt.frozen) return '写法 / 可选条目';
  return null;
}

// ───────────────────────────── 建故事 ─────────────────────────────

/**
 * 建一个故事（open_stage 那条路）：写 台面.md / 规则.json / 戏.json，把在场者的卡搬进文件夹。
 * 同名的已存在 = 换设定重开（设定 / 规则重写，卡 / 场景 / 记忆都留着）。返回文件夹名。
 * **不起进程**：进程在玩家点「开始」或说第一句话时才起（09-06 起，之前 open_stage 一调就先烧 400MB）。
 */
export async function createPlay(pid, { title, table, cast, vitals, skin, rules, model, style, panels, opening, lore } = {}) {
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
  const next = {
    ...stored,
    title: String(title || stored.title || root).slice(0, 60),
    cast: castOut.length ? castOut : (stored.cast || []),
    vitals: Array.isArray(vitals) ? vitals : (stored.vitals || []),
    skin: SKINS.includes(skin) ? skin : (stored.skin || 'paper'),
    model: model || stored.model || null,
    ...(opening ? { opening: String(opening).slice(0, 6000) } : {}),   // 酒馆卡的开场白 / 场景，开场指令带给进程当底
    ...(lore?.off?.length ? { lore: { off: lore.off.map(String).slice(0, 500), by: 'agent' } } : {}),   // agent 按玩家回答预先关掉的世界书条目（开场页能改）
    lines: linesOf(stored),
    currentLine: currentLine(stored).id,
    startedAt: stored.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (style?.preset) {
    // agent 按用户的回答预选：on / off 是在默认勾选之上加减（modules 是老写法 = on）。开场页据 by:'agent' 提示"这是预选的，你可以改"
    const preset = await resolvePreset(playAbs, style.preset);
    const sel = preset ? defaultSelection(preset) : {};
    for (const id of [...(style.on || []), ...(Array.isArray(style.modules) ? style.modules : [])]) sel[id] = true;
    for (const id of style.off || []) sel[id] = false;
    if (style.modules && !Array.isArray(style.modules)) Object.assign(sel, style.modules);
    next.style = { preset: preset ? style.preset : 'none', modules: preset ? normalizeSelection(preset, sel) : null, by: 'agent' };
  }
  delete next.systemPrompt;
  await writePlayConfig(playAbs, next);
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: false });
  return root;
}

// ───────────────────────────── 起进程 ─────────────────────────────

export async function startStage(pid, root) {
  const project = getProject(pid);
  if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
  const rt = runtimeOf(pid, root);
  if (rt.running) return { ...rt.status(), promptChars: rt.promptChars };
  if (!(await isPlayDir(rt.playAbs))) throw Object.assign(new Error(`没有这个故事（${root}/）：先让 agent 用 open_stage 建一个`), { status: 404 });
  let stored = await loadConfig(rt);
  if (runningStages() >= MAX_RUNNING) throw Object.assign(new Error(`同时在进行的故事已满（${MAX_RUNNING}），等一个停下再开`), { status: 503 });

  const model = stored.model || defaultModel();
  const owner = project.ownerId ? getUserById(project.ownerId) : null;
  // 这条线路有转录就 resume（模型记得前文）；没有就新开一个 id 并记到线路上
  const line = currentLine(stored);
  let resume = null;
  if (line.sdkSid && await jsonlExistsForSession(rt.wsRoot, line.sdkSid)) { resume = line.sdkSid; rt.sdkSid = line.sdkSid; }
  else {
    rt.sdkSid = randomUUID();
    stored = { ...stored, lines: linesOf(stored).map(l => (l.id === line.id ? { ...l, sdkSid: rt.sdkSid } : l)), currentLine: line.id };
    await writePlayConfig(rt.playAbs, stored);
  }
  rt.error = null; rt.live = ''; rt.draft = ''; rt.thinking = ''; rt.blocks.clear();
  const env = await buildEnv(rt, model, owner);
  const composed = await composeStagePrompt(rt.wsRoot, root, stored);
  rt.sources = composed.sources;
  rt.frozen = composed.hash;
  rt.promptChars = composed.text.length;
  rt.styleNames = composed.styleNames;
  const castPublic = composed.cast.map(({ options, ...c }) => c);
  // 系统提示词的字数和来源也落进配置：进程停着时设定页照样有数（09-06 画布上看到"0 字 · 进程还没起过"）
  stored = { ...stored, cast: castPublic, promptChars: composed.text.length, promptSources: rt.sources.map(x => x.rel), styleNames: composed.styleNames };
  await writePlayConfig(rt.playAbs, stored);
  // 当前状态与规则的"已达成"从磁盘接回来
  const scenes = await readScenes(rt.playAbs, { limit: 100000, rel: rt.scenesRel });
  rt.state = foldState(stored, scenes);
  rt.lastScene = [...scenes].reverse().find(r => r.scene)?.scene || sceneOf(null, rt.state);
  rt.seen = { earned: new Set((await readTrophies(rt.playAbs)).map(t => t.id)), fired: new Set(stored.firedTriggers || []) };

  rt.ctx = new AgentContext({ runId: '__stage_pending__', skillId: 'stage', workspaceRoot: rt.wsRoot, sessionId: rt.sdkSid, appModel: model });
  const tools = createStageTools({
    workspaceRoot: rt.wsRoot, playRoot: root, scenesRel: () => rt.scenesRel,
    onScene: async (row) => {
      rt.live = ''; rt.draft = '';
      rt.broadcast({ type: 'scene', row });
      if (row.by !== 'stage') return '';
      const cfg = (await readPlayConfig(rt.playAbs)) || stored;
      if (row.state) Object.assign(rt.state, row.state);
      rt.state['拍数'] = (rt.state['拍数'] || 0) + 1;
      rt.broadcast({ type: 'state', state: rt.state, changed: row.state || null });
      const note = await runRules(rt, cfg);
      maybeBackdrop(rt, row, cfg).catch(() => {});
      return note;
    },
    onCardTouched: async (rel) => {
      const src = rt.sources.find(x => x.rel === rel);
      if (src) src.mtimeMs = await statRel(rt.wsRoot, rel);
    },
    onPanel: (op) => panelOp(pid, root, op, { by: 'stage' }),
  });

  rt.session = new StageSession({
    cwd: rt.wsRoot, model: resolveSdkSpoofModel(model), env, sessionId: rt.sdkSid, resume,
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
  console.log(`[stage] ${pid}/${root} 起 model=${model} sid=${rt.sdkSid.slice(0, 8)}${resume ? '(resume)' : ''} line=${rt.line} prompt=${composed.text.length}c sources=${rt.sources.map(x => x.rel).join(',')}`);
  return { ...rt.status(), promptChars: composed.text.length };
}

function onSessionEvent(rt, e) {
  switch (e.type) {
    case 'init': {
      const have = (e.tools || []).filter(n => /^mcp__stage__/.test(n));
      if (have.length < 4) {
        rt.error = `故事进程的工具面不齐（只见到 ${have.join(', ') || '无'}），台上写不了字 —— 这是服务端的问题，不是你的`;
        console.error(`[stage] ${rt.pid}/${rt.root} ${rt.error}`);
        rt.broadcast({ type: 'error', error: rt.error }); rt.broadcast(rt.status());
      } else console.log(`[stage] ${rt.pid}/${rt.root} 工具就位 ${have.length} 件，model=${e.model}`);
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
      console.error(`[stage] ${rt.pid}/${rt.root} 故事进程出错: ${e.error}`);
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

/**
 * 用户对台上说一句。row 可换成机器发的那一行（开场：by:'system'），模型收到的仍是 text。
 * 每句都盖一个 uuid：它同时是转录里那条 user 记录的 uuid（回退 / 分叉按它切）。
 */
export async function sayToStage(pid, root, text, { userId = null, row = null } = {}) {
  const rt = runtimeOf(pid, root);
  if (rt.running && !rt.busy && !rt.session?.queued) {
    const changed = await sourcesChanged(rt);
    if (changed) { console.log(`[stage] ${pid}/${root} 设定改了（${changed}），重开`); await stopStage(pid, root, 'setup-changed'); }
  }
  if (!rt.running) await startStage(pid, root);
  const project = getProject(pid);
  const run = createRun({ skillId: 'stage', brief: text.slice(0, 200), projectId: pid, userId: userId || project?.ownerId || null, sessionId: rt.sdkSid, metadata: { stage: true, play: root, line: rt.line } });
  markRunStarted(run.id);
  rt.pendingRuns.push(run.id);
  rt.ctx.runId = run.id;
  const uuid = randomUUID();
  const saved = await appendUserLine(rt.playAbs, row?.text ?? text, { rel: rt.scenesRel, uuid, by: row?.by || 'user', extra: row?.extra || {} });
  rt.broadcast({ type: 'scene', row: saved });
  const notes = rt.pendingNotes.splice(0);
  const lore = await pickLore(rt, text);
  const pd = panelDigest(await readPanels(rt.playAbs));
  const about = [stateLine(rt.state), ...(pd ? [`面板：${pd}`] : []), ...notes.map(n => `【便条：${n}】`), ...(lore ? [lore] : [])].join('\n');
  const r = rt.session.say(text, { about, uuid });
  rt.touch();
  rt.broadcast(rt.status());
  return { ...r, runId: run.id, rowId: saved.id };
}

/**
 * 世界书机械触发：拿玩家这句 + 上一段正文撞触发条目的 keys，命中的接在这句话尾巴上（worldbook.js）。
 * 同一条三段内不重复带（rt.loreSeen 记着上次带它是第几段）。命中了给显示器报一声。
 */
async function pickLore(rt, text) {
  let entries = [];
  try { entries = await loadWorldbook(rt.playAbs); } catch { return ''; }
  if (!entries.length) return '';
  const beat = rt.state?.['拍数'] || 0;
  rt.loreSeen = rt.loreSeen || new Map();
  const skip = new Set([...rt.loreSeen].filter(([, at]) => beat - at < LORE_COOLDOWN_BEATS).map(([n]) => n));
  for (const n of (await readPlayConfig(rt.playAbs))?.lore?.off || []) skip.add(n);   // 玩家关掉的条目不送
  const last = (await readScenes(rt.playAbs, { limit: 6, rel: rt.scenesRel })).reverse().find(r => r.by === 'stage')?.text || '';
  const matched = matchEntries(entries, `${text}\n${last}`, { skip });
  if (!matched.length) return '';
  for (const m of matched) rt.loreSeen.set(m.name, beat);
  rt.broadcast({ type: 'lore', titles: matched.map(m => m.name) });
  return loreNote(matched);
}

/**
 * 面板的一步动作（演出进程的 update_panel 和玩家在显示器点"买 / 用 / 装上"都走这儿）。
 * 玩家改的进程还不知道 → 记一条纸条随下一句话带过去；买东西扣的钱走状态那条路（拨值 + 跑规则）。
 */
export async function panelOp(pid, root, op, { by = 'player' } = {}) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  if (!rt.running) rt.state = foldState(cfg, await readScenes(rt.playAbs, { limit: 100000, rel: rt.scenesRel }));
  const panels = await readPanels(rt.playAbs);
  if (!Object.keys(panels).length && op.op !== 'open') return null;
  const r = applyPanelOp(panels, op, rt.state);
  if (r.error) return r;
  await writePanels(rt.playAbs, r.panels);
  rt.broadcast({ type: 'panel', panels: r.panels, change: r.change, by });
  if (r.stateChange) await setUserState(pid, root, r.stateChange).catch(() => {});
  if (by === 'player') rt.pendingNotes.push(`玩家自己动了面板：${r.change}`);
  return { ...r, digest: panelDigest(r.panels) };
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
  console.log(`[stage] ${pid}/${root} 停（${reason}）`);
  return { running: false };
}

export async function stopAllStages(reason = 'shutdown') {
  await Promise.all([...runtimes.values()].map(rt => stopStage(rt.pid, rt.root, reason).catch(() => {})));
}

// ───────────────────────────── 读 / 改 ─────────────────────────────

export async function stageState(pid, root, { limit = 300 } = {}) {
  const rt = runtimeOf(pid, root);
  if (!(await isPlayDir(rt.playAbs))) return null;
  const cfg = await loadConfig(rt);
  const scenes = await readScenes(rt.playAbs, { limit, rel: rt.scenesRel });
  if (!rt.running) rt.state = foldState(cfg, await readScenes(rt.playAbs, { limit: 100000, rel: rt.scenesRel }));
  return {
    ...rt.status(),   // ⚠️ 先铺 status，再盖 type —— status() 自带 type:'status'，放后面会把 hello 顶掉（09-05 晚栽过：显示器收到的是空 status）
    root,
    config: publicConfig(rt, cfg),
    castOptions: await cardOptionsOf(rt, cfg),
    scenes,
    memoryIndex: await readMemoryIndex(rt.playAbs),
    memories: await listMemories(rt.playAbs),
    trophies: await readTrophies(rt.playAbs),
    rules: await readRules(rt.playAbs),
    live: rt.live, draft: rt.draft, thinking: rt.thinking,
    panels: await readPanels(rt.playAbs),
    backdrop: currentBackdrop(rt, cfg, [...scenes].reverse().find(r => r.scene)?.scene || sceneOf(null, rt.state)),
    type: 'hello',
  };
}

/** 显示器改配置：外观 / 标题 / 状态面板 / 手选背景 / 写法与可选条目。写法改了下一句话到时进程自己重开。 */
export async function patchStageConfig(pid, root, patch) {
  const rt = runtimeOf(pid, root);
  const cfg = await readPlayConfig(rt.playAbs);
  if (!cfg) throw Object.assign(new Error('还没有这个故事'), { status: 404 });
  const next = { ...cfg, updatedAt: new Date().toISOString() };
  if (patch.skin !== undefined) next.skin = SKINS.includes(patch.skin) ? patch.skin : cfg.skin;
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 60);
  if (Array.isArray(patch.vitals)) next.vitals = patch.vitals;
  if (patch.backdrop !== undefined) next.backdrop = patch.backdrop ? String(patch.backdrop) : null;   // 用户手选的背景（故事相对路径）
  if (typeof patch.backdropsAuto === 'boolean') next.backdropsAuto = patch.backdropsAuto;   // 换场自动生图的开关（外观页）
  if (patch.style && typeof patch.style === 'object') {
    const preset = await resolvePreset(rt.playAbs, patch.style.preset);
    next.style = { preset: preset ? String(patch.style.preset) : 'none', modules: preset ? normalizeSelection(preset, patch.style.modules) : null, by: 'player' };
  }
  if (patch.cardOptions && typeof patch.cardOptions === 'object') {
    next.cardOptions = Object.fromEntries(Object.entries(patch.cardOptions).filter(([k, v]) => typeof k === 'string' && k.length < 120 && typeof v === 'boolean'));
  }
  if (patch.lore && typeof patch.lore === 'object') next.lore = { off: (Array.isArray(patch.lore.off) ? patch.lore.off : []).filter(s => typeof s === 'string').slice(0, 500), by: 'player' };
  if (patch.opened === true) { next.opened = true; next.openedAt = next.openedAt || new Date().toISOString(); }
  await writePlayConfig(rt.playAbs, next);
  const pub = publicConfig(rt, next);
  rt.broadcast({ type: 'config', config: pub });
  getProjectBus(pid).publish({ type: 'stage.changed', root, running: rt.running });
  return pub;
}

/** 用户在状态页拨数值：落一行 by:'user-state' 的 state，跑规则；纸条随下一句话带过去 */
export async function setUserState(pid, root, patch) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  if (!(await isPlayDir(rt.playAbs))) throw Object.assign(new Error('还没有这个故事'), { status: 404 });
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (typeof k === 'string' && k && k !== '拍数' && (typeof v === 'string' || typeof v === 'number')) clean[k] = typeof v === 'string' ? v.slice(0, 60) : v;
  if (!Object.keys(clean).length) throw Object.assign(new Error('没有可改的键'), { status: 400 });
  const row = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'user-state', state: clean };
  await appendSceneRow(rt.playAbs, row, rt.scenesRel);
  if (!rt.running) rt.state = foldState(cfg, await readScenes(rt.playAbs, { limit: 100000, rel: rt.scenesRel }));
  else Object.assign(rt.state, clean);
  rt.broadcast({ type: 'scene', row });
  rt.broadcast({ type: 'state', state: rt.state, changed: clean });
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
