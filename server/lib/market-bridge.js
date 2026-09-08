/**
 * lib/market-bridge.js — 内核到市场的注册口（09-08 晚，v2）。
 *
 * 市场的存储在 hosted/（网页站点）或在站主 relay 的另一头（桌面版），内核不能 import 它们
 * （check-client-boundary 钉着）。agent 的 crystallize_skill 要能"进橱窗并发布"，就得走这条注册口：
 * 谁托管谁在启动时 registerMarketPublisher；没人注册就是"本实例没有市场"，工具照实回。
 * 形状同 quota.registerUsageSource（内核开口、外层注入）。
 */

let publisher = null;

/**
 * @param {(args: { userId: string, title: string, note?: string|null, skillName?: string|null,
 *   images: Array<{ buf: Buffer, type: string, name: string }>, showcaseId?: string|null }) => Promise<object>} fn
 *   返回发布对象（至少 { id, kind, title }）；失败抛错（带 code / message，工具原样转述）
 */
export function registerMarketPublisher(fn) { publisher = typeof fn === 'function' ? fn : null; }

export function marketPublisherRegistered() { return !!publisher; }

export async function publishToMarket(args) {
  if (!publisher) throw Object.assign(new Error('本实例没有接市场（站点没开市场，或桌面版还没登录站点账号）'), { code: 'MARKET_UNAVAILABLE' });
  return publisher(args);
}

/** 测试用 */
export function _resetMarketPublisher() { publisher = null; }
