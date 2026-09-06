/**
 * lib/ingress/upstream-billing.js —— 上游**自报**的费用/用量，按会话 × appModel 累加，供回合结账取走。
 *
 * 背景（08-21 晚）：Zen 的 /zen/go 入口每个响应带 `cost`（美元字符串；流式在 [DONE] 之后补一条
 * {"choices":[],"cost":"…"}）和 usage.prompt_tokens_details.cached_tokens。我们原来的仪表是
 * "SDK 按 alias 的 Claude 价目算 → reprice 按表价重算"，CLI 失败时还按字符估算 —— 假表。
 * 上游报了真数就用真数：ingress 每次往返 note 一笔，session-loop 在 absorbResult 之后 take 走本轮累计，
 * 覆盖 counters.modelUsage[appModel].costUsd（context.applyUpstreamBilling）。
 *
 * 只覆盖 cost，token 数仍以 SDK 的 modelUsage 差分为准（两边口径不同：OpenAI 的 prompt_tokens 含缓存命中）；
 * SDK 没给该模型条目时（CLI 失败 / helper），用上游 token 数补一条，别让这笔钱无家可归。
 * 上游没报 cost（cost 为 null）就不动任何东西 —— 假数据比没有更坏。
 */

/**
 * 上游把「这一发花了多少钱」放在哪儿，各家不一样：Zen（/zen/go）放在**顶层** `cost`
 * （流式在 [DONE] 之后补一条 {"choices":[],"cost":"0.00123"}），Merge 网关放在 **usage.cost** 里
 * （非流式在响应体的 usage 上，流式在 include_usage 那个末块的 usage 上）。两处都认，顶层优先。
 * ⚠️ 缺席或不是数一律 null —— 记账那侧看见 null 就不动任何东西（假数据比没有更坏）。
 */
export function upstreamCostOf(obj) {
  for (const v of [obj?.cost, obj?.usage?.cost]) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class UpstreamBilling {
  constructor() { this.map = new Map(); }   // sid → Map<appModel, acc>
  /**
   * @param {string} sid
   * @param {string} appModel
   * @param {{ costUsd?: number|null, usage?: object|null }} info
   */
  note(sid, appModel, { costUsd = null, usage = null } = {}) {
    if (!sid || !appModel) return;
    const c = costUsd == null || !Number.isFinite(Number(costUsd)) ? null : Number(costUsd);
    if (c == null && !usage) return;
    let per = this.map.get(sid);
    if (!per) { per = new Map(); this.map.set(sid, per); }
    const acc = per.get(appModel) || { costUsd: null, responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
    acc.responses += 1;
    if (c != null) acc.costUsd = (acc.costUsd || 0) + c;
    if (usage) {
      acc.promptTokens += Number(usage.prompt_tokens) || 0;
      acc.completionTokens += Number(usage.completion_tokens) || 0;
      acc.cachedTokens += Number(usage.prompt_tokens_details?.cached_tokens) || 0;
      acc.reasoningTokens += Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
    }
    per.set(appModel, acc);
  }
  /** 取走并清零该会话的累计：{ appModel → acc }；没有 → null */
  take(sid) {
    const per = sid ? this.map.get(sid) : null;
    if (!per) return null;
    this.map.delete(sid);
    return Object.fromEntries(per);
  }
  peek(sid) { const per = this.map.get(sid); return per ? Object.fromEntries(per) : null; }
  clear(sid) { if (sid) this.map.delete(sid); else this.map.clear(); }
}

export const upstreamBilling = new UpstreamBilling();
export const noteUpstreamBilling = (sid, appModel, info) => upstreamBilling.note(sid, appModel, info);
export const takeUpstreamBilling = (sid) => upstreamBilling.take(sid);

/**
 * OpenAI usage → 统一 token 口径（relay 账本用，model-ingress 的 onBilling 回调走它）。
 * OpenAI 的 prompt_tokens **含**缓存命中，Anthropic 的 input_tokens **不含**（cache_read 单列）；
 * 账本按 Anthropic 口径存，所以把缓存从 prompt 里减出来。
 * 没有 usage → null（上游只报了 cost 没报 token 的情况，Zen 的 [DONE] 尾包就是这样）。
 */
export function openaiTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const prompt = n(usage.prompt_tokens);
  const cached = Math.min(prompt, n(usage.prompt_tokens_details?.cached_tokens));
  return { input: prompt - cached, output: n(usage.completion_tokens), cacheRead: cached, cacheCreate: 0 };
}
