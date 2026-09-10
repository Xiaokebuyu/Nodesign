/**
 * server/lib/model-availability.js — 一行模型此刻能不能用（2026-09-10）。
 *
 * 两个来源，一个判据：
 *   1. **站主的总闸**（lib/model-switches.js，落库、留痕）
 *   2. **钟点闸**（模型表的 `unavailable` 字段，现算、不落任何存储）—— 起因是 Merge 网关那条
 *      DeepSeek V4.1 Flash：上游在 UTC 01:00-04:00、06:00-10:00 两段涨价一倍，站主宁可这几个钟头
 *      关门也不付双倍。
 *
 * ⛔ 不可用**不自动换线**（站主 09-10：先别加 fallback）。它做两件事：选择器里那行灰着、写清楚
 *    什么时候回来；请求进来就拦下，话里直说"换一行"。会话被别人悄悄搬到另一个模型上，比用不了更糟。
 * ⛔ 判据只有这一份。picker 的锁、PUT /model 的白名单、turn 的拦截**都问这里** ——
 *    这类"三处各判一次"的账本站吃过（见 feedback-single-source-of-truth）。
 *
 * 时区：窗口按 `tz`（IANA 名，默认 UTC）里的**墙上时间**算，跨零点写成 '22:00-02:00' 也认。
 * ⚠️ 恢复时刻是「离窗口结束还有几分钟」加出来的，不做时区偏移换算 —— 所以窗口正好横跨该时区的
 *    夏令时切换那天会差一个钟头。UTC 没有夏令时；换成有夏令时的时区再来修这一处。
 */

import { isModelDisabled } from './model-switches.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → 当天第几分钟。不合法 → null */
function toMinutes(text) {
  const m = HHMM.exec(String(text || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 'HH:MM-HH:MM' → {startMin, endMin}。不合法 → null（调用方决定是报错还是丢行） */
export function parseWindow(text) {
  const parts = String(text || '').split('-');
  if (parts.length !== 2) return null;
  const startMin = toMinutes(parts[0]);
  const endMin = toMinutes(parts[1]);
  if (startMin === null || endMin === null || startMin === endMin) return null;
  return { startMin, endMin };
}

/**
 * 校验 `unavailable` 字段。**内置行的错当场炸、插槽的错丢行**，两边用的是这一份判据。
 * @returns {string[]} 每条一句人话；空数组 = 没问题
 */
export function validateUnavailableSpec(spec) {
  const errors = [];
  if (spec === undefined || spec === null) return errors;
  if (typeof spec !== 'object' || Array.isArray(spec)) return ['unavailable 必须是 { why, tz, windows } 这样一个对象'];
  const { why, tz, windows } = spec;
  if (why !== undefined && (typeof why !== 'string' || !why.trim())) errors.push('unavailable.why 要么不写、要么是一句说明为什么关门的话');
  if (tz !== undefined) {
    if (typeof tz !== 'string' || !tz.trim()) errors.push('unavailable.tz 要么不写（默认 UTC）、要么是 IANA 时区名');
    else {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); }
      catch { errors.push(`unavailable.tz '${tz}' 不是认得的时区名（IANA，比如 UTC / Asia/Shanghai）`); }
    }
  }
  if (!Array.isArray(windows) || !windows.length) {
    errors.push('unavailable.windows 至少要有一段，写成 ["01:00-04:00"] 这样');
  } else {
    windows.forEach((w, i) => {
      if (!parseWindow(w)) errors.push(`unavailable.windows[${i}] '${w}' 要写成 'HH:MM-HH:MM'（24 小时制，起止不能一样）`);
    });
  }
  return errors;
}

/** now 在 tz 里是当天第几分钟 */
function minutesOfDayIn(tz, now) {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return toMinutes(text) ?? 0;
}

const inWindow = (min, { startMin, endMin }) =>
  (startMin < endMin ? min >= startMin && min < endMin : min >= startMin || min < endMin);   // 跨零点的窗口

/**
 * 此刻在不在关门窗口里。
 * @returns {null | {why: string, resumesAt: Date, minutesLeft: number, windows: string[], tz: string}}
 */
export function closureNow(spec, now = new Date()) {
  if (!spec || !Array.isArray(spec.windows)) return null;
  const tz = spec.tz || 'UTC';
  let min;
  try { min = minutesOfDayIn(tz, now); } catch { return null; }   // 时区名坏了不该拖垮请求（校验那层会报）
  for (const raw of spec.windows) {
    const w = parseWindow(raw);
    if (!w || !inWindow(min, w)) continue;
    const minutesLeft = ((w.endMin - min) + 1440) % 1440 || 1440;
    const resumesAt = new Date(now.getTime() + minutesLeft * 60_000);
    resumesAt.setSeconds(0, 0);
    return { why: spec.why || '按钟点关门', resumesAt, minutesLeft, windows: spec.windows.slice(), tz };
  }
  return null;
}

/** 给用户看的恢复时刻：北京时间 + 还有多久（站里的人都在这个时区，UTC 那串对他们没有意义） */
function resumeText(resumesAt, minutesLeft) {
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(resumesAt);
  const left = minutesLeft >= 60
    ? `约 ${Math.floor(minutesLeft / 60)} 小时${minutesLeft % 60 ? ` ${minutesLeft % 60} 分` : ''}后`
    : `约 ${minutesLeft} 分钟后`;
  return `${left}（北京时间 ${clock}）恢复`;
}

/**
 * 这一行此刻能不能用。**picker / PUT /model / turn 三处都问它**。
 * @param {{id: string, unavailable?: object}} row 模型表的行，或 SELECTABLE_MODELS 里的条目
 * @param {Date} [now]
 * @returns {{ok: true} | {ok: false, kind: 'disabled'|'closed', reason: string, resumesAt: string|null}}
 */
export function availabilityOf(row, now = new Date()) {
  if (!row?.id) return { ok: true };
  if (isModelDisabled(row.id)) {
    return { ok: false, kind: 'disabled', reason: '站主已停用这个模型，请在选择器里换一个', resumesAt: null };
  }
  const closed = closureNow(row.unavailable, now);
  if (closed) {
    return {
      ok: false,
      kind: 'closed',
      reason: `${closed.why} · ${resumeText(closed.resumesAt, closed.minutesLeft)}，这段时间请换一个模型`,
      resumesAt: closed.resumesAt.toISOString(),
    };
  }
  return { ok: true };
}
