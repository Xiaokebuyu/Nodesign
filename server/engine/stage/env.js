/**
 * engine/stage/env.js —— 演出进程的环境变量（2026-09-06 从 manager.js 拆出，行数棘轮）
 *
 * 通路跟主循环同一张表：订阅模型不注 API key（owner 得有 subscription 资格）；API 模型 BASE_URL 指进程内 ingress。
 * ⛔ 不开工具延迟加载：五件 MCP 工具已 alwaysLoad，开了反而让模型找不到 write_scene（09-05 真栽）。
 */

import { resolveModelRoute } from '../agent/model-context.js';
import { getOrStartIngress, registerIngressSession } from '../../lib/model-ingress.js';
import { can } from '../../auth/tier.js';
import { platform } from '../../runtime/platform.js';

export async function buildEnv(rt, model, owner) {
  const { NODE_ENV: _a, npm_config_production: _b, npm_config_omit: _c, OLDPWD: _d, ...inherited } = process.env;
  const env = { ...inherited, PWD: rt.wsRoot, CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign-stage/0.0.1', CLAUDE_CONFIG_DIR: platform.claudeConfigDir };
  delete env.ENABLE_TOOL_SEARCH;
  const route = resolveModelRoute(model);
  if (route.mode === 'api') {
    const ingress = await getOrStartIngress();
    env.ANTHROPIC_BASE_URL = `${ingress.baseUrl}/__nd/${encodeURIComponent(rt.sdkSid)}`;
    env.ANTHROPIC_API_KEY = 'nd-ingress-managed';
    registerIngressSession(rt.sdkSid, model);
    rt.ingressRegistered = true;
    if (route.fastModel) env.ANTHROPIC_SMALL_FAST_MODEL = route.fastModel;
    if (route.window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(route.window);
  } else {
    if (!can(owner, 'subscription')) throw Object.assign(new Error('这个账号没有订阅通路资格，故事进程起不来'), { status: 403 });
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; else delete env.ANTHROPIC_API_KEY;
    if (process.env.NODESIGN_FAST_MODEL) env.ANTHROPIC_SMALL_FAST_MODEL = process.env.NODESIGN_FAST_MODEL;
  }
  return env;
}
