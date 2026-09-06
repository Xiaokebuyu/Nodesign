/**
 * mcp/tools/relay-tools.js —— 工具层的"本机还是网关"选路（09-07，站主：把网页端能提供的服务都给桌面端）。
 *
 * 桌面版（local profile）没有站主的搜索 key / 生图通道。登录站点拿到设备令牌之后，这几件工具
 * 的**供应商调用**改由网关替它跑（server/hosted/relay/tools.js），网关用站主的钥匙、按账号过档位闸和
 * 日额度、记进 relay_usage 账本；文件落盘、缩略图、事件仍在本机做 —— 工具的其余部分一行不变。
 *
 * 选路规则一句话：**本机配了就本机，本机没配而网关说它给就网关，都没有就不可用**。
 * 同一条规则给能力探测（runtime/capabilities.js 的 webSearch / imageGen）和工具本体两处用，
 * 所以引导页显示"可用"跟工具真能跑是同一个判断。
 */
import { relayConfig, relayTools, relayToolCall } from '../../../runtime/relay-client.js';
import { hasAnySearchKey } from './web-search-providers.js';
import { localImageRoute } from './image-produce.js';

/** @returns {'local' | 'relay' | null} */
export function searchRoute() {
  if (hasAnySearchKey()) return 'local';
  if (relayConfig() && relayTools().web_search) return 'relay';
  return null;
}

/** @returns {'codex' | 'gateway' | 'relay' | null} */
export function imageRoute() {
  const local = localImageRoute();
  if (local) return local;
  if (relayConfig() && relayTools().generate_image) return 'relay';
  return null;
}

/** 网关替跑一次搜索。返回跟 runWebSearch 同形状（{ providerId, providerNote, hits, images } 或 { error }） */
export async function relayWebSearch({ query, provider, count, includeImages }) {
  try {
    const r = await relayToolCall('web_search', { query, provider, count, includeImages }, { timeoutMs: 60_000 });
    return r?.error ? { error: r.error } : { providerId: r.providerId, providerNote: r.providerNote || '', hits: r.hits || [], images: r.images || [] };
  } catch (err) {
    return { error: `web_search failed (relay ${err.code || ''}): ${err.message}` };
  }
}

/**
 * 网关替跑一次生图。refs 以 base64 上传（参考图在用户本机）；返回 { base64, mimeType, accompanyText, grounding }
 * 或 { error }。生图要等几十秒到两分钟，超时给足。
 */
export async function relayGenerateImage(payload) {
  try {
    const r = await relayToolCall('generate_image', payload, { timeoutMs: 5 * 60_000 });
    // 网关为了穿 Cloudflare 的 100 秒先发了 200 头，之后的失败是 200 + 错误形状
    if (r?.type === 'error') return { error: `generate_image failed (relay ${r.code || ''}): ${r.error?.message || '未知错误'}` };
    return r?.error ? { error: String(r.error) } : r;
  } catch (err) {
    return { error: `generate_image failed (relay ${err.code || ''}): ${err.message}` };
  }
}
