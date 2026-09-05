/**
 * engine/stage/manager.js —— 演出进程的起停、直投、计量、广播（2026-09-05）
 *
 * 一个项目最多一场戏在跑（stage/ 是固定目录名，也就是一份 stage.json）。这里攥着
 * 每个项目的 StageRuntime：进程本体、SSE 订户、计量上下文、空闲计时。
 *
 * ## 这条路上没有主 agent
 *
 * 用户在显示器里点一枚把手 / 说一句话 → api/stage.js → sayToStage → 进程队列。
 * 主 agent 只在开戏时出场一次（open_stage 工具把系统提示词交过来），之后退到场务位。
 * 台上写出来的每一拍由 write_scene 落盘（scenes.jsonl），这里顺手推给所有订户。
 *
 * ## 进程是贵的，所以三条纪律
 *
 *   1. **同时在跑的场数封顶**（NODESIGN_STAGE_MAX，默认 2）：一个 SDK 子进程 300-500MB，
 *      这台盒子 8GB 已用 4GB、swap=0。满了报 503，如实说，别排队假装能开。
 *   2. **空闲自停**（NODESIGN_STAGE_IDLE_MS，默认 30 分钟）：用户走开了进程就退，
 *      配置和记忆都在磁盘上。**下一句话到了自动再起** —— 起一次约 10 秒，记忆索引
 *      整份接回系统提示词，用户感知就是"第一句慢一点"。
 *   3. **每一句一条 run**：createRun(skillId:'stage') → result 到了 absorbResult 差分 →
 *      setRunMetrics / setRunModelUsage。日限闸门读的是 run_model_usage，
 *      演出烧的钱必须进同一本账，否则 RP 用户等于绕开配额。
 *
 * ## 通路跟主循环同一张表
 *
 * 订阅模型：不注入 API key（binary 一见 ANTHROPIC_API_KEY 就弃 OAuth），owner 得有
 * subscription 资格。API 模型：BASE_URL 指进程内 ingress，按会话 id 路由换上游换钥匙。
 * 这段照抄 session-loop 的 route 分支，只是不带 hooks / isolation / plugin 扫描那些
 * 演戏用不上的东西。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StageSession } from './session.js';
import { createStageTools, readMemoryIndex, readScenes, appendUserLine } from './tools.js';
import { STAGE_DIR, STAGE_CONFIG, readStageConfig } from '../../lib/kinds/stage.js';
import { resolveCardPath, readCardForStage, saveCardKeepingMachineBlock, ROLES_DIR, CARD_FILE } from './card.js';
import { getProject } from '../../projects/store.js';
import { getWorkspaceRoot } from '../../projects/workspace.js';
import { getProjectBus } from '../../ws/broker.js';
import { getBuiltinPluginsRoot } from '../agent/plugin-loader.js';
import { defaultModel } from '../agent/session-model.js';
import { resolveModelRoute, resolveSdkSpoofModel } from '../agent/model-context.js';
import { getOrStartIngress, registerIngressSession, unregisterIngressSession } from '../../lib/model-ingress.js';
import { AgentContext, freshTurnCounters } from '../agent/context.js';
import { createRun, markRunStarted, markRunSucceeded, markRunFailed, setRunMetrics, setRunModelUsage } from '../runs/store.js';
import { can } from '../../auth/tier.js';
import { getUserById } from '../../auth/users-store.js';
import { platform } from '../../runtime/platform.js';

const MAX_RUNNING = Number(process.env.NODESIGN_STAGE_MAX) || 2;
const IDLE_MS = Number(process.env.NODESIGN_STAGE_IDLE_MS) || 30 * 60_000;
/** 演出进程能加载的技能包：文风 / 剧情技法 / 亲密尺度。设计产线的一个都不给。 */
const STAGE_SKILLS = ['story-voice', 'story-craft', 'story-intimacy'];
export const SKINS = ['paper', 'jiangnan', 'night', 'terminal'];
/** 台面：这场戏的世界 / 规矩 / 怎么演（人物不在这里，人物在各自的角色卡上） */
export const TABLE_FILE = '台面.md';
const CARD_RE = /^角色\/[^/]+\/角色卡\.md$/;

/** @type {Map<string, StageRuntime>} */
const runtimes = new Map();

class StageRuntime {
  constructor(pid) {
    this.pid = pid;
    this.dir = getWorkspaceRoot(pid);
    this.session = null;
    this.sdkSid = null;           // 我们给 SDK 的会话 id（ingress 路由键）
    this.ingressRegistered = false;
    this.ctx = null;              // AgentContext：只借它的 absorbResult 差分，不 emit
    this.pendingRuns = [];        // FIFO：每句话一条 run，result 到了按序结账
    this.subscribers = new Set(); // SSE res
    this.idleTimer = null;
    this.live = '';               // 这一拍正在流出来的字（result 一到清空）
    this.error = null;
    this.startedAt = null;
    this.sources = [];            // 进了系统提示词的文件 [{rel, mtimeMs}]：台面 + 各角色卡。改了就重开
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
      type: 'status',
      running: this.running,
      busy: this.busy,
      queued: this.session?.queued || 0,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (!this.running) return;
    this.idleTimer = setTimeout(() => {
      // 正在写这一拍就再等一轮，别把半截拍掐了
      if (this.busy || this.session?.queued) { this.touch(); return; }
      stopStage(this.pid, 'idle').catch(() => {});
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }
}

function runtimeOf(pid) {
  let rt = runtimes.get(pid);
  if (!rt) { rt = new StageRuntime(pid); runtimes.set(pid, rt); }
  return rt;
}

export function getStageRuntime(pid) { return runtimes.get(pid) || null; }
export function runningStages() { return [...runtimes.values()].filter(r => r.running).length; }

async function writeStageConfig(dir, cfg) {
  const p = path.join(dir, STAGE_DIR, STAGE_CONFIG);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 给显示器 / 窗 / 卡看的整份状态（systemPrompt 不出门：那是演出进程的冻结区） */
export async function stageState(pid, { limit = 200 } = {}) {
  const rt = runtimeOf(pid);
  const cfg = await readStageConfig(rt.dir);
  if (!cfg) return null;
  return {
    config: publicConfig(pid, cfg, rt),
    scenes: await readScenes(rt.dir, { limit }),
    memoryIndex: await readMemoryIndex(rt.dir),
    live: rt.live,
    ...rt.status(),
    type: 'hello',
  };
}

/** 给显示器看的配置：systemPrompt（老形状）不出门；立绘路径换成能加载的 URL */
function publicConfig(pid, cfg, rt) {
  const { systemPrompt, ...pub } = cfg;
  const cast = (pub.cast || []).map(c => ({
    ...c,
    portrait: c.portrait && !/^(https?:)?\//.test(c.portrait)
      ? `/api/projects/${pid}/artifact-file/${String(c.portrait).split('/').map(encodeURIComponent).join('/')}`
      : (c.portrait || null),
  }));
  return { ...pub, cast, promptChars: rt?.promptChars || (systemPrompt ? String(systemPrompt).length : 0) };
}

async function statRel(dir, rel) {
  try { return (await fs.stat(path.join(dir, rel))).mtimeMs; } catch { return null; }
}

/**
 * 系统提示词从文件拼（2026-09-05 角色卡重用）：
 *   台面（stage/台面.md）      这场戏的世界 / 规矩 / 怎么演
 *   每张角色卡（人写的正文 + 机器维护的记忆索引块）
 *   这场戏的记忆索引（stage/memory/INDEX.md）
 *   台面工具提醒（机器写死的几句）
 * 老形状（stage.json 里直接存 systemPrompt）没有台面文件时还认。
 * 返回 { text, sources:[{rel, mtimeMs}], cast:[{name, note, portrait, card}] } —— sources 给 mtime 盯梢用。
 */
export async function composeStagePrompt(dir, stored) {
  const sources = [];
  const parts = [];
  const tableRel = `${STAGE_DIR}/${TABLE_FILE}`;
  let table = null;
  try { table = (await fs.readFile(path.join(dir, tableRel), 'utf8')).trim(); } catch { /* 没有台面文件 */ }
  if (table) {
    sources.push({ rel: tableRel, mtimeMs: await statRel(dir, tableRel) });
    parts.push(table);
  } else if (stored?.systemPrompt) {
    parts.push(String(stored.systemPrompt).trim());
  } else {
    throw Object.assign(new Error('这场戏没有台面（stage/台面.md）：先让 agent 用 open_stage 把世界和规矩交过来'), { status: 409 });
  }

  const cast = [];
  const cardTexts = [];
  for (const c of (stored?.cast || [])) {
    const rel = c.card || await resolveCardPath(dir, c.name);
    if (!rel) { cast.push({ name: c.name, note: c.note || '', portrait: c.portrait || null, card: null }); continue; }
    let card;
    try { card = await readCardForStage(dir, rel); } catch { cast.push({ name: c.name, note: c.note || '', portrait: null, card: rel }); continue; }
    sources.push({ rel, mtimeMs: await statRel(dir, rel) });
    cast.push({ name: card.name || c.name, note: c.note || card.note || '', portrait: card.portrait || c.portrait || null, card: rel });
    cardTexts.push(`### ${card.name || c.name}（卡在 ${rel}）\n${card.text}`);
  }
  if (cardTexts.length) {
    parts.push(`## 人物\n下面每个人一段，是他们各自的角色卡原文。开口前拿不准腔调就 Read 一遍他的卡。\n\n${cardTexts.join('\n\n')}`);
  }

  const idx = await readMemoryIndex(dir);
  if (idx && idx.trim()) {
    parts.push(`## 这场戏记住的事\n${idx.trim()}\n\n索引里的正文要用时自己 Read（在 ${STAGE_DIR}/memory/ 下）。`);
  }
  parts.push(
    '## 台面\n'
    + '每一拍都用 write_scene 写到台上（正文 + 2-4 枚把手；没有把手这一拍就没写完）。'
    + '不可逆的变化用 remember 记一条：某个人记得的事带 who 写进他的卡，这场戏的事不带。掷骰用 roll。'
    + '你的工具就这几件，不用 ToolSearch 去找别的。'
    + '**正文之外不要再复述剧情** —— 台上只认 write_scene 写进去的东西，你在工具之外说的话观众看不见。',
  );
  return { text: parts.join('\n\n'), sources, cast };
}

/** 进了系统提示词的文件有没有被改过（用户改卡 / 改台面 / 进程自己写了记忆索引） */
async function sourcesChanged(rt) {
  for (const s of rt.sources) {
    if ((await statRel(rt.dir, s.rel)) !== s.mtimeMs) return s.rel;
  }
  return null;
}

/** 通路：照 session-loop 的 route 分支，按模型表决定 env（订阅 = 不注 key；API = 走 ingress） */
async function buildEnv(rt, model, owner) {
  const {
    NODE_ENV: _dropNodeEnv, npm_config_production: _dropNpmProd,
    npm_config_omit: _dropNpmOmit, OLDPWD: _dropOldpwd,
    ...inherited
  } = process.env;
  const env = {
    ...inherited,
    PWD: rt.dir,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign-stage/0.0.1',
    CLAUDE_CONFIG_DIR: platform.claudeConfigDir,
  };
  // 不开工具延迟加载：台上只有四件 MCP 工具（已 alwaysLoad），内置的又砍到只剩五件，
  // 没有什么可省的；开了反而让模型在提示词禁止 ToolSearch 的前提下找不到 write_scene（09-05 真栽）
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
    // 订阅路：owner 没资格就别起 —— 跟 session-loop 同一道闸，别静默烧站主的订阅
    if (!can(owner, 'subscription')) {
      throw Object.assign(new Error('这个账号没有订阅通路资格，演出进程起不来'), { status: 403 });
    }
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    else delete env.ANTHROPIC_API_KEY;
    if (process.env.NODESIGN_FAST_MODEL) env.ANTHROPIC_SMALL_FAST_MODEL = process.env.NODESIGN_FAST_MODEL;
  }
  return env;
}

/**
 * 开戏 / 重开。`cfg` 给了就写进 stage.json（open_stage 那条路）；没给就用磁盘上那份
 * （空闲自停后用户再说话、服务端重启后再打开）。
 *
 * @param {string} pid
 * @param {object|null} cfg  { title, systemPrompt, cast:[{name,note}], vitals:[…], skin, model? }
 */
export async function startStage(pid, cfg = null) {
  const project = getProject(pid);
  if (!project) throw Object.assign(new Error('project not found'), { status: 404 });
  const rt = runtimeOf(pid);
  if (rt.running) return rt.status();

  let stored = await readStageConfig(rt.dir);
  if (cfg) {
    // 台面落文件（用户在画布上改得了）；老形状的 systemPrompt 只在没给台面时才留
    if (cfg.table) {
      const p = path.join(rt.dir, STAGE_DIR, TABLE_FILE);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(cfg.table).trim() + '\n', 'utf8');
    }
    // 在场者：每个名字对应一张卡；找不到卡就拒开 —— 卡是这个人的全部，没卡等于没这个人
    let cast = stored?.cast || [];
    if (Array.isArray(cfg.cast)) {
      cast = [];
      for (const c of cfg.cast) {
        const name = String(c?.name || c || '').trim();
        if (!name) continue;
        const rel = await resolveCardPath(rt.dir, name);
        if (!rel) throw Object.assign(new Error(`没有「${name}」的角色卡（${ROLES_DIR}/${name}/${CARD_FILE}）：先用 cast_role 写卡再开戏`), { status: 409 });
        cast.push({ name, card: rel, ...(c?.note ? { note: String(c.note).slice(0, 60) } : {}) });
      }
    }
    stored = {
      ...(stored || {}),
      title: String(cfg.title || stored?.title || '演出').slice(0, 60),
      ...(cfg.table ? { systemPrompt: undefined } : (cfg.systemPrompt ? { systemPrompt: String(cfg.systemPrompt) } : {})),
      cast,
      vitals: Array.isArray(cfg.vitals) ? cfg.vitals : (stored?.vitals || []),
      skin: SKINS.includes(cfg.skin) ? cfg.skin : (stored?.skin || 'paper'),
      model: cfg.model || stored?.model || null,
      startedAt: stored?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (stored.systemPrompt === undefined) delete stored.systemPrompt;
    await writeStageConfig(rt.dir, stored);
  }
  if (!stored) {
    throw Object.assign(new Error('这个项目还没有开过戏：先让 agent 用 open_stage 把台面和在场者交过来'), { status: 409 });
  }
  if (runningStages() >= MAX_RUNNING) {
    throw Object.assign(new Error(`同时在演的场数已满（${MAX_RUNNING}），等一场散了再开`), { status: 503 });
  }

  const model = stored.model || defaultModel();
  const owner = project.ownerId ? getUserById(project.ownerId) : null;
  rt.sdkSid = randomUUID();
  rt.error = null;
  rt.live = '';
  const env = await buildEnv(rt, model, owner);
  const composed = await composeStagePrompt(rt.dir, stored);
  const systemPrompt = composed.text;
  rt.sources = composed.sources;
  rt.promptChars = systemPrompt.length;
  // 卡上读到的名字 / 小字 / 立绘回填给显示器（stage.json 里 cast 只存名字和卡路径）
  const merged = { ...stored, cast: composed.cast };
  if (JSON.stringify(merged.cast) !== JSON.stringify(stored.cast)) {
    await writeStageConfig(rt.dir, merged);
    stored = merged;
  }

  rt.ctx = new AgentContext({
    runId: '__stage_pending__', skillId: 'stage',
    workspaceRoot: rt.dir, sessionId: rt.sdkSid, appModel: model,
  });

  const tools = createStageTools({
    dir: rt.dir,
    onScene: (row) => { rt.live = ''; rt.broadcast({ type: 'scene', row }); },
    // 进程自己重写了卡上的索引块：把盯梢的 mtime 跟上，别把它当成用户改了设定
    onCardTouched: async (rel) => {
      const src = rt.sources.find(x => x.rel === rel);
      if (src) src.mtimeMs = await statRel(rt.dir, rel);
    },
  });

  rt.session = new StageSession({
    cwd: rt.dir,
    model: resolveSdkSpoofModel(model),
    env,
    sessionId: rt.sdkSid,
    systemPrompt,
    mcpServers: { stage: tools },
    plugins: [{ type: 'local', path: path.join(getBuiltinPluginsRoot(), 'nodesign') }],
    skills: STAGE_SKILLS,
    onEvent: (e) => onSessionEvent(rt, e),
  });
  rt.session.start();
  rt.startedAt = new Date().toISOString();
  rt.touch();
  rt.broadcast(rt.status());
  // 画布要知道这个项目现在有一场戏（清单接口重拉，卡才出现）
  getProjectBus(pid).publish({ type: 'stage.changed', root: STAGE_DIR, running: true });
  console.log(`[stage] ${pid} 开演 model=${model} sid=${rt.sdkSid.slice(0, 8)} prompt=${systemPrompt.length}c sources=${rt.sources.map(x => x.rel).join(',')}`);
  return { ...rt.status(), promptChars: systemPrompt.length };
}

function onSessionEvent(rt, e) {
  if (e.type === 'init') {
    // 开局对账：台上那四件必须在 SDK 真注册进会话的名单里（跟主循环 init-contract 同一个理由）
    const have = (e.tools || []).filter(n => /^mcp__stage__/.test(n));
    if (have.length < 4) {
      // 工具面不齐 = 这场戏没法写到台上（模型只会把整拍写成纯文本）。当场喊出来，别让用户对着
      // 一个只会说不会写的进程猜。09-05 真栽过：schema 里一个 z.record 让四件全没了。
      rt.error = `演出进程的工具面不齐（只见到 ${have.join(', ') || '无'}），台上写不了字 —— 这是服务端的问题，不是你的`;
      console.error(`[stage] ${rt.pid} ${rt.error}`);
      rt.broadcast({ type: 'error', error: rt.error });
      rt.broadcast(rt.status());
    } else {
      console.log(`[stage] ${rt.pid} 台面就位 ${have.length} 件，model=${e.model}`);
    }
    return;
  }
  if (e.type === 'text') {
    rt.live += e.text;
    rt.broadcast({ type: 'text', text: e.text });
    return;
  }
  if (e.type === 'tool') {
    rt.broadcast({ type: 'tool', name: e.name });
    return;
  }
  if (e.type === 'turn_end') {
    settleRun(rt, e);
    rt.live = '';
    rt.broadcast({ type: 'turn_end', costUsd: rt.ctx?.counters?.totalCostUsd ?? null, error: e.error || null });
    rt.broadcast(rt.status());
    rt.touch();
    return;
  }
  if (e.type === 'error') {
    rt.error = e.error;
    // 进程死在半路：排着的 run 全标失败，别留 pending 行骗"有没有回合在飞"的判断
    for (const id of rt.pendingRuns.splice(0)) { try { markRunFailed(id, e.error); } catch { /* */ } }
    rt.broadcast({ type: 'error', error: e.error });
    rt.broadcast(rt.status());
    console.error(`[stage] ${rt.pid} 演出进程出错: ${e.error}`);
  }
}

/** 一条 result = 结一条账。差分靠 AgentContext（modelUsage 是会话累计值，要跟上一条做差）。 */
function settleRun(rt, e) {
  const runId = rt.pendingRuns.shift();
  const ctx = rt.ctx;
  if (!ctx) return;
  ctx.counters = freshTurnCounters();
  try { ctx.absorbResult(e.result); } catch (err) { console.warn('[stage] absorbResult 失败:', err.message); }
  if (!runId) return;
  try {
    setRunMetrics(runId, ctx.counters);
    setRunModelUsage(runId, ctx.counters.modelUsage);
    if (e.error) markRunFailed(runId, String(e.error));
    else markRunSucceeded(runId, {});
  } catch (err) { console.warn('[stage] 结账失败:', err.message); }
}

/**
 * 用户对台上说一句。进程没在跑就先起（空闲自停 / 重启后的第一句）。
 * 同时在 scenes.jsonl 里记下用户这一行 —— 显示器画"你"的那一栏靠它。
 */
export async function sayToStage(pid, text, { userId = null } = {}) {
  const rt = runtimeOf(pid);
  // 进了系统提示词的文件改过（用户改卡 / 改台面）→ 这一句先重开再说。冻结区只能整份重付，
  // 但用户感知只是"这一句慢十秒"，不用知道"重开"这件事存在。正在写的那拍不掐。
  if (rt.running && !rt.busy && !rt.session?.queued) {
    const changed = await sourcesChanged(rt);
    if (changed) {
      console.log(`[stage] ${pid} 设定文件改了（${changed}），重开`);
      await stopStage(pid, 'setup-changed');
    }
  }
  if (!rt.running) await startStage(pid, null);
  const project = getProject(pid);
  const run = createRun({
    skillId: 'stage', brief: text.slice(0, 200), projectId: pid,
    userId: userId || project?.ownerId || null, sessionId: rt.sdkSid,
    metadata: { stage: true },
  });
  markRunStarted(run.id);
  rt.pendingRuns.push(run.id);
  rt.ctx.runId = run.id;
  const row = await appendUserLine(rt.dir, text);
  rt.broadcast({ type: 'scene', row });
  const r = rt.session.say(text);
  rt.touch();
  rt.broadcast(rt.status());
  return { ...r, runId: run.id };
}

export async function stopStage(pid, reason = 'user') {
  const rt = runtimes.get(pid);
  if (!rt || !rt.session) return { running: false };
  clearTimeout(rt.idleTimer);
  const s = rt.session;
  rt.session = null;
  try { await s.stop(); } catch { /* 已经退了 */ }
  if (rt.ingressRegistered) { try { unregisterIngressSession(rt.sdkSid); } catch { /* */ } rt.ingressRegistered = false; }
  for (const id of rt.pendingRuns.splice(0)) { try { markRunFailed(id, `stage stopped: ${reason}`); } catch { /* */ } }
  rt.live = '';
  rt.broadcast({ ...rt.status(), running: false, busy: false, stoppedFor: reason });
  getProjectBus(pid).publish({ type: 'stage.changed', root: STAGE_DIR, running: false });
  console.log(`[stage] ${pid} 散场（${reason}）`);
  return { running: false };
}

/** 改皮肤 / 标题 / 在场者 / 状态面板 —— 不碰 systemPrompt（那要重开一场） */
export async function patchStageConfig(pid, patch) {
  const rt = runtimeOf(pid);
  const cfg = await readStageConfig(rt.dir);
  if (!cfg) throw Object.assign(new Error('还没有这场戏'), { status: 404 });
  const next = { ...cfg, updatedAt: new Date().toISOString() };
  if (patch.skin !== undefined) next.skin = SKINS.includes(patch.skin) ? patch.skin : cfg.skin;
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 60);
  if (Array.isArray(patch.cast)) next.cast = patch.cast;
  if (Array.isArray(patch.vitals)) next.vitals = patch.vitals;
  await writeStageConfig(rt.dir, next);
  const pub = publicConfig(pid, next, rt);
  rt.broadcast({ type: 'config', config: pub });
  getProjectBus(pid).publish({ type: 'stage.changed', root: STAGE_DIR, running: rt.running });
  return pub;
}

/**
 * 用户在画布上保存台面 / 角色卡（api PUT /stage/file）。只收这两种路径。
 * 角色卡：机器块以磁盘为准接回去。台面：原样写。都不立刻重开 —— sayToStage 看 mtime。
 */
export async function saveStageFile(pid, rel, text) {
  const rt = runtimeOf(pid);
  const clean = String(rel || '').replace(/\\/g, '/');
  if (clean.includes('..')) throw Object.assign(new Error('bad path'), { status: 400 });
  if (clean === `${STAGE_DIR}/${TABLE_FILE}`) {
    const p = path.join(rt.dir, clean);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(text).replace(/\s*$/, '') + '\n', 'utf8');
  } else if (CARD_RE.test(clean)) {
    await fs.mkdir(path.join(rt.dir, path.dirname(clean)), { recursive: true });
    await saveCardKeepingMachineBlock(rt.dir, clean, text);
  } else {
    throw Object.assign(new Error('只能改台面（stage/台面.md）和角色卡（角色/<名>/角色卡.md）'), { status: 400 });
  }
  getProjectBus(pid).publish({ type: 'run.file_changed', filePath: clean, event: 'change' });
  return { ok: true, path: clean, reopenOnNextLine: !!(rt.running && rt.sources.some(s => s.rel === clean)) };
}

/** SSE 订户：先发整份快照（hello），之后跟着事件。 */
export async function subscribeStage(pid, res) {
  const rt = runtimeOf(pid);
  rt.subscribers.add(res);
  const hello = await stageState(pid);
  if (hello) res.write(`data: ${JSON.stringify(hello)}\n\n`);
  else res.write(`data: ${JSON.stringify({ type: 'hello', config: null, scenes: [], ...rt.status() })}\n\n`);
  return () => { rt.subscribers.delete(res); };
}

/** 进程退出前把台上的人都送走（pm2 restart 那一刻） */
export async function stopAllStages(reason = 'shutdown') {
  await Promise.all([...runtimes.keys()].map(pid => stopStage(pid, reason).catch(() => {})));
}
