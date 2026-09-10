/**
 * server/engine/agent/model-switch-rules.js — **会话中途换模型**的规矩（2026-09-10 从 model-context.js 拆出）。
 *
 * 拆的理由是行数棘轮（那边顶到 600）+ 这三个函数本来就是一层策略：它们只问"从这行换到那行行不行"，
 * 不参与建表、派生索引、路由查表。真相仍在 model-context.js，这里只读它。
 *
 * 三条闸互相正交，别合并：
 *   crossLaneSwitchReason  协议方向（openai-chat 合成的思考块没签名，回传给 Anthropic 那头 400）
 *   hotSwitchLaneReason    通路（跑着的 query env 已定死，订阅 ↔ API 硬切会拿错额度）
 *   modelSwitchRejection   上面两条的调用口，端点只认它
 */

import { resolveWireModel, resolveModelRoute, modelFactsFor } from './model-context.js';

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
  // 09-08 站主撤掉「openai-chat → API 透传行」这一段的拦截：ingress 的透传腿现在会把没签名的思考块剥掉
  // （transformForUpstream → stripUnsignedThinking）。仍拦的只剩订阅行：那条路不经 ingress，剥不了。
  if (from?.protocol === 'openai-chat' && resolveModelRoute(toModel).mode === 'subscription') {
    const fromLabel = modelFactsFor(from.appModel)?.label || from.appModel;
    return `本会话在 ${fromLabel} 上创建，其思考记录切换到其他模型后会被拒收。如需更换模型，请新建一个会话`;
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
    ? '本轮会话由订阅模型启动，运行中无法切换到 API 模型：网关地址与密钥在本轮启动时已确定，强行切换会占用订阅额度。请在本轮结束后再切换，或新建一个会话'
    : '本轮会话由 API 模型启动，运行中无法切换回订阅模型：网关地址同样在本轮启动时已确定。请在本轮结束后再切换，或新建一个会话';
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
