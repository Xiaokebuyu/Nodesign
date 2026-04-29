/**
 * 共享 Anthropic SDK client（Nodesign）
 *
 * 来源：从 dev/server/bot/anthropic-client.js 复制改造
 *
 * 当前指向 Moonshot AI（Kimi K2.6）的 Anthropic 兼容端点。
 *   - 文档：https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
 *   - 兼容层会主动缩放 temperature：real_temp = request_temp * 0.6（调参时记得）
 *   - 改 baseURL 即可切到官方 Anthropic / Bedrock / OpenRouter（救场用）
 *
 * 待验证（下个 session 第一件事）：
 *   - cache_control: { type: 'ephemeral' } 是否在 Kimi 兼容端点上生效
 *     （deskskill-engine 的 SKILL.md ~15K tokens，每轮重传成本敏感）
 *   - thinking 启用方式：MiniMax 用 anthropic-beta: interleaved-thinking-2025-05-14
 *     Kimi 是否同 beta header / 还是用自己的 reasoning 参数，需查文档
 *   - 流式 tool_use（input_json_delta）行为是否一致
 */

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.KIMI_API_KEY;
if (!apiKey) {
  console.warn('[Nodesign/SDK] KIMI_API_KEY 未配置，LLM 调用将失败');
}

export const client = new Anthropic({
  apiKey: apiKey || 'missing',
  baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic',
  maxRetries: 2,            // 网络抖动重试
  timeout: 600_000,         // 长任务（deskskill-engine 4 轮串跑）可能 5+ 分钟
});

export const DEFAULT_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';

/** 摘要模型：生成进度卡片标题等轻量任务，不开思考 */
export const SUMMARY_MODEL = process.env.KIMI_SUMMARY_MODEL || 'kimi-k2.6';

/**
 * 交错思考 beta 头（边推理边调工具，跨轮次保持思考连贯）
 *
 * ⚠️ 这是 Anthropic 官方 + MiniMax 兼容端点的格式。Kimi 是否支持同名 beta header
 * 待验证；如果不支持，可能要改用 Kimi 的 reasoning 参数（K2 Thinking 系列原生支持）。
 */
export const INTERLEAVED_THINKING_HEADERS = {
  'anthropic-beta': 'interleaved-thinking-2025-05-14',
};

/**
 * 救场用：切回官方 Anthropic 时的配置（参考）
 *   baseURL: 'https://api.anthropic.com'
 *   apiKey:  process.env.ANTHROPIC_API_KEY
 *   model:   'claude-opus-4-7'
 * 实测 Kimi 创造性长文本质量不达标时切；做成 ENGINE_LLM_PROVIDER 可切是阶段 1 的事
 */
