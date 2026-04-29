/**
 * 北京时间工具
 *
 * 来源：从 dev/server/utils/time.js 复制（零改动）
 *
 * toISOString 是 UTC，直接用会在东八区凌晨误差 8 小时。
 * 所有注入 LLM 的"当前时间"应该走这个 util，输出北京时间 + 星期。
 */

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 返回北京时间的多种呈现，供不同 prompt 复用
 * @returns {{ today: string, dateTime: string, weekday: string, nowMs: number, iso: string }}
 *   today:     "2026-04-22"
 *   dateTime:  "2026-04-22 14:32:05"
 *   weekday:   "周三"
 *   nowMs:     毫秒时间戳（给 LLM 做差值用）
 *   iso:       "2026-04-22T14:32:05+08:00"
 */
export function formatBeijingNow() {
  const now = new Date();
  const nowMs = now.getTime();

  // 转北京时间（东八区偏移）
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bj.getUTCDate()).padStart(2, '0');
  const hh = String(bj.getUTCHours()).padStart(2, '0');
  const mm = String(bj.getUTCMinutes()).padStart(2, '0');
  const ss = String(bj.getUTCSeconds()).padStart(2, '0');
  const weekday = WEEKDAY_CN[bj.getUTCDay()];

  const today = `${y}-${m}-${d}`;
  const dateTime = `${today} ${hh}:${mm}:${ss}`;
  const iso = `${today}T${hh}:${mm}:${ss}+08:00`;

  return { today, dateTime, weekday, nowMs, iso };
}

/**
 * 返回适合塞进 prompt 的一行文本
 * "当前时间：2026-04-22 周三 14:32:05（北京时间，毫秒时间戳 1745...）"
 */
export function beijingNowLine() {
  const { today, weekday, dateTime, nowMs } = formatBeijingNow();
  return `当前时间：${dateTime} ${weekday}（北京时间，毫秒时间戳 ${nowMs}）`;
}
