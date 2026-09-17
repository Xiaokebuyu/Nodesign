/**
 * helpers/browser-slots.js —— 感知工具开 chromium 的进程级闸（2026-09-13）
 *
 * 为什么要有：截图 / 量具类工具在 tool-concurrency.js 登记成可并行之后，CLI 会把同一条消息里的
 * 几个调用同时派发；不设闸就是同时拉起几只 chromium。以前这些工具在同一会话里天然串行，跨会话却
 * 从来不设限（只有 look_at_board 自己有一条模块级串行闸）。现在收成一处：
 *   - 托管版 1 只：生产机 1 vCPU、8G 无 swap。单核上两只并行不会更快，峰值内存翻倍，
 *     而且会把 profile_scroll / 胶片条量到的帧时间搅乱；
 *   - 本地版（桌面）2 只；
 *   - NODESIGN_PERCEPTION_BROWSERS 可覆盖（运维口，不进文档）。
 * 测帧时间的量具（profile_scroll、trace_motion、screenshot 的胶片条）拿**全部**槽位：
 * 同一台机器上另一只浏览器在跑，量出来的卡顿是假的。
 *
 * 不归这里管的（别顺手接进来）：
 *   - 产物会话 / 浏览通道的常驻浏览器（engine/perception/session.js、engine/browse/registry.js）：
 *     常驻占着槽会把一次性工具饿死，它们各自有按项目的锁；
 *   - 服务端 API 的导出 / 首页封面 / 圈选截图（api/exports.js、lib/cover.js 的默认调用、lib/region-shot.js）：
 *     用户在等页面响应，不该排在 agent 的截图后面。
 *     例外（09-17）：画布拉远时的远景缩略图（lib/artifact-thumb.js 经 cover.js 注入 launch）**过这道闸**——
 *     一块板一次能请求几十张，是后台补图，排在 agent 的截图后面是有意的。
 *
 * 排队按项目轮转（lib/slot-pool.js）：一个项目一条消息发一串截图，别的项目最多等正在跑的那一个。
 *
 * 用法：gatedBrowser(() => launchPerceptionBrowser(), { exclusive, key: projectId })。返回的 browser.close() 顺带还槽；
 * 浏览器崩了（disconnected）也还。还槽幂等。调用方照旧在 finally 里 close。
 */
import { makeSlotPool } from '../../../../lib/slot-pool.js';
import { platform } from '../../../../runtime/platform.js';

export function perceptionBrowserSlots({ env = process.env, isLocal = platform?.isLocal } = {}) {
  const n = Number(env.NODESIGN_PERCEPTION_BROWSERS);
  if (Number.isInteger(n) && n >= 1) return n;
  return isLocal ? 2 : 1;
}

export const browserSlots = makeSlotPool(perceptionBrowserSlots());

/**
 * @template B
 * @param {() => Promise<B>} launch  真正开浏览器的那一下
 * @param {{ exclusive?: boolean, key?: string, pool?: ReturnType<typeof makeSlotPool> }} [opts]  key = 排队来源（项目 id）
 * @returns {Promise<B>}
 */
export async function gatedBrowser(launch, { exclusive = false, key = '', pool = browserSlots } = {}) {
  const release = await pool.acquire(exclusive ? Infinity : 1, key);
  let browser;
  try {
    browser = await launch();
  } catch (err) {
    release();
    throw err;
  }
  try { browser.on?.('disconnected', release); } catch { /* 假浏览器 / 旧接口 */ }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    try { return await close(...args); } finally { release(); }
  };
  return browser;
}
