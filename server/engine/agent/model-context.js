/**
 * server/engine/agent/model-context.js — 模型的单一真相源（2026-08-19 重建）。
 *
 * 历史形态是三张平行表（APP_TO_SDK_MODEL / APP_MODEL_REAL_WINDOW / SELECTABLE_MODELS），
 * 文件头自己就写着"写错一个字，两处都只会静默降级"。现在收成一张 MODELS 表 +
 * 一张 UPSTREAMS 表，旧的每个导出都从表派生，加载时做一致性断言（撞车当场炸，
 * 不静默）。
 *
 * ## 两条通路
 *
 * - **订阅**（没有 api 字段的行）：模型真名 SDK 认识，session-loop 不注入任何
 *   ANTHROPIC_* env，binary 走 ~/.claude 的 OAuth。今天生产的全部流量。
 * - **API**（有 api 字段的行）：请求经 server/lib/model-ingress.js（进程内
 *   Anthropic 范式通用入口）打到上游。SDK 视角看到的是 sdkAlias（让它把
 *   context window 算对），入口在出口把 alias 还原成 wireModel、按上游换钥匙、
 *   按行开怪癖修补（tool_result 图片提升等）。
 *
 * ## SDK spoofing 为什么存在（Kimi 时代的发现，机制不变）
 *
 * SDK binary 内部 model registry 不识别非 Claude 名 → rawMaxTokens fallback
 * 200k → auto-compact 在 ~180k 触发，浪费上游真实容量。喂 SDK 一个它认识的
 * 1M alias，autoCompactWindow=230400 真生效。SDK 序列化请求时会剥 `[1m]`
 * 后缀，所以入口的反查表要同时认带后缀和不带后缀两种形态。
 *
 * ## 记账
 *
 * SDK 的 costUSD 按 alias 的 Claude 价目表算，API 模型全是虚价（Kimi 时代按
 * Opus 价虚高 30×）。repriceUsageDeltas 把 usage key 还原成 appModel、按行内
 * prices 重算 costUsd。行没填 prices = 沿用 SDK 虚价（接真流量前必须填价）。
 *
 * ## sdkAlias 两种写法（08-25 起）
 *
 * - **不写（默认）**：派生时补上共用别名 SHARED_SDK_ALIAS，只按 id 进反查表，
 *   靠会话级路由分辨（session-routes.resolveSessionWire）。加新行不用考虑别名。
 * - **显式写 = 独占坑位**：alias 三种形态都进反查表，没会话也能按 alias 反查。
 *   ⚠️ 硬约束只对这种成立：一个独占 sdkAlias 不能被两个 API 模型共用 ——
 *   反查靠它，撞了整条路由和记账都错。模块加载断言兜底。
 */

import { can, localGenApproved, DENIAL } from '../../auth/tier.js';
import { platform } from '../../runtime/platform.js';
import { UPSTREAMS_BUILTIN, MODELS_BUILTIN, BRANDS, SHARED_SDK_ALIAS } from './model-table.js';
import { loadLocalConfig } from '../../runtime/local-config.js';
import { relayModelEntry } from '../../runtime/relay-client.js';
import { loadPrefs } from '../../runtime/local-prefs.js';

export { BRANDS, SHARED_SDK_ALIAS };

// ── 内置表 + 用户插槽合并（08-22）──
const external = loadLocalConfig();
export const UPSTREAMS = Object.freeze({ ...UPSTREAMS_BUILTIN, ...external.upstreams });
/** 配置条目 → 表行（字段名一一对应，见 local-config.js 文件头；sdkAlias 不许手填 = 永远走下面的共用别名默认） */
function toExternalRow(m) {
  const { id, label, desc, brand, window, uncensored, upstream, wireModel, fastModel, ...api } = m;
  return Object.freeze({
    id, window, brand, external: true, ...(uncensored ? { uncensored: true } : {}),
    select: Object.freeze({ label, desc }),
    api: Object.freeze({ upstream, wireModel, fastModel: fastModel || id, ...api }),
  });
}
// sdkAlias 可选（08-25 固化）：API 行不写 = 补上共用别名 SHARED_SDK_ALIAS（内置行、外部插槽同一条路）。
// 共用别名的行**不进 WIRE_LOOKUP 的 alias 键**，只按 id 可查，靠 ingress/session-routes.js 会话优先路由
// 分辨（一个会话只认自己那行和自己的 fast 行）；没注册会话的请求用这个 alias 发过来一律 502（探针要带
// 会话前缀）。独占别名的行才显式写 sdkAlias，语义见 model-table.js 字段说明。
function withDefaultAlias(row) {
  if (!row.api || row.api.sdkAlias) return row;
  return Object.freeze({ ...row, api: Object.freeze({ ...row.api, sdkAlias: SHARED_SDK_ALIAS }) });
}
const MODELS = Object.freeze([...MODELS_BUILTIN, ...external.models.map(toExternalRow)].map(withDefaultAlias));
/** 外部插槽被整条丢掉的原因（启动日志一份、GET /api/local/config 一份，同一个数组） */
export const MODEL_CONFIG_ERRORS = external.errors;

// ── 派生索引（模块加载时构建 + 断言）──
// 分级：内置行的错照旧当场炸（那是代码错）；外部行的错丢行 + 记进 MODEL_CONFIG_ERRORS（那是用户配置错，别拉下整站）

const BY_ID = new Map();
/** wire 名（appModel / sdkAlias / alias 剥 [1m] 后缀形态）→ 行。入口反查用 */
const WIRE_LOOKUP = new Map();

function checkRow(row) {
  if (!BRANDS.includes(row.brand)) throw new Error(`[model-context] ${row.id} 的 brand 必须是 BRANDS 之一：${row.brand}`);
  if (!row.api) return;
  if (!UPSTREAMS[row.api.upstream]) throw new Error(`[model-context] ${row.id} 指向不存在的 upstream: ${row.api.upstream}`);
  // alias 必须是本表里的订阅 Claude 名 —— SDK 才认识、窗口才查得到
  if (!row.api.sdkAlias || !BY_ID.has(row.api.sdkAlias) || BY_ID.get(row.api.sdkAlias).api) throw new Error(`[model-context] ${row.id} 的 sdkAlias 必须是表内订阅模型名：${row.api.sdkAlias}`);
  const fast = BY_ID.get(row.api.fastModel);
  if (!fast || !fast.api) throw new Error(`[model-context] ${row.id} 的 fastModel 必须是表内 API 模型：${row.api.fastModel}`);
}
for (const row of MODELS) {
  if (BY_ID.has(row.id)) throw new Error(`[model-context] 模型 id 重复：${row.id}`);
  BY_ID.set(row.id, row);
}
// 共用别名的本体必须始终是表内一条订阅 Claude 行：它是「不写 sdkAlias」的默认值，哪怕此刻没行在用，
// 删掉/改坏那条订阅行也要当场炸，不能等到下一条新行加进来才发现 SDK 不认识、窗口查不到。
{
  const shared = BY_ID.get(SHARED_SDK_ALIAS);
  if (!shared || shared.api) throw new Error(`[model-context] SHARED_SDK_ALIAS（${SHARED_SDK_ALIAS}）必须是表内订阅模型行 —— 它是 sdkAlias 不写时的默认值`);
}
for (const row of MODELS) {
  try { checkRow(row); } catch (err) {
    if (!row.external) throw err;
    BY_ID.delete(row.id); MODEL_CONFIG_ERRORS.push({ where: `models (${row.id})`, message: err.message }); continue;
  }
  if (!row.api) continue;
  // 共用别名的行（sdkAlias 没写、派生时补的默认值）只按 id 进反查表：那个别名同时属于好几行，
  // 全表反查分不出谁是谁，只有会话知道（session-routes.resolveSessionWire 主行优先）。
  const sharesAlias = row.api.sdkAlias === SHARED_SDK_ALIAS;
  const keys = sharesAlias ? [row.id] : [row.id, row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, '')];
  for (const k of keys) {
    const prev = WIRE_LOOKUP.get(k);
    if (prev && prev !== row) throw new Error(`[model-context] wire 名撞车：'${k}' 同时属于 ${prev.id} 和 ${row.id}（独占 sdkAlias 不能共用；不想独占就别写 sdkAlias，让它走共用别名）`);
    WIRE_LOOKUP.set(k, row);
  }
}
if (MODEL_CONFIG_ERRORS.length) {
  console.warn(`[model-context] 本地插槽配置有 ${MODEL_CONFIG_ERRORS.length} 处问题（对应条目已跳过）${external.path ? `：${external.path}` : ''}`);
  for (const e of MODEL_CONFIG_ERRORS) console.warn(`  - ${e.where}: ${e.message}`);
}

/** 当前进程里真正生效的外部行 id（配置页据此判「已生效 / 要重启」） */
export function externalModelIds() {
  return [...BY_ID.values()].filter((r) => r.external).map((r) => r.id);
}

/** 一行在入口会以哪些 body.model 名出现（id / sdkAlias / 剥 [1m] 的 alias）。session-routes 会话优先匹配用；不认识的 id → [] */
export function wireNamesOf(appModel) {
  const row = appModel ? BY_ID.get(appModel) : null;
  if (!row) return [];
  return row.api ? [row.id, row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, '')] : [row.id];
}

// ── 旧导出（签名不变，全部改为查表）──

/**
 * picker 的**全量**清单（含带闸门的行）。⚠️ 对外接口一律用
 * `selectableModelsFor(user)`，直接用这个等于把闸门拆了。保留导出是因为它是
 * 「表里哪些行可选」的唯一真相，闸门只是在它上面过滤。
 */
export const SELECTABLE_MODELS = Object.freeze(
  MODELS.filter((m) => m.select).map((m) => Object.freeze({ id: m.id, brand: m.brand, ...m.select })),
);

/** 这个 appModel 出自谁家（BRANDS 之一）。不认识的 id → null，调用方自己决定兜底，别猜。 */
export function brandOfModel(appModel) {
  return BY_ID.get(appModel)?.brand || null;
}

/**
 * 按用户过滤可选模型。两种闸不同语义（08-21）：
 *   - `gate: 'localGen'`：**看不见**。只对 admin / 已批准本地产线的账号露出（同 roll_film 那套批准制）
 *   - `gate: 'subscription'`：**看得见选不了**。订阅 Claude 行对没有订阅资格的账号
 *     （auth/tier.js can(user,'subscription')=false：basic 档/公开注册号）仍在清单里，但带 `locked: true`；
 *     用户拍板「选择器依旧在，无配额账户无法请求，并且弹框提示」—— 让人知道有更强的档、
 *     怎么拿到（邀请码），而不是当它不存在
 *
 * ⚠️ 三处消费方必须都走它/allowedModelsFor：GET /model 的清单、PUT /model 的校验、
 * turn.js 的模型校验。少一处就是一个绕过闸门的后门 —— 2026-08-19 的独立评审正是在
 * turn.js 抓到过这种漏校验。校验用 allowedModelsFor（不含 locked），清单用本函数。
 */
export const SUBSCRIPTION_LOCK_REASON = DENIAL.subscription;

/**
 * 选择器分两个面（09-06，用户拍板）：首页 / 画布的选择器是 `canvas`，演出显示器里「设置循环」那块是 `stage`。
 * 表里 `select.only: 'stage'` 的行**只在演出面出现**（演出行点死 particle、整场最多 8 张图，画布上
 * 选它只会在第 9 张图上莫名其妙 400，所以画布干脆不列）；没写 only 的行两个面都有。
 * ⚠️ 校验（allowedModelsFor / defaultModelFor）跟清单走同一个 scope：画布的 turn / PUT model 校验
 * 看不见演出行，等于画布上钉着演出行的老会话会被 403 —— 下架时要连带迁移会话钉子（scripts/migrate-canvas-model.mjs）。
 */
export const PICKER_SCOPES = Object.freeze(['canvas', 'stage']);
const scopeOf = (opts) => {
  const scope = opts?.scope || 'canvas';
  if (!PICKER_SCOPES.includes(scope)) throw new Error(`选择器面只认 ${PICKER_SCOPES.join(' / ')}，拿到 ${scope}`);
  return scope;
};
const inScope = (m, scope) => !m.only || m.only === scope;

export function hasSubscriptionAccess(user) {   // 订阅 Claude 资格 = 档位能力（auth/tier.js）；薄封装只为调用点读着顺
  return can(user, 'subscription');
}

const upstreamKeyPresent = (row) => { if (!row.api) return !!platform.claudeAuthPresent(); const up = UPSTREAMS[row.api.upstream]; return !up || up.authStyle === 'none' || !!up.key || !!(up.keyEnv && process.env[up.keyEnv]); };   // 无 api = 内置 Claude 行：本地版看本机凭据

/**
 * 这一行的请求从哪走（本地分发版的核心分岔，09-06）：
 *   'local'  本机有钥匙（Claude 行 claude login 过 / API Key；外部插槽填了 key；内置行 env 里有 keyEnv）→ 进程内 ingress 或直连
 *   'relay'  本机没钥匙但站主 relay 的目录里有这一行 → 请求发到站主服务器（runtime/relay-client.js）
 *   null     两边都没有 → 选择器不列
 * hosted 恒为 'local'（服务器自己有钥匙，缺了让请求 502 fail-loud，跟以前一样）。
 * ⭐ 本机优先：用户自己配了钥匙就是明确想用自己的，不该被 relay 悄悄接管。
 */
export function modelSourceFor(appModel) {
  const row = BY_ID.get(appModel);
  if (!row) return null;
  if (!platform.isLocal) return 'local';
  if (upstreamKeyPresent(row)) return 'local';
  const entry = relayModelEntry(appModel);
  return entry ? 'relay' : null;
}

export function selectableModelsFor(user, opts) {
  const scope = scopeOf(opts);
  const approved = localGenApproved(user);   // 档位 + 逐人批准，同 paint_still / roll_film / 演出端点一把尺
  const subscribed = hasSubscriptionAccess(user);
  const out = [];
  for (const m of SELECTABLE_MODELS) {
    if (!inScope(m, scope)) continue;   // 只在演出面出现的行，画布面看不见也选不了
    const source = modelSourceFor(m.id);
    if (!source) continue;   // 本地版：本机没钥匙、relay 也没有 → 藏起来；hosted 永远 'local'
    // 本地版：用户在设置页藏起来的行带 hidden 标（选择器不列，设置页要列出来给他再打开；不影响能不能用）
    const hidden = platform.isLocal && loadPrefs().hiddenModels.includes(m.id) ? { hidden: true } : {};
    if (source === 'relay') {
      // relay 那头按站主那边的档位判过了（锁/不锁、原因），本地的 user 是 LOCAL_OWNER（admin），本地档位判断在这一行不适用
      const entry = relayModelEntry(m.id);
      out.push(entry.locked ? { ...m, locked: true, lockReason: entry.lockReason || SUBSCRIPTION_LOCK_REASON, source, ...hidden } : { ...m, source, ...hidden });
      continue;
    }
    if (m.gate === 'localGen') { if (approved) out.push({ ...m, ...hidden }); continue; }
    if (m.gate === 'subscription' && !subscribed) { out.push({ ...m, locked: true, lockReason: SUBSCRIPTION_LOCK_REASON, ...hidden }); continue; }
    out.push({ ...m, ...hidden });
  }
  return out;
}

/** 真能请求的（不含 locked）。PUT /model 与 turn.js 校验用这份 */
export function allowedModelsFor(user, opts) {
  return selectableModelsFor(user, opts).filter((m) => !m.locked);
}

/** 这个模型对这个用户是「看得见选不了」吗（在清单里且 locked）。turn 拒绝时据此回 403 而不是 400 */
export function isModelLockedFor(user, appModel, opts) {
  return selectableModelsFor(user, opts).some((m) => m.id === appModel && m.locked);
}

/**
 * 这个用户没选过时用哪个：表里标 `default: true` 的行（08-26 起 = minimax-m3），它对该用户
 * 不可选时退到第一个可选的。前端 picker 与新会话的兜底都问这条，不再各自硬编码。
 */
export function defaultModelFor(user, opts) {
  const scope = scopeOf(opts);
  const allowed = allowedModelsFor(user, { scope });
  // 演出面：没有订阅资格的账号（basic / 公开注册号）默认落在 `stageDefault` 的行（演出行，每步更快）；
  // 有订阅资格的账号默认不变（他们本来就会自己挑 sonnet / opus 演）。
  if (scope === 'stage' && !hasSubscriptionAccess(user)) {
    const stageRow = allowed.find((m) => m.stageDefault);
    if (stageRow) return stageRow.id;
  }
  // 本地版：设置页选的默认模型优先（得还在可选清单里且没藏；否则当没设）
  if (platform.isLocal) {
    const want = loadPrefs().defaultModel;
    const row = want ? allowed.find((m) => m.id === want && !m.hidden) : null;
    if (row) return row.id;
  }
  const visible = allowed.filter((m) => !m.hidden);
  return (visible.find((m) => m.default) || visible[0] || allowed[0])?.id || null;
}

/**
 * 会话中途从 openai-chat 行（Ox / DeepSeek）切到别的通路要拦（08-21 fable 评审 P3）：转换层合成的
 * thinking 块没有 signature，CLI 会把它们原样回传给说 Anthropic 协议的那一头 → 400 invalid signature。
 * 返回拒绝理由或 null。
 *
 * ⚠️ 拦的是**协议方向**不是"要不要 Claude"：08-25 接了 MiniMax（Anthropic 原生透传）之后，
 * 从 Ox 切到 MiniMax 同样是这条路，所以话里不许再写死"换到 Claude"。
 */
export function crossLaneSwitchReason(fromModel, toModel) {
  if (!fromModel || !toModel || fromModel === toModel) return null;
  const from = resolveWireModel(fromModel);
  const to = resolveWireModel(toModel);
  if (from?.protocol === 'openai-chat' && to?.protocol !== 'openai-chat') {
    const fromLabel = BY_ID.get(from.appModel)?.select?.label || from.appModel;
    return `这个会话是在 ${fromLabel} 上开的，它的思考记录换到别的模型会被拒收。想换模型请新开一个会话`;
  }
  return null;
}

/**
 * **运行中**热切模型（POST /runs/:runId/model）额外要拦的一条：订阅 ↔ API 跨通路。
 *
 * 决定一条会话走订阅还是走 API 的是**起 query 那一刻注入的 env**（BASE_URL / API_KEY，
 * 见 session-loop 的 route 分支），而 env 是 per-query 的，`setModel` 改不动它。所以跑到
 * 一半跨通路切的真实后果是：
 *   - 订阅会话切到 API 行 → binary 手里没有 ingress 地址，会拿着 ~/.claude 的 OAuth 把
 *     **alias 名**（那都是真实存在的 Claude 模型）打到 anthropic.com —— 界面写着"免费"，
 *     烧的是订阅额度。⛔ 这是要花真钱的那种错。
 *   - API 会话切回订阅行 → 那个名字进了 ingress 反查不到，兜底到本会话的 fast 行，
 *     等于"切了没生效"。
 * 两边都不是用户想要的，所以运行中一律拒绝，让人等这轮跑完（PUT /sessions/:sid/model
 * 那条等空闲重启 query，换的是新 env，不受这条限制）。
 *
 * 与 crossLaneSwitchReason 是两条**正交**的闸：那条管协议（openai-chat 的思考块没
 * signature），这条管通路（env 定死在起 query 那一刻）。
 */
export function hotSwitchLaneReason(fromModel, toModel) {
  if (!fromModel || !toModel || fromModel === toModel) return null;
  const from = resolveModelRoute(fromModel).mode;
  const to = resolveModelRoute(toModel).mode;
  if (from === to) return null;
  return to === 'api'
    ? '这一轮是用订阅模型开的，跑到一半换不成 API 模型 —— 网关地址和钥匙在起这一轮时就定死了，硬切会拿订阅额度去跑。等这轮跑完再换，或者新开一个会话'
    : '这一轮是用 API 模型开的，跑到一半换不回订阅模型 —— 同样是网关地址起这一轮时就定死了。等这轮跑完再换，或者新开一个会话';
}

/**
 * **换模型该不该拒**（null = 放行）。三条写模型的路共用这一个判断：turn.js 的 body.model、
 * sessions.js 的 PUT /model、turn-model-switch.js 的运行中热切。
 *
 * 收成一份是因为 08-21 装的那条协议闸在两处都没真工作过（08-25 发现）：sessions.js 那份把闸写在
 * applySessionModel **之后**、又拿 apply 之后的模型当 from，等于自己跟自己比，恒返 null；turn.js 那份
 * 带着 `override &&`，跑在全局默认上的会话整个逃过检查。同一个判断散成三份手写代码就是这个下场 ——
 * 这个仓库为「同一件事有多个实例」付过最贵的学费。
 *
 * @param {object} p
 * @param {string} p.from        **改之前**的有效模型（⚠️ 不是刚写进去的那个 —— 那正是旧 bug）
 * @param {string} p.to          要换成的模型（清覆盖时传全局默认那一行，别传 null）
 * @param {boolean} [p.hasHistory] 这个会话跑过没有。没跑过就没有历史，协议闸不该拦（拦了只是让人换不了模型）
 * @param {boolean} [p.running]  当前有没有正在跑的 query。跑着的话 env 已经定死，额外过通路闸
 * @returns {string|null} 给用户看的拒绝理由
 */
export function modelSwitchRejection({ from, to, hasHistory = true, running = false }) {
  if (!from || !to || from === to) return null;
  if (hasHistory) {
    const why = crossLaneSwitchReason(from, to);
    if (why) return why;
  }
  return running ? hotSwitchLaneReason(from, to) : null;
}

/** 免费行（API 行且四价全 0）：金额配额对它无意义，turn.js 改走按轮次的免费闸 */
export function modelIsFree(appModel) {
  const p = BY_ID.get(appModel)?.api?.prices;
  return !!p && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number(p[k]) === 0);
}

/**
 * 这个模型是不是跑在无审查权重上（表里的 `uncensored` 位）。
 *
 * 唯一消费方是 prelude 渲染：为 true 的行不注入「底线」那一节（见
 * agent-shared.renderPrelude）。查表，未知名字一律 false —— 拼错一个字
 * 只该退回**更严**的那一档，绝不能因为查不到就当成无审查。
 */
export function isUncensoredModel(appModel) {
  if (!appModel) return false;
  return BY_ID.get(appModel)?.uncensored === true;
}

/** 决定 sdkOptions.model 喂什么。API 行给 alias；订阅/未知原样返回（让 SDK 自己 fallback） */
export function resolveSdkSpoofModel(appModel) {
  if (!appModel) return appModel;
  const row = BY_ID.get(appModel);
  return row?.api ? row.api.sdkAlias : appModel;
}

/** 真实 context window。查表；未命中按 pattern fallback；都不匹配返 null */
export function resolveModelContextWindow(appModel) {
  if (!appModel) return null;
  const row = BY_ID.get(appModel);
  if (row) return row.window;
  if (/^kimi[-_]/i.test(appModel)) return 256_000;
  if (/\[1m\]$/i.test(appModel))   return 1_000_000;
  return null;
}

/**
 * 按 model 选 thinking config（喂 sdkOptions.thinking）。
 *
 * API 行统一走 enabled+budget（older-model 路径）——真正的出口形态由
 * model-ingress 按行内 thinking 字段决定（'strip' 会把字段整个删掉），
 * 这里给 SDK 的值只影响 SDK 内部行为，不到线上。
 *
 * 订阅行沿用原 regex 逻辑：
 *   - adaptive 一族：Opus 4.6+ / Sonnet 5+ / Fable / Mythos。
 *     ⚠️ Sonnet 5 起 budgetTokens 已被 API 移除（enabled+budget 会 400）。
 *   - display 必须显式 'summarized'：默认 'omitted' 时 thinking 块是空文本，
 *     前端思考期完全静默（2026-07-23 "失联"问题主因）。
 */
export function pickThinkingConfig(model) {
  const row = model ? BY_ID.get(model) : null;
  if (row?.api) return { type: 'enabled', budgetTokens: 8192 };
  if (model && /^claude-(?:opus-(?:4-[6789]|[5-9])|sonnet-[5-9]|fable|mythos)/.test(model)) {
    return { type: 'adaptive', display: 'summarized' };
  }
  return { type: 'enabled', budgetTokens: 8192 };
}

// ── 新导出：路由 ──

/**
 * 会话模型 → 通路描述。session-loop 据此决定 env 注入。
 *
 * `window` 要喂给 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：2026-08-19 盒上实测，
 * SDK 的压缩窗口 = **min(该 env, 别名的 rawMaxTokens)**（getContextUsage 的
 * autocompactSource 会从 model-default/auto 变成 env）。两个都得对：
 *   - 只靠别名：200k 名白扔容量，1M 名会一路涨到远超上游 n_ctx 然后炸
 *   - 只靠 env：会被别名的 rawMaxTokens 钳住（200k 别名 + env 262144 = 200000）
 * 所以 sdkAlias 一律选 1M 档打底，真实值由这个 env 钉死。
 *
 * @returns {{ mode: 'subscription' } | {
 *   mode: 'api', appModel: string, sdkAlias: string, fastModel: string,
 *   window: number, upstreamId: string, upstream: object,
 * }}
 */
export function resolveModelRoute(appModel) {
  const row = appModel ? BY_ID.get(appModel) : null;
  if (!row?.api) return { mode: 'subscription' };
  return {
    mode: 'api',
    appModel: row.id,
    sdkAlias: row.api.sdkAlias,
    fastModel: row.api.fastModel,
    window: row.window,
    upstreamId: row.api.upstream,
    upstream: UPSTREAMS[row.api.upstream],
  };
}

/**
 * 入口反查：请求 body.model（可能是 appModel、sdkAlias 或剥了 [1m] 的 alias）
 * → 该发往哪里、怎么修。查不到返回 null（入口 fail-loud 502，不静默转发）。
 */
export function resolveWireModel(bodyModel) {
  const row = typeof bodyModel === 'string' ? WIRE_LOOKUP.get(bodyModel) : null;
  if (!row) return null;
  return {
    appModel: row.id,
    wireModel: row.api.wireModel,
    upstreamId: row.api.upstream,
    upstream: UPSTREAMS[row.api.upstream],
    thinking: row.api.thinking || 'strip',
    liftImages: !!row.api.liftImages,
    protocol: UPSTREAMS[row.api.upstream]?.protocol || 'anthropic',
    reasoningEffort: row.api.reasoningEffort || null,
    // helper 请求（标题生成 / auto 分类器 / 摘要 —— 凡 body.model 不是会话主行的）用的档位：
    // 行内可写 helperReasoningEffort 显式指定，没写就 'low'（Ox 实测 low=0 reasoning token）。
    // 主 agent 想多少是主行的事，helper 一句话的活不该跟着 high/max 想几分钟
    helperReasoningEffort: row.api.helperReasoningEffort || (row.api.reasoningEffort ? 'low' : null),
    maxOutput: row.api.maxOutput || null,
    // 「只想了没说」的就地重发额度（lib/ingress/forward-openai-chat.js）。**按行配**而不是全局：
    // 这是某个模型的体质问题不是协议的 —— 08-21 深夜实测当天 4 次全在 Ox 两个主行上（它吐第一个字前
    // 要想很久，深想档一发约 45 秒，Zen 掐流的窗口就长），所以那两行放宽到 6 次 / 360 秒，别的行走
    // 全局默认（env / 2 次 / 120 秒）；helper 不放宽（一句话的活，重发只是白占上游）。
    // ⭐天花板由 CLI 定：流式请求走 SDK 客户端 timeout 600 秒，而预算是**开新一发之前**查的 →
    // 预算 + 单发最长挂起（实测 185 秒）必须 < 600 秒（配了断言，见 upstream-truncation.test.js）。
    emptyRetries: Number.isFinite(row.api.emptyRetries) ? row.api.emptyRetries : null,
    retryBudgetMs: Number.isFinite(row.api.retryBudgetMs) ? row.api.retryBudgetMs : null,
    // 上游要的额外顶层 body 字段（今天只有 merge 的 `vendor` 点名，见表里那行）。
    // ⚠️ **这一份配置有两个读者**，因为两条腿各自序列化 body：Anthropic 透传在 transformForUpstream
    // 里 Object.assign 到 parsed，openai-chat 在 toOpenAIChatRequest 里合进 out。加第三条腿要记得
    // 带上它 —— 漏了不会报错，只是点名静默失效（model-ingress.test.js 两条腿各有一条断言）
    bodyExtra: row.api.bodyExtra || null,
  };
}

/**
 * 按行内 prices 给一笔 token 用量定价（美元）。行没填 prices → null（调用方自己决定
 * 兜底：reprice 沿用 SDK 虚价，relay 记 0 并告警 —— 假数比没有更坏，这里不编）。
 *
 * 这是**全仓唯一**的价目算式：repriceUsageDeltas（会话结账）和 relay 账本都走它。
 * 两处各抄一份的话，改一处漏一处，两本账就对不上了。
 *
 * @param {string} appModel
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheCreate?: number }} tokens
 * @returns {number|null}
 */
export function priceTokens(appModel, tokens = {}) {
  const p = BY_ID.get(appModel)?.api?.prices;
  if (!p) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return (
    n(tokens.input) * p.input
    + n(tokens.output) * p.output
    + n(tokens.cacheRead) * (p.cacheRead || 0)
    + n(tokens.cacheCreate) * (p.cacheWrite || 0)
  ) / 1e6;
}

/**
 * usage 差分 reprice：key 从 SDK alias 还原成 appModel，按行内 prices 重算
 * costUsd。多个 key 归并到同一 appModel 时逐字段相加。context.js 的
 * absorbResult 在差分之后调这一步。
 *
 * ⚠️ 必须带 sessionAppModel 且只对 API 会话生效：SDK 报的 usage key 是 alias，
 * 而 alias 同时也是真实存在的订阅 Claude 名（sonnet-4-6[1m] 既是 Gemini 的
 * spoof 也是一个真模型）——不看会话通路就 remap，订阅会话跑 sonnet-4-6 会被
 * 错记成 Gemini 的账。订阅会话原样返回，一个字段都不动。
 *
 * @param {Record<string, {inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd}>} deltas
 * @param {string} sessionAppModel  本会话的 appModel（AgentContext.appModel）
 * @returns 同构对象（API 会话新建；订阅会话原样返回入参）
 */
export function repriceUsageDeltas(deltas, sessionAppModel) {
  if (!deltas || typeof deltas !== 'object') return deltas;
  const sessionRow = sessionAppModel ? BY_ID.get(sessionAppModel) : null;
  if (!sessionRow?.api) return deltas;
  // API 会话的所有请求必经 ingress：表内 key 按表归；不在表里的 key（SDK 内部
  // helper 用 config 默认 Claude 名发的请求）必然被 ingress 的会话 fast 兜底
  // 承接 —— 归到 fastModel 头上是精确归因，不是猜测。
  const fastRow = BY_ID.get(sessionRow.api.fastModel);
  // ⭐ 会话优先，跟入口路由同一个次序（session-routes.resolveSessionWire）：SDK 报的 usage key 是
  // **本会话的 sdkAlias**，而共用别名（SHARED_SDK_ALIAS）根本不在 WIRE_LOOKUP 里 —— 只按全表反查的话
  // 主行那笔账会整个落到 fastModel 头上（计量按模型分组就全错了，钱对了数不对）。
  const sessionNames = new Set(wireNamesOf(sessionRow.id));
  const out = {};
  for (const [key, d] of Object.entries(deltas)) {
    const row = (sessionNames.has(key) ? sessionRow : WIRE_LOOKUP.get(key)) || fastRow;
    const appKey = row ? row.id : key;
    const priced = row ? priceTokens(row.id, { input: d.inputTokens, output: d.outputTokens, cacheRead: d.cacheReadTokens, cacheCreate: d.cacheCreateTokens }) : null;
    const repriced = priced != null ? { ...d, costUsd: priced } : { ...d };
    const prev = out[appKey];
    out[appKey] = prev ? {
      inputTokens: prev.inputTokens + repriced.inputTokens,
      outputTokens: prev.outputTokens + repriced.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + repriced.cacheReadTokens,
      cacheCreateTokens: prev.cacheCreateTokens + repriced.cacheCreateTokens,
      costUsd: prev.costUsd + repriced.costUsd,
    } : repriced;
  }
  return out;
}
