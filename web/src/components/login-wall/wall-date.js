/**
 * 登录墙上「某月第几周」那行字（2026-09-12）。
 *
 * 三套场景原来写死「八月第一 / 二 / 三周」，九月一到就成了旧墙。改成按今天往回数：
 * 三个场景是先后三周（deck 最早、rp 最近），offset 就是往回退几周。
 * 周数按「几号 ÷ 7 向上取整」，跟人随口说的「九月第二周」一致，不按 ISO 周。
 */
const MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const NTH = ['一', '二', '三', '四', '五'];

const dayOf = (weeksAgo, now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * weeksAgo);

export function wallWeek(weeksAgo = 0, now = new Date()) {
  const d = dayOf(weeksAgo, now);
  return `${MONTHS[d.getMonth()]}月第${NTH[Math.ceil(d.getDate() / 7) - 1]}周`;
}

/** 用量小票上那行 `RUN 月日-序号`（同样按今天往回数，别让小票停在八月） */
export function wallRun(weeksAgo = 0, seq = '01', now = new Date()) {
  const d = dayOf(weeksAgo, now);
  const pad = (n) => String(n).padStart(2, '0');
  return `RUN ${pad(d.getMonth() + 1)}${pad(d.getDate())}-${seq}`;
}
