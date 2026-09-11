/**
 * engine/stage/env.js —— 演出进程的环境变量（2026-09-06 从 manager.js 拆出，行数棘轮）
 *
 * ## 通路不在这里判，在 session-binding.js
 *
 * 2026-09-07 修：这份拷贝原来自己写了一遍「订阅直连 / 进程内 ingress」两条腿，
 * 而 09-06 加的第三条腿（站主 relay，本地分发版的默认通路）只加进了主循环。
 * 结果桌面版任何 relay 来源的模型开演出都被指向本机 ingress，取不到钥匙 502，
 * CLI 退 1，玩家每说一句都石沉大海（问题库 iss_mtqnrdgr_08v2）。
 *
 * ⛔ 别在这里再写第二份路由判断。通路只有 bindSessionUpstream 一个读者，
 * 这里只负责把它给的四个值贴进 env，以及演出进程独有的那几个键。
 *
 * 配对注销走 releaseUpstream（manager 的 stopStage 调）—— 登记了不注销，
 * relay 那头的 sid 和本地 ingress 的会话路由都会残留。
 */

import { bindSessionUpstream, unbindSessionFromRelay } from '../agent/session-binding.js';
import { unregisterIngressSession } from '../../lib/model-ingress.js';
import { unregisterSessionNotice } from '../../lib/ingress/session-notice.js';
import { platform } from '../../runtime/platform.js';

export async function buildEnv(rt, model, owner) {
  const { NODE_ENV: _a, npm_config_production: _b, npm_config_omit: _c, OLDPWD: _d, ...inherited } = process.env;
  const env = { ...inherited, PWD: rt.wsRoot, CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign-stage/0.0.1', CLAUDE_CONFIG_DIR: platform.claudeConfigDir };
  // ⛔ 不开工具延迟加载：五件 MCP 工具已 alwaysLoad，开了反而让模型找不到 write_scene（09-05 真栽）
  delete env.ENABLE_TOOL_SEARCH;

  const bound = await bindSessionUpstream({
    sessionId: rt.sdkSid,
    model,
    ownerId: owner?.id || null,
    // 上游抖动时 ingress 会推「正在重试」。主循环推进会话事件流，演出这边推给显示器的订户
    emit: (ev) => { try { rt.broadcast({ type: 'notice', key: ev.key, text: ev.text, priority: ev.priority }); } catch { /* 通知不该弄死进程 */ } },
  });
  rt.bound = bound;   // 配对注销的凭据，见 releaseUpstream

  // 订阅通路：baseUrl / apiKey 可能本来就是空的（走本机 ~/.claude 的 OAuth）。
  // 空值必须**删键**而不是赋 undefined —— 传给子进程会变成字符串 "undefined"，
  // binary 见到 ANTHROPIC_API_KEY 有值就弃用 OAuth。
  if (bound.baseUrl) env.ANTHROPIC_BASE_URL = bound.baseUrl; else delete env.ANTHROPIC_BASE_URL;
  if (bound.apiKey) env.ANTHROPIC_API_KEY = bound.apiKey; else delete env.ANTHROPIC_API_KEY;
  if (bound.fastModel) env.ANTHROPIC_SMALL_FAST_MODEL = bound.fastModel;
  if (bound.compactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(bound.compactWindow);
  return env;
}

/** buildEnv 的配对注销（幂等）。stopStage 里调，别漏 —— 三样登记各有各的残留后果 */
export function releaseUpstream(rt) {
  const bound = rt.bound;
  if (!bound) return;
  rt.bound = null;
  try { unregisterIngressSession(rt.sdkSid); } catch { /* 幂等 delete */ }
  if (bound.noticeHandler) { try { unregisterSessionNotice(rt.sdkSid, bound.noticeHandler); } catch { /* */ } }
  if (bound.relaySid) { try { unbindSessionFromRelay(bound.relaySid, bound.relayGen); } catch { /* 失败有服务器空闲清扫兜底 */ } }
}
