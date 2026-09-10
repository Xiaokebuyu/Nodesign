/**
 * server/engine/agent/session-model.js — 会话跑在哪个模型上，这里是唯一答案
 *
 * 在此之前这个事实有 5 个读法和 3 个写法，各不相同：
 *
 *   读：session-loop 内联一条 `cfg.model || env || 'kimi-k2.6'`（真正生效的那条）；
 *       turn.js 又抄了一遍同样的链算 prevEffective；canvas.js 的 readSessionConfig
 *       只读文件不带 env 兜底；sessions.js 问 `querySession.ctx?.appModel` —— 而
 *       activeQuerySessions 的 ctx 字段**从注册起就是 null，没有任何地方填过**，
 *       那一支永远走不到；前端干脆只信自己的 localStorage。
 *   写：turn.js 的 body.model（写文件 + 空闲时重启 query）；canvas.js 的
 *       PATCH /config（任意字段透传，写了文件但不重启 query，跑着的会话不认账）；
 *       POST /runs/:runId/model 调 SDK setModel（只改运行时，不落文件，下次 resume 变回去）。
 *
 * 同一个事实有五份算法，就一定会有对不上的时候 —— 比如按钮上写着 Sonnet、
 * 会话实际跑 Opus，或者选了「默认」什么也没发生。
 *
 * 优先级（跟 session-loop 原来那条完全一致，只是搬到了一处）：
 *   调用方显式指定  >  session-config.json 的 model  >  NODESIGN_MODEL  >  兜底常量
 *
 * 「覆盖」(override) 指 session-config.json 里那一项。清掉它 = 回到全局默认，
 * 这是「默认」那个选项该做的事 —— 以前它什么也不做。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getQuerySession, closeQuerySession } from '../runs/active-runs.js';
import { canonicalModelId } from './model-context.js';

const CONFIG_NAME = 'session-config.json';

/**
 * NODESIGN_MODEL 没配时的兜底。原值是 kimi 网关时代的 'kimi-k2.6'，08-21 深夜 kimi 行从模型表删除后
 * 改成订阅默认行（一个不在表里的名字会被 resolveModelRoute 当订阅模型，兜底必须是真名）；
 * 正常部署 .env 里一定有 NODESIGN_MODEL，走不到这里。
 */
const LEGACY_FALLBACK_MODEL = 'claude-sonnet-5[1m]';

/** 全局默认模型（不含会话覆盖）。每次现读 env —— 进程内改 env 也能生效 */
export function defaultModel() {
  return process.env.NODESIGN_MODEL || LEGACY_FALLBACK_MODEL;
}

// ── config 文件的读改写串行化 ──
// turn.js（发消息时）和模型接口（用户点 picker 时）可能同时改同一个文件，
// 各自 read-modify-write 会互相吃掉对方的字段。按路径排队。
/** @type {Map<string, Promise<any>>} */
const configLocks = new Map();

function withConfigLock(sessionRoot, fn) {
  const key = path.resolve(sessionRoot);
  const prev = configLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 链上留的是"完成信号"，不是结果，避免上一个的异常传染下一个
  configLocks.set(key, next.then(() => {}, () => {}));
  return next;
}

/**
 * ⚠️ 参数是**会话私档目录**（`<工作区>/.nd/<sid>/`），不是工作区根。
 *
 * 2026-08-07 扁平化之前两者是同一个目录（一个会话一个沙盒），所以这里叫
 * `sessionRoot` 也没错。现在工作区是全项目共用的 —— 传工作区根进来的话，
 * 一个项目里所有会话会共用一份 session-config.json，**在一条会话里换模型，
 * 另一条会话跟着变**。调用方一律传 getSessionMetaDir(pid, sid)。
 */
function configPath(sessionMetaDir) {
  // 传错了要当场炸，不能默默共用一份配置。这个错误的表现是"在一条会话里换了
  // 模型，另一条会话也变了"——没人会把它跟一个路径参数联系起来，静默半年都可能。
  if (!/[/\\]\.nd[/\\][0-9a-f-]{36}$/i.test(path.resolve(sessionMetaDir))) {
    throw new Error(
      `[session-model] 需要会话私档目录（<工作区>/.nd/<sid>/），拿到的是 ${sessionMetaDir}。`
      + '用 getSessionMetaDir(pid, sid)，别传工作区根。',
    );
  }
  return path.join(sessionMetaDir, CONFIG_NAME);
}

/** 读整份 config（文件不存在 / 坏了 → {}）。不带任何默认字段填充 */
export async function readSessionConfigFile(sessionRoot) {
  try {
    const raw = await fs.readFile(configPath(sessionRoot), 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {};
    return cfg;
  } catch {
    return {};
  }
}

/**
 * 会话自己的模型覆盖；没设过返回 null。
 *
 * ⭐ 出门前过一道 canonicalModelId（09-10）：文件里存的是**当时那个 id**，而行是会改名的
 * （model-table.js 的 RENAMED_MODELS）。不翻的话，那些老会话下一次发消息会被 turn 入口的
 * 白名单挡下（403「这个会话指向的模型现在不可用」），每一个都得人手换一次。
 * 不改盘上的文件：翻译是读的时候做的，下次用户自己换模型时才会把新名写回去。
 */
export async function readSessionModelOverride(sessionRoot) {
  const cfg = await readSessionConfigFile(sessionRoot);
  const raw = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null;
  return raw ? canonicalModelId(raw) : null;
}

/**
 * 这个会话实际会跑的模型。
 * @returns {Promise<{ model: string, override: string|null, fallback: string }>}
 *   override = 用户在这个会话里选过的；null 表示跟随全局默认
 */
export async function resolveSessionModel(sessionRoot) {
  const override = await readSessionModelOverride(sessionRoot);
  const fallback = defaultModel();
  return { model: override || fallback, override, fallback };
}

/**
 * 写 / 清会话的模型覆盖。
 *
 * @param {string} sessionRoot
 * @param {string|null} model  字符串 = 设成它；null = **清掉覆盖**，回到全局默认
 * @returns {Promise<{ model: string, override: string|null, changed: boolean, previous: string }>}
 *   changed 指"实际生效的模型变了没有" —— 调用方据此决定要不要重启空闲 query。
 *   把覆盖设成跟全局默认一样的值不算变（跑着的会话本来就是那个模型）。
 */
export async function writeSessionModelOverride(sessionRoot, model) {
  const wanted = typeof model === 'string' && model.trim() ? model.trim() : null;
  return withConfigLock(sessionRoot, async () => {
    const cfg = await readSessionConfigFile(sessionRoot);
    const fallback = defaultModel();
    const previous = (typeof cfg.model === 'string' && cfg.model.trim()) ? cfg.model.trim() : fallback;
    const next = { ...cfg, updatedAt: new Date().toISOString() };
    if (wanted) next.model = wanted;
    else delete next.model;          // 清覆盖 = 删字段，不是写 null
    const effective = wanted || fallback;
    if (previous !== effective || (cfg.model || null) !== wanted) {
      await fs.writeFile(configPath(sessionRoot), JSON.stringify(next, null, 2), 'utf8');
    }
    return { model: effective, override: wanted, changed: previous !== effective, previous };
  });
}

/**
 * 改模型的**完整**动作：写配置 + 让已经跑着的会话认账。
 *
 * 这两步必须绑在一起。以前 PATCH /config 只写文件不碰 query，配置说 Opus、
 * 跑着的进程还是 Sonnet，要等下次 resume 才对上，中间这段时间界面和事实分家。
 *
 * 空闲时才关 query：turn 正在跑就只落配置，等这一轮结束后自然重启（前端 picker
 * 在运行中是禁用的，这里是兜底）。closeQuerySession 之后下一条消息走
 * startNewRunSession，从同一份 jsonl 以新模型 resume —— 对话内容无损，上下文
 * 窗口 / spoofing alias / thinking 配置全按新模型重算。
 *
 * @param {string} sessionId
 * @param {string} sessionRoot
 * @param {string|null} model  null = 清掉覆盖
 * @param {string} reason      日志用
 */
export async function applySessionModel(sessionId, sessionRoot, model, reason = 'api') {
  const result = await writeSessionModelOverride(sessionRoot, model);
  let restarted = false;
  if (result.changed) {
    const qs = getQuerySession(sessionId);
    if (qs && !qs.currentRunId) {
      closeQuerySession(sessionId, 'model_change');
      restarted = true;
    }
    console.info(
      `[session-model] sid=${sessionId.slice(0, 8)} ${result.previous} → ${result.model}`
      + ` (${reason}${restarted ? ', query restarted' : ', applies on next resume'})`,
    );
  }
  return { ...result, restarted };
}
