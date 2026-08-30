/**
 * lib/ingress/session-routes.js — 会话级路由（08-22 从 model-ingress.js 拆出，行为见 resolveSessionWire）。
 *
 * SDK binary 的部分内部 helper 不看 ANTHROPIC_SMALL_FAST_MODEL，直接用它 config 目录里的默认 Claude 名
 * 发请求（_ingress-check 实测抓到 claude-sonnet-5 重试 8 次）。旧基建里这类请求静默打错通路烧钱；
 * fail-loud 之后它们会 502 = helper 功能死。这里给注册过的会话一条兜底：未知 model 名 → 本会话的 fast 模型。
 * session-loop 在 API 会话起 query 前注册、finally 注销。
 *
 * ⛔ 撞名雷（2026-08-19 审计标出、08-20 封死）：API 行的 sdkAlias 同时也是真实的 Claude 名。qwen 会话里的
 * binary 若用这类名字发一发 helper 请求，按全表反查会**命中别的行**、带着别家钥匙静默转发——事前无警报、
 * 成功转发不留日志。表级断言封不住（SDK 内部会用哪些名字没法枚举），所以是**会话级路由**：一个会话只认
 * 自己那行和自己的 fast 行，其它一概改道 fast 兜底，绝不跨行。
 *
 * 08-22 起**会话优先**而不是全表优先：不写 sdkAlias 的行（外部插槽全部 + 08-25 起的内置新行）共用同一个
 * spoof 名（model-table.js SHARED_SDK_ALIAS），全表反查分不出它们，只有会话知道自己是谁。先问会话、再查全表，
 * 对独占别名的行结果不变（自己的 alias 反查到的就是自己）。
 */

import { resolveWireModel, resolveModelRoute, wireNamesOf } from '../../engine/agent/model-context.js';

const sessionRoutes = new Map();     // sessionId → { appModel, fastModel }
/** `${sid}:${model}` 只告一次，防日志洪水（model-ingress.js 读写） */
export const fallbackLogged = new Set();

export function registerIngressSession(sessionId, appModel) {
  const route = resolveModelRoute(appModel);
  if (route.mode === 'api') sessionRoutes.set(sessionId, { appModel: route.appModel, fastModel: route.fastModel });
}

export function unregisterIngressSession(sessionId) {
  sessionRoutes.delete(sessionId);
  for (const k of fallbackLogged) {
    if (k.startsWith(sessionId + ':')) fallbackLogged.delete(k);
  }
}

/**
 * 会话级路由决策（纯函数，有单测）。
 *
 * - 没注册的会话 / 无会话前缀（探针、体检）：全表反查，查不到就是 null（502）。
 * - 注册过的 API 会话：只认**自己那行**和**自己的 fast 行**（按 wireNamesOf：id / alias / 剥 [1m] 的 alias）。
 *   其它名字一律改道 fast 兜底——不在表里的是 SDK helper 默认名（'fallback'），在表里但属于别的行的
 *   就是撞名雷（'collision'），后者尤其不能放过去（那是别家的钥匙、真钱）。
 *
 * role：'main' = 会话主行的请求（主 agent 一轮）；'helper' = fast 行 / 兜底 / 撞名改道
 * （标题、auto 分类器、摘要等一句话的活）。openai-chat 行按 role 选 reasoning_effort。
 *
 * @returns {{ wire: ReturnType<typeof resolveWireModel>, reason: 'table'|'fallback'|'collision'|'none', role: 'main'|'helper',
 *             fastModel?: string, sessionModel?: string, collidesWith?: string }}
 */
export function resolveSessionWire(bodyModel, sessionTag) {
  const sess = sessionTag ? sessionRoutes.get(sessionTag) : null;
  if (!sess) {
    const direct = resolveWireModel(bodyModel);
    return { wire: direct, reason: direct ? 'table' : 'none', role: 'main' };
  }
  if (wireNamesOf(sess.appModel).includes(bodyModel)) return { wire: resolveWireModel(sess.appModel), reason: 'table', role: 'main' };
  if (wireNamesOf(sess.fastModel).includes(bodyModel)) return { wire: resolveWireModel(sess.fastModel), reason: 'table', role: 'helper' };
  const direct = resolveWireModel(bodyModel);
  return {
    wire: resolveWireModel(sess.fastModel),
    role: 'helper',
    reason: direct ? 'collision' : 'fallback',
    fastModel: sess.fastModel,
    sessionModel: sess.appModel,
    ...(direct ? { collidesWith: direct.appModel } : {}),
  };
}
