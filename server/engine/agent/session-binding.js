/**
 * engine/agent/session-binding.js —— 一个会话绑到哪条通路（session-loop 的 init 段拆出来的，09-06）。
 *
 * 三条路，按模型表和本机状态决定：
 *   订阅直连     订阅行，本机有 ~/.claude 凭据（hosted 就是站主的；本地版是用户自己 claude login 的）
 *   进程内 ingress  API 行，本机有那一行的钥匙 → lib/model-ingress 按 body.model 换上游换钥匙
 *   站主 relay   本地分发版：本机没这一行的钥匙、站主 relay 目录里有 → 请求发去站主服务器
 *                （runtime/relay-client.js）。两条通路在 relay 上走同一个入口：base URL 指 relay，
 *                钥匙位置放设备令牌（relay 认 x-api-key 里的 ndk_ 令牌），走哪条腿服务器按登记的模型判。
 *                SDK 在这里永远是"API 模式"（有 ANTHROPIC_API_KEY 就不会去读本机 ~/.claude），本机
 *                没有站主凭据，这正是要的。判决（档位 / 额度 / 外审）全在服务器：登记失败就让 init 失败。
 */

import { Events } from './events.js';
import { resolveModelRoute, modelSourceFor } from './model-context.js';
import { resolveDefaultFastModel } from '../agents/index.js';
import { getOrStartIngress, registerIngressSession } from '../../lib/model-ingress.js';
import { registerSessionNotice } from '../../lib/ingress/session-notice.js';
import { getUserById } from '../../auth/users-store.js';
import { can } from '../../auth/tier.js';
import { openRelaySession, closeRelaySession, relayBaseUrlFor, relayConfig } from '../../runtime/relay-client.js';

/**
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.model      appModel
 * @param {string|null} args.ownerId  项目 owner（订阅资格断言用）
 * @param {(ev: object) => void} args.emit  往会话里推事件（ingress 的"正在重试"通知）
 * @returns {Promise<{ baseUrl: string|undefined, apiKey: string|undefined, fastModel: string|null, compactWindow: number|null,
 *            noticeHandler: Function|null, relaySid: string|null }>}
 *   调用方要在 finally 里配对：unregisterIngressSession / unregisterSessionNotice(noticeHandler) / relaySid 有值就 unbindSessionFromRelay
 */
export async function bindSessionUpstream({ sessionId, model, ownerId, emit }) {
  // ── 通路由模型表决定（2026-08-19 重建，前身是全局 NODESIGN_GATEWAY_URL 开关）──
  // 订阅模型：什么都不注入（ANTHROPIC_API_KEY 一出现 binary 就弃 OAuth）。
  // API 模型：BASE_URL 指进程内通用入口（model-ingress），入口按请求 body.model
  // 查表换上游换钥匙；binary 侧的 API_KEY 只是"逼它进 API 模式"的占位符。
  // helper（title 总结 / auto-compact / promptSuggestions）与 subagent 因此
  // 天然全通：它们的请求同样进入口、同样被反查路由 —— 不再依赖旧版那个
  // 跨会话互写的 NODESIGN_CURRENT_APP_MODEL 进程全局 env。
  const route = resolveModelRoute(model);
  const out = { baseUrl: undefined, apiKey: undefined, fastModel: null, compactWindow: null, noticeHandler: null, relaySid: null };
  // 本地分发版第三条路（09-06）：本机没这一行的钥匙、但站主 relay 的目录里有 → 请求发去站主服务器
  if (modelSourceFor(model) === 'relay') {
    Object.assign(out, await bindSessionToRelay(sessionId, model, route));
  } else if (route.mode === 'api') {
    const ingress = await getOrStartIngress();   // 起不来就让 init 失败，别静默直连
    out.baseUrl = `${ingress.baseUrl}/__nd/${encodeURIComponent(sessionId)}`;
    out.apiKey = 'nd-ingress-managed';
    // SDK 内部 helper 可能用不在表里的 Claude 名发请求（config 目录默认模型），
    // 注册会话 fast 兜底路由让它们改道而不是 502。finally 配对注销。
    registerIngressSession(sessionId, model);
    // 上游抖的时候（Zen 一次 503 能挂 50~140 秒）会话里什么都不动，用户只看到一个转不停的绿点。
    // 给 ingress 一条推消息的通道，让它把"正在重试"说出来。节流在 session-notice.js，finally 配对注销。
    out.noticeHandler = ({ key, text, priority }) => {
      try { emit(Events.notification(key || 'upstream_retry', text, priority || 'warn')); } catch { /* 通知不该弄死会话 */ }
    };
    registerSessionNotice(sessionId, out.noticeHandler);
    // API 路的 fast model 必须同表可路由（订阅 haiku 在 API 模式会 404），
    // 所以 env 覆盖在这条路上不生效 —— 表是唯一真相。
    out.fastModel = route.fastModel;
    // 把**真实**上下文窗口钉给 SDK。不设的话 SDK 只能按 spoof alias 猜，而
    // alias 的容量和上游真实 n_ctx 基本对不上：猜小了白扔容量，猜大了会一路
    // 涨到超过上游 n_ctx 再炸。实测规律见 resolveModelRoute 注释。
    out.compactWindow = route.window;
  } else {
    // ⭐ 订阅通路的资格断言就放在做 OAuth 决策的这一行（08-21 晚）。API 边界（turn.js /
    // sessions.js 的 allowedModelsFor）是第一道闸；这里是第二道：runSession 以前不认识
    // 用户，只看会话模型决定走不走 ~/.claude 的 OAuth —— quick-summary 那次泄漏（写死
    // haiku 起独立 SDK 会话，08-19 拆）正是这个形状。现在 owner 没资格就 init 失败，
    // 而不是静默烧站主的订阅。owner 为空（无主项目；生产 08-21 实查 0 个）也 fail-closed。
    const owner = ownerId ? getUserById(ownerId) : null;
    if (!can(owner, 'subscription')) {
      throw new Error(`订阅通路资格不足：项目 owner=${ownerId || '(无)'} 档位不含 subscription，模型=${model}`);
    }
    out.baseUrl = process.env.ANTHROPIC_BASE_URL;
    out.apiKey = process.env.ANTHROPIC_API_KEY;
    out.fastModel = process.env.NODESIGN_FAST_MODEL || resolveDefaultFastModel(model);
    // 订阅模型的真名 SDK 自己认得，别去覆盖它已知正确的默认值
    out.compactWindow = null;
  }
  return out;
}

/** relay 那条路的登记 + 绑定。失败抛错（信息里带服务器的 code 和原话） */
async function bindSessionToRelay(sessionId, appModel, route) {
  try {
    await openRelaySession(sessionId, appModel);
  } catch (err) {
    throw new Error(`站主服务不让这个会话开始（${err.code || 'RELAY'}）：${err.message}`);
  }
  return {
    relaySid: sessionId,
    baseUrl: relayBaseUrlFor(sessionId),
    apiKey: relayConfig().token,
    // API 行：跟本地 ingress 一样 fast 必须同表可路由（relay 那头按登记的行改道）；订阅行：SDK 自己认得真名
    fastModel: route.mode === 'api' ? route.fastModel : (process.env.NODESIGN_FAST_MODEL || resolveDefaultFastModel(appModel)),
    compactWindow: route.mode === 'api' ? route.window : null,
  };
}

/** relay 登记的配对注销（不等它：失败有服务器空闲清扫兜底） */
export function unbindSessionFromRelay(sessionId) {
  closeRelaySession(sessionId);
}
