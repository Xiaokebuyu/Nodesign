/**
 * server/engine/agent/model-effort.js —— 思考等级（effort）按模型行给哪些档、默认哪档（2026-09-13）
 *
 * 一个事实一份算法：选择器清单、会话配置校验、session-loop 起会话、ingress 换算上游 reasoning_effort
 * 全从这里取。纯函数，不读模块状态。
 *
 * 两条通路：
 *   - 订阅 Claude 行：SDK 的 effort 直达 Anthropic。只给 Sonnet 5 / Opus 5（sdk.d.ts：xhigh 要 Sonnet 5 / Opus 4.7+，
 *     max 要 Opus 4.6+ / Sonnet 4.6+）。默认 medium，跟 09-13 之前 session-loop 写死的值一致。
 *   - API 行：CLI 照样把 effort 写进请求体 `output_config.effort`（09-13 探针：spoof 名下也带，
 *     applyFlagSettings 中途改了下一发就跟着变），ingress 按这一行上游收的档就近换算成 reasoning_effort。
 *     **只有表里写了 api.efforts 的行才可调**：各家收哪几档不一样（zen 系没有 medium，Merge 网关 GLM 四档都收，
 *     08-27 实测），没实测过的行一律不给选，按行内 reasoningEffort 固定。
 */

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const RANK = Object.freeze(Object.fromEntries(EFFORT_LEVELS.map((l, i) => [l, i])));

/** 订阅行里可调的：Sonnet 5 / Opus 5（含 1M 名） */
const SUBSCRIPTION_EFFORT_ROW = /^claude-(opus-5|sonnet-5)(\[1m\])?$/;
/** 订阅行默认档 */
export const SUBSCRIPTION_DEFAULT_EFFORT = 'medium';
/** 不可调的行起会话时传给 SDK 的值（跟 09-13 之前一致；API 行不可调时 ingress 不认请求里的 effort） */
export const FIXED_ROW_SDK_EFFORT = 'medium';

export const isEffortLevel = (v) => typeof v === 'string' && Object.hasOwn(RANK, v);

/**
 * 这一行能选哪几档（按从低到高排好）。不可调返回 null。
 * @param {object|null} row  模型表行（MODEL_ROWS 里那种；relay 建出来的行 api.efforts 来自站点目录）
 */
export function effortChoicesFor(row) {
  if (!row?.id) return null;
  const list = row.api ? row.api.efforts : (SUBSCRIPTION_EFFORT_ROW.test(row.id) ? EFFORT_LEVELS : null);
  if (!Array.isArray(list)) return null;
  const clean = EFFORT_LEVELS.filter((l) => list.includes(l));
  return clean.length > 1 ? clean : null;
}

/**
 * 就近换算：这一档有就用它；没有就取不高于它的最高一档；都比它高就取最低一档。
 * 不是合法档位或没得选 → null（调用方退回行默认）。
 */
export function clampEffort(level, choices) {
  if (!Array.isArray(choices) || !choices.length || !isEffortLevel(level)) return null;
  if (choices.includes(level)) return level;
  const below = choices.filter((c) => RANK[c] < RANK[level]);
  return below.length ? below[below.length - 1] : choices[0];
}

/** 这一行的默认档（可调的行才有）：API 行 = 行内 reasoningEffort 就近换算；订阅行 = medium */
export function defaultEffortFor(row) {
  const choices = effortChoicesFor(row);
  if (!choices) return null;
  return clampEffort(row.api ? row.api.reasoningEffort : SUBSCRIPTION_DEFAULT_EFFORT, choices) || choices[0];
}

/**
 * 起会话时传给 SDK 的 effort：会话选过且这一行可调 → 换算后的会话档；可调但没选过 → 行默认；不可调 → 固定值。
 * @param {object|null} row
 * @param {string|null|undefined} sessionEffort  session-config.json 里存的
 */
export function sdkEffortFor(row, sessionEffort) {
  const choices = effortChoicesFor(row);
  if (!choices) return FIXED_ROW_SDK_EFFORT;
  return clampEffort(sessionEffort, choices) || defaultEffortFor(row);
}

/**
 * ingress：openai-chat 主行请求该发哪档 reasoning_effort。
 * 行可调且请求体带了合法 effort → 换算后的档；否则行内 reasoningEffort（跟以前一样）。
 * @param {{ reasoningEffort?: string|null, efforts?: string[]|null }} wire  resolveWireModel 的结果
 * @param {object} body  入口收到的 Anthropic Messages 请求体
 */
export function wireReasoningEffort(wire, body) {
  const fromBody = clampEffort(body?.output_config?.effort, wire?.efforts);
  return fromBody || wire?.reasoningEffort || null;
}
