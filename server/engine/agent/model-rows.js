/**
 * server/engine/agent/model-rows.js — 表行从哪几个来源派生、怎么自检（2026-09-11 从 model-context.js 拆出，那边顶在 600 行棘轮上）。
 *
 * 行有三个来源，派生成同一种形状，由 model-context.js 的 buildIndex 合成一张表：
 *   内置表        model-table.js
 *   外部插槽      runtime/slot-config.js（本地版的 config.json / 站点管理台那份）→ toExternalRow
 *   站主 relay 目录  **本地分发版**里本机没钥匙的行（09-11）→ mergeRelayRows
 *
 * ## 为什么 relay 目录要能生成行（09-11）
 *
 * 以前桌面版拿**安装包自带的那张表**逐行问 relay「这个 id 让不让用」，目录只回 id / 锁不锁。于是站点
 * 新加的行桌面永远列不出、改了 id 的行对不上被藏掉、改了名字的行桌面还显示旧名 —— 每动一次模型表就得
 * 跟发一版桌面（09-10 一天两次）。本机没钥匙的行，推理、转换、记账本来全在站点上跑，桌面只需要知道
 * 怎么展示它、怎么起会话，这些站点在目录里一并下发（hosted/relay/catalog.js），桌面照着建行。
 *
 * 规矩：
 *   - **本机优先**：本机有钥匙的内置行、用户自己的插槽、订阅 Claude 行，一律不被目录顶替。
 *   - **sdkAlias 必须跟站点那行一致**：站点的会话路由只认本行的 id / sdkAlias 和 helper 行的名字，
 *     别的一律当 helper 改道（session-routes.resolveSessionWire）。桌面要是换个别名发，主回合会被静默
 *     改道成 helper 模型 —— 所以本地表里没有这个别名的行直接丢掉并报出来，**不退回共用别名**。
 *   - 目录是老站点（没有 mode 字段）时一行都不生成，行为跟以前完全一样。
 */

import { BRANDS, SHARED_SDK_ALIAS } from './model-table.js';
import { validateUnavailableSpec } from '../../lib/model-availability.js';

/** 配置条目 → 表行（字段名一一对应，见 local-config.js 文件头；sdkAlias 不许手填 = 永远走下面的共用别名默认） */
export function toExternalRow(m) {
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
export function withDefaultAlias(row) {
  if (!row.api || row.api.sdkAlias) return row;
  return Object.freeze({ ...row, api: Object.freeze({ ...row.api, sdkAlias: SHARED_SDK_ALIAS }) });
}

/**
 * 一行的自检。分级仍旧：**内置行的错当场炸**（代码错），外部行 / relay 行的错丢行 + 记进 errors。
 * ⚠️ 上游表与 id 索引当参数传：重建时这两样是新的，读闭包里那份会静默拿到旧表。
 */
export function checkRow(row, upstreams, byId) {
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

// ── relay 目录 → 表行（09-11）──

/**
 * relay 行挂的上游：按协议各一条**合成**上游，只有协议没有地址和钥匙。
 *   - 没钥匙 → modelSourceFor 判不成 'local'，只会是 'relay'（目录里有）或 null
 *   - 协议要对：换模型的协议闸（model-switch-rules.crossLaneSwitchReason）按它判思考块能不能回传
 *   - 名字带冒号：插槽的 upstream id 不许有冒号（local-config.js ID_RE），撞不上用户的
 * ⚠️ 本机 ingress 永远不该往这里转：relay 会话的 base URL 直接指站点。真走到了（本机有钥匙的会话把 helper
 *    指到了一条 relay 行）会因为没有地址 502 —— 那条 helper 本来就没钥匙，以前是 401，失败的形状一样。
 */
const RELAY_UPSTREAM_PREFIX = 'relay:';
const PROTOCOLS = ['anthropic', 'openai-chat'];
const relayUpstreamOf = (protocol) => `${RELAY_UPSTREAM_PREFIX}${PROTOCOLS.includes(protocol) ? protocol : 'anthropic'}`;
const RELAY_UPSTREAMS = Object.freeze(Object.fromEntries(PROTOCOLS.map((p) => [relayUpstreamOf(p), Object.freeze({
  label: 'NoDesign 服务（站点 relay）', protocol: p, authStyle: 'relay', key: null, keyEnv: null, countTokens: false, relay: true,
})])));

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isPrices = (p) => p && typeof p === 'object' && ['input', 'output'].every((k) => Number.isFinite(p[k]));

/**
 * 把 relay 目录合进本地表。纯函数：不读模块状态，钥匙判断由调用方传进来。
 *
 * @param {object[]} models   已合好的 内置 + 插槽 行（withDefaultAlias 之后）
 * @param {object}   upstreams 已合好的上游表
 * @param {object}   catalog  relay-client 的目录快照 { ok, models: [...], renames }
 * @param {{ keyPresent: (row) => boolean }} opts  本机有没有这一行的钥匙（跟 modelSourceFor 同一个判据）
 * @returns {{ models: object[], upstreams: object, renames: Record<string,string>, errors: {where:string,message:string}[] }}
 */
export function mergeRelayRows(models, upstreams, catalog, { keyPresent }) {
  const none = { models, upstreams, renames: {}, errors: [] };
  if (!catalog?.ok || !Array.isArray(catalog.models)) return none;
  const entries = catalog.models.filter((e) => e && isStr(e.id) && e.mode === 'api');
  const renames = Object.fromEntries(Object.entries(catalog.renames && typeof catalog.renames === 'object' ? catalog.renames : {})
    .filter(([a, b]) => isStr(a) && isStr(b) && a !== b));
  if (!entries.length) return { ...none, renames };

  const errors = [];
  const local = new Map(models.map((r) => [r.id, r]));
  // 本机说了算的行：订阅 Claude 行、用户插槽、本机有钥匙的内置 API 行
  const localWins = (r) => !!r && (!r.api || r.external || keyPresent(r));
  const candidates = entries.filter((e) => !localWins(local.get(e.id)));
  const relayIds = new Set(candidates.map((e) => e.id));
  const built = new Map();
  for (const e of candidates) {
    const where = `relay (${e.id})`;
    const alias = local.get(e.sdkAlias);
    if (!alias || alias.api) { errors.push({ where, message: `站点这行的 sdkAlias ${e.sdkAlias} 本地表里没有（换别名发会被站点改道成 helper），这一行不列` }); continue; }
    if (!Number.isFinite(e.window) || e.window <= 0) { errors.push({ where, message: `window 不对：${e.window}` }); continue; }
    // helper：站点给的那行得在合好的表里（目录里一起下发的，或本地本来就有的 API 行）；都没有就指自己，
    // 站点那头认得出这是主行的名字 —— 标题 / 压缩会按主行的档位跑，贵一点但不会断
    const fastOk = isStr(e.fastModel) && (relayIds.has(e.fastModel) || local.get(e.fastModel)?.api);
    const select = e.helper || !isStr(e.label) ? null : Object.freeze({
      label: e.label, desc: isStr(e.desc) ? e.desc : '',
      ...(e.only ? { only: e.only } : {}), ...(e.stageDefault ? { stageDefault: true } : {}), ...(e.default ? { default: true } : {}),
    });
    built.set(e.id, Object.freeze({
      id: e.id, window: e.window, brand: BRANDS.includes(e.brand) ? e.brand : 'custom', relay: true,
      ...(e.unavailable && typeof e.unavailable === 'object' ? { unavailable: e.unavailable } : {}),
      ...(select ? { select } : {}),
      api: Object.freeze({
        upstream: relayUpstreamOf(e.protocol), wireModel: e.id, sdkAlias: e.sdkAlias,
        fastModel: fastOk ? e.fastModel : e.id, thinking: 'strip',
        ...(isPrices(e.prices) ? { prices: Object.freeze({ ...e.prices }) } : {}),
      }),
    }));
  }
  if (!built.size) return { ...none, renames, errors };

  // 站点改过名的行：本地表里那条旧 id 的内置行（没钥匙、目录里也没有）退出表，存量里的旧 id 才会顺着
  // 改名表落到新行上（canonicalModelId 是「活着的行优先」，旧行留着就永远翻不过去）
  const finalIds = new Set([...local.keys(), ...built.keys()]);
  const retired = (r) => !localWins(r) && !built.has(r.id) && renames[r.id] && finalIds.has(renames[r.id]);
  const out = [];
  for (const r of models) {
    if (built.has(r.id)) { out.push(built.get(r.id)); built.delete(r.id); continue; }   // 原位顶替，选择器顺序不乱
    if (!retired(r)) out.push(r);
  }
  out.push(...built.values());   // 本地表里没有的新行按目录顺序排在后面
  return { models: Object.freeze(out), upstreams: Object.freeze({ ...upstreams, ...RELAY_UPSTREAMS }), renames, errors };
}
