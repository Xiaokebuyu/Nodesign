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
import { RENAMED_MODELS, followRename } from './model-renames.js';
import { loadSlotConfig } from '../../runtime/slot-config.js';   // 插槽从哪来（本地文件 / 站点库）只在那儿知道
import { relayModelEntry } from '../../runtime/relay-client.js';
import { availabilityOf, validateUnavailableSpec } from '../../lib/model-availability.js';
import { loadPrefs } from '../../runtime/local-prefs.js';

export { BRANDS, SHARED_SDK_ALIAS };

// ── 内置表 + 插槽合并，派生索引（08-22 建；09-10 改成**可重建**）──
// 可重建是为了站点模型能在管理台上加/改而不重启（重启要等所有在飞的回合，站主宁可不加）。
// ⭐ 规矩只有一条：**整套建好了才换上去**（build 炸了就抛，旧索引原样留着 —— 半套索引坏得没声音）。
// ⚠️ 在飞请求不受影响：它们手里攥的是行对象本身，行是 frozen 的。
// ⚠️ 导出的四个是 `let`（ESM 活绑定）。⛔ 别在别处把它们存进模块级 const —— 那份拷贝重建后就是旧表，且不报错。

/** 配置条目 → 表行（字段名一一对应，见 local-config.js 文件头；sdkAlias 不许手填 = 永远走下面的共用别名默认） */
function toExternalRow(m) {
  // ⚠️ 剩下的全进 api 段，所以**行级字段必须在这儿点名**（09-10 加 unavailable 时踩到：不点名就落进 api.unavailable，
  // 钟点闸读 row.unavailable 读不到，静默失效）
  const { id, label, desc, brand, window, uncensored, unavailable, upstream, wireModel, fastModel, ...api } = m;
  return Object.freeze({
    id, window, brand, external: true, ...(uncensored ? { uncensored: true } : {}), ...(unavailable ? { unavailable } : {}),
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

/**
 * 一行的自检。分级仍旧：**内置行的错当场炸**（代码错），外部行的错丢行 + 记进 errors。
 * ⚠️ 上游表与 id 索引当参数传：重建时这两样是新的，读闭包里那份会静默拿到旧表。
 */
function checkRow(row, upstreams, byId) {
  if (!BRANDS.includes(row.brand)) throw new Error(`[model-context] ${row.id} 的 brand 必须是 BRANDS 之一：${row.brand}`);
  // 钟点闸（09-10）：写坏了要在这儿炸，不能等到某天窗口生效才发现"这行怎么一直关门"
  const badHours = validateUnavailableSpec(row.unavailable);
  if (badHours.length) throw new Error(`[model-context] ${row.id} 的 unavailable 写坏了：${badHours.join('；')}`);
  if (!row.api) return;
  if (!upstreams[row.api.upstream]) throw new Error(`[model-context] ${row.id} 指向不存在的 upstream: ${row.api.upstream}`);
  // alias 必须是本表里的订阅 Claude 名 —— SDK 才认识、窗口才查得到
  if (!row.api.sdkAlias || !byId.has(row.api.sdkAlias) || byId.get(row.api.sdkAlias).api) throw new Error(`[model-context] ${row.id} 的 sdkAlias 必须是表内订阅模型名：${row.api.sdkAlias}`);
  const fast = byId.get(row.api.fastModel);
  if (!fast || !fast.api) throw new Error(`[model-context] ${row.id} 的 fastModel 必须是表内 API 模型：${row.api.fastModel}`);
  // standby（09-08）：上游连续失败 / 402 时会话级换到的备用行，必须是表内另一条 API 行
  if (row.standby !== undefined) {
    const sb = byId.get(row.standby);
    if (!sb || !sb.api || sb.id === row.id) throw new Error(`[model-context] ${row.id} 的 standby 必须是表内另一条 API 模型：${row.standby}`);
  }
}

/**
 * 建一整套索引。**不碰任何模块状态** —— 建坏了往外抛，调用方决定是炸进程（启动时）还是留着旧的（重建时）。
 * @returns {{upstreams: object, models: object[], byId: Map, wireLookup: Map, errors: object[], shadowed: string[], path: string|null}}
 */
function buildIndex() {
  const external = loadSlotConfig();
  const errors = [...external.errors];
  const upstreams = Object.freeze({ ...UPSTREAMS_BUILTIN, ...external.upstreams });
  // 同名顶替（09-09）：外部插槽的 id 撞上内置 **API** 行 → 内置那行退出表，只剩用户的（本机钥匙优先，
  // 跟 modelSourceFor 一个口径）。订阅 Claude 行在 local-config 校验就拒了，到不了这里。
  const externalIds = new Set(external.models.map((m) => m.id));
  const shadowed = Object.freeze(MODELS_BUILTIN.filter((r) => externalIds.has(r.id) && r.api).map((r) => r.id));
  const models = Object.freeze(
    [...MODELS_BUILTIN.filter((r) => !externalIds.has(r.id) || !r.api), ...external.models.map(toExternalRow)].map(withDefaultAlias),
  );

  const byId = new Map();
  for (const row of models) {
    if (byId.has(row.id)) throw new Error(`[model-context] 模型 id 重复：${row.id}`);
    byId.set(row.id, row);
  }
  // 共用别名的本体必须始终是表内一条订阅 Claude 行：它是「不写 sdkAlias」的默认值，哪怕此刻没行在用，
  // 删掉/改坏那条订阅行也要当场炸，不能等到下一条新行加进来才发现 SDK 不认识、窗口查不到。
  {
    const shared = byId.get(SHARED_SDK_ALIAS);
    if (!shared || shared.api) throw new Error(`[model-context] SHARED_SDK_ALIAS（${SHARED_SDK_ALIAS}）必须是表内订阅模型行 —— 它是 sdkAlias 不写时的默认值`);
  }
  const wireLookup = new Map();
  for (const row of models) {
    try { checkRow(row, upstreams, byId); } catch (err) {
      if (!row.external) throw err;
      byId.delete(row.id); errors.push({ where: `models (${row.id})`, message: err.message }); continue;
    }
    if (!row.api) continue;
    // 共用别名的行（sdkAlias 没写、派生时补的默认值）只按 id 进反查表：那个别名同时属于好几行，
    // 全表反查分不出谁是谁，只有会话知道（session-routes.resolveSessionWire 主行优先）。
    const sharesAlias = row.api.sdkAlias === SHARED_SDK_ALIAS;
    const keys = sharesAlias ? [row.id] : [row.id, row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, '')];
    for (const k of keys) {
      const prev = wireLookup.get(k);
      if (prev && prev !== row) throw new Error(`[model-context] wire 名撞车：'${k}' 同时属于 ${prev.id} 和 ${row.id}（独占 sdkAlias 不能共用；不想独占就别写 sdkAlias，让它走共用别名）`);
      wireLookup.set(k, row);
    }
  }
  // 改过名的行（09-10，表在 model-renames.js）：只对账**目标得是活着的行**（指向不存在的行 = 表写错了，
  // 当场炸，别等用户拿旧 id 撞上）。旧名还活着不算错：那多半是同名插槽，活着的那行说了算。
  for (const [oldId, newId] of Object.entries(RENAMED_MODELS)) {
    if (!byId.has(newId)) throw new Error(`[model-context] RENAMED_MODELS 里 ${oldId} 指向不存在的行：${newId}`);
  }
  return { upstreams, models, byId, wireLookup, errors, shadowed, path: external.path || null };
}

/** picker 清单的派生：unavailable 跟着带过来，选择器那行要现算"此刻开不开门、几点回来" */
const deriveSelectable = (models) => Object.freeze(
  models.filter((m) => m.select).map((m) => Object.freeze({ id: m.id, brand: m.brand, ...m.select, ...(m.unavailable ? { unavailable: m.unavailable } : {}) })),
);

function logIndex(idx) {
  if (idx.shadowed.length) console.log(`[model-context] 外部插槽顶替了同名内置行（用本机钥匙）：${idx.shadowed.join(', ')}`);
  if (idx.errors.length) {
    console.warn(`[model-context] 插槽配置有 ${idx.errors.length} 处问题（对应条目已跳过）${idx.path ? `：${idx.path}` : ''}`);
    for (const e of idx.errors) console.warn(`  - ${e.where}: ${e.message}`);
  }
}

// 启动时建一次。内置表的错在这儿炸进程，口径跟 08-22 起一样（代码错就该拦在门口）
let INDEX = buildIndex();
logIndex(INDEX);

let BY_ID = INDEX.byId;
/** wire 名（appModel / sdkAlias / alias 剥 [1m] 后缀形态）→ 行。入口反查用 */
let WIRE_LOOKUP = INDEX.wireLookup;
let SHADOWED_BUILTIN_IDS = INDEX.shadowed;

export let UPSTREAMS = INDEX.upstreams;
/** 外部插槽被整条丢掉的原因（启动日志一份、GET /api/local/config 一份） */
export let MODEL_CONFIG_ERRORS = INDEX.errors;
/** **全部行的原样清单**（内置 + 插槽，含 helper 行）。管理台看的是站点侧事实，跟按用户判资格的清单不是一回事。⛔ 只读 */
export let MODEL_ROWS = INDEX.models;
export let SELECTABLE_MODELS = deriveSelectable(INDEX.models);

/**
 * **重建整套索引**（09-10）。管理台改完站点模型调它，不用重启服务端。
 * 建坏了原样抛出、**旧索引一个字都不动**：调用方把错显示在页面上，站照旧跑着。
 * @returns {{models: number, errors: {where: string, message: string}[]}}
 */
export function rebuildModelIndex() {
  const next = buildIndex();          // 炸了就到此为止，下面一行都不执行
  INDEX = next;
  BY_ID = next.byId;
  WIRE_LOOKUP = next.wireLookup;
  SHADOWED_BUILTIN_IDS = next.shadowed;
  UPSTREAMS = next.upstreams;
  MODEL_CONFIG_ERRORS = next.errors;
  MODEL_ROWS = next.models;
  SELECTABLE_MODELS = deriveSelectable(next.models);
  logIndex(next);
  return { models: next.models.length, errors: next.errors };
}

/**
 * 旧 id → 现在的 id。不认识的名字原样返回（"不在表里"仍然由调用方按原来的方式处理）。
 *
 * 三条边界情况都在这儿收口：**活着的行优先**（用户的同名插槽不该被历史包袱顶掉）、
 * 多跳跟到底（a→b→c）、成环当没改过（表写坏了不该拖垮请求）。
 */
export function canonicalModelId(appModel) {
  if (typeof appModel !== 'string' || !appModel) return appModel;
  if (BY_ID.has(appModel)) return appModel;   // 活着的行优先（用户的同名插槽说了算）
  return followRename(appModel);              // 多跳与成环在 model-table.js 的 followRename 里
}

/**
 * 查表拿一行 —— 认现名，也认改名前的旧名。
 * ⭐ 本文件里凡是"拿 appModel 查行"的地方都走它（价钱 / 通路 / 牌子 / standby / 窗口…），
 *   不是各自 `BY_ID.get`：改名这件事只该在一个地方知道。构表与自检那一段除外（它们要的是**原样**）。
 */
function rowOf(appModel) {
  if (typeof appModel !== 'string' || !appModel) return undefined;
  return BY_ID.get(appModel) || BY_ID.get(canonicalModelId(appModel));
}

/** 当前进程里真正生效的外部行 id（配置页据此判「已生效 / 要重启」） */
export function externalModelIds() {
  return [...BY_ID.values()].filter((r) => r.external).map((r) => r.id);
}

/** 被同名外部插槽顶掉的内置行 id（配置页标「已顶替内置行」；只报被顶且外部行真进了表的） */
export function shadowedBuiltinModelIds() {
  return SHADOWED_BUILTIN_IDS.filter((id) => BY_ID.get(id)?.external);
}

/** 一行在入口会以哪些 body.model 名出现（id / sdkAlias / 剥 [1m] 的 alias）。session-routes 会话优先匹配用；不认识的 id → [] */
export function wireNamesOf(appModel) {
  const row = appModel ? rowOf(appModel) : null;
  if (!row) return [];
  return row.api ? [row.id, row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, '')] : [row.id];
}

// ── 旧导出（签名不变，全部改为查表）──

/**
 * picker 的**全量**清单（含带闸门的行）。⚠️ 对外接口一律用
 * `selectableModelsFor(user)`，直接用这个等于把闸门拆了。保留导出是因为它是
 * 「表里哪些行可选」的唯一真相，闸门只是在它上面过滤。
 */

/** 这一行的备用行 id（模型表 standby 字段）。没有 → null */
export function standbyModelOf(appModel) {
  return (appModel && rowOf(appModel)?.standby) || null;
}

/** 系统提示的环境块要报真实模型：label / id / 上下文窗口。不认识的 id → null（调用方 fail-loud） */
export function modelFactsFor(appModel) {
  const row = appModel ? rowOf(appModel) : null;
  return row ? { id: row.id, label: row.select?.label || row.label || row.id, window: row.window } : null;
}

/**
 * 这一行走的是哪条上游（`UPSTREAMS` 的键）。不认识的 id → null。
 *
 * 贴纸栏用它把「模型行」映到「上游健康度」。⚠️ 是**多对一**：好几行可能共用一条上游，
 * 它们的色点会一起亮一起灭 —— 这是对的，因为账本记的确实是那条上游的成败。
 * 但**别反过来把色点读成"这个厂商的健康度"**：merge 那条线上 vendors 是"第一个可用的赢"、
 * 后备静默，同一条上游这一发可能是 zai 服务的、下一发就是 particle（见 upstream-health.js 头注）。
 */
export function upstreamOf(appModel) {
  return (appModel && rowOf(appModel)?.api?.upstream) || null;
}

/** 这个 appModel 出自谁家（BRANDS 之一）。不认识的 id → null，调用方自己决定兜底，别猜。 */
export function brandOfModel(appModel) {
  return rowOf(appModel)?.brand || null;
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
  const row = rowOf(appModel);
  if (!row) return null;
  if (!platform.isLocal) return 'local';
  if (upstreamKeyPresent(row)) return 'local';
  const entry = relayModelEntry(appModel);
  return entry ? 'relay' : null;
}

export function selectableModelsFor(user, opts) {
  const scope = scopeOf(opts);
  const now = opts?.now instanceof Date ? opts.now : new Date();   // 钟点闸的"此刻"，测试要能钉住
  const approved = localGenApproved(user);   // 档位 + 逐人批准，同 paint_still / roll_film / 演出端点一把尺
  const subscribed = hasSubscriptionAccess(user);
  const out = [];
  for (const m of SELECTABLE_MODELS) {
    if (!inScope(m, scope)) continue;   // 只在演出面出现的行，画布面看不见也选不了
    const source = modelSourceFor(m.id);
    if (!source) continue;   // 本地版：本机没钥匙、relay 也没有 → 藏起来；hosted 永远 'local'
    // 本地版：用户在设置页藏起来的行带 hidden 标（选择器不列，设置页要列出来给他再打开；不影响能不能用）
    // 存下来的是"当时的 id"：行改过名的话，偏好里还写着旧名（canonicalModelId 翻一下再比）
    const hidden = platform.isLocal && loadPrefs().hiddenModels.some((id) => canonicalModelId(id) === m.id) ? { hidden: true } : {};
    // 站主的总闸 + 钟点闸（09-10）：不可用 = **看得见选不了**，理由写在行上。
    // 藏起来是错的 —— 用户会以为这行被删了，然后来问我们（入口必须同时是出口）。
    // ⛔ 这里只拦，不改会话的模型：换线是用户自己的事（站主 09-10：先别加 fallback）。
    const avail = availabilityOf(m, now);
    if (!avail.ok) {
      out.push({ ...m, locked: true, lockReason: avail.reason, unavailableKind: avail.kind, resumesAt: avail.resumesAt, ...(source === 'relay' ? { source } : {}), ...hidden });
      continue;
    }
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

/**
 * 这个模型对这个用户「看得见选不了」时返回**那一行**（带 lockReason），能用 → null。
 * ⭐ 拒绝的话从这里取，别在各自的端点里手写：锁的种类 09-10 起不止一种（Pro 档 / 站主停用 /
 *   钟点关门），手写那句"仅限 Pro 档"会当场变成假话。api/model-lock-reason.lint.test.js 盯着。
 */
export function modelLockFor(user, appModel, opts) {
  return selectableModelsFor(user, opts).find((m) => m.id === appModel && m.locked) || null;
}

/** 这个模型对这个用户是「看得见选不了」吗（在清单里且 locked）。turn 拒绝时据此回 403 而不是 400 */
export function isModelLockedFor(user, appModel, opts) {
  return !!modelLockFor(user, appModel, opts);
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
    const want = canonicalModelId(loadPrefs().defaultModel);   // 设置页存的是当时的 id，行改过名要翻
    const row = want ? allowed.find((m) => m.id === want && !m.hidden) : null;
    if (row) return row.id;
  }
  const visible = allowed.filter((m) => !m.hidden);
  return (visible.find((m) => m.default) || visible[0] || allowed[0])?.id || null;
}

// 换模型的三条闸 09-10 搬去 model-switch-rules.js（本文件顶到 600 行棘轮）：那是策略，这里是表。


/** 免费行（API 行且四价全 0）：金额配额对它无意义，turn.js 改走按轮次的免费闸 */
export function modelIsFree(appModel) {
  const p = rowOf(appModel)?.api?.prices;
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
  return rowOf(appModel)?.uncensored === true;
}

/** 决定 sdkOptions.model 喂什么。API 行给 alias；订阅/未知原样返回（让 SDK 自己 fallback） */
export function resolveSdkSpoofModel(appModel) {
  if (!appModel) return appModel;
  const row = rowOf(appModel);
  return row?.api ? row.api.sdkAlias : appModel;
}

/** 真实 context window。查表；未命中按 pattern fallback；都不匹配返 null */
export function resolveModelContextWindow(appModel) {
  if (!appModel) return null;
  const row = rowOf(appModel);
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
  const row = model ? rowOf(model) : null;
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
  const row = appModel ? rowOf(appModel) : null;
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
  // 反查表按 wire 名建（id / 独占别名）。改过名的行：拿旧 id 发过来的请求也认（09-10）——
  // 正常路径上入口收到的已经是现名（会话按 route.appModel 注册），这一步是兜住残留的注册与旧探针
  const row = typeof bodyModel === 'string' ? (WIRE_LOOKUP.get(bodyModel) || WIRE_LOOKUP.get(canonicalModelId(bodyModel))) : null;
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
    maxImages: row.api.maxImages || null,   // 一次 prompt 最多带几张图（ingress/image-cap.js 裁最早的）；不填 = 不裁
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
  const row = rowOf(appModel);
  // 订阅 Claude 行没有 api 块，表价挂在行顶层 `prices`（model-table.js 订阅段的注释说明来历）
  const p = row?.api?.prices || row?.prices;
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
  const sessionRow = sessionAppModel ? rowOf(sessionAppModel) : null;
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
