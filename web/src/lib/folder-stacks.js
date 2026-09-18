/**
 * folder-stacks.js —— 文件夹里按类型 / 按时间归堆（2026-09-18）
 *
 * 站主 09-17 定「文件夹要有管理措施：借 macOS 桌面叠放那套，按类型和时间自动归堆，卡面显示件数
 * 与最近一件的缩略」，归堆的轴他答「都给」。生成图住进文件夹之后，一个文件夹里几十上百张图是常态，
 * 平铺的网格翻到底才找得到今天那几张。
 *
 * 纯函数：吃物件，吐分组。怎么画在 FolderWindow 里。
 *   - 时间轴按 macOS 叠放的分法：今天 / 昨天 / 前 7 天 / 前 30 天 / 再往前按月
 *   - 类型轴按用户认得的名字（图片、站点、文档…），不按扩展名
 *   - 组内一律最近的在前
 */

export const STACK_AXES = Object.freeze([
  { id: 'none', label: '不叠' },
  { id: 'type', label: '按类型' },
  { id: 'time', label: '按时间' },
]);

/** 超过这么多件才默认归堆：几件东西摊开看最快，叠起来反而要多点一下 */
export const STACK_MIN = 8;

const TYPE_LABEL = {
  image: '图片', video: '视频', site: '站点', deck: '演示', docx: '文档', stage: '演出', note: '便签', file: '文件',
};
const TYPE_ORDER = ['图片', '视频', '站点', '演示', '文档', '演出', '便签', '文件'];
const DAY = 86_400_000;

export function typeLabelOf(o) {
  return TYPE_LABEL[o?.type] || '其他';
}

const mtimeOf = (o) => {
  const t = Date.parse(o?.mtime || '');
  return Number.isFinite(t) ? t : 0;
};

/** 最近的在前（没有时间的垫底） */
export function latestFirst(items) {
  return [...items].sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

/**
 * 一个时间落在哪一堆。按**本地日历日**算（「今天」是用户眼里的今天，不是 24 小时内）。
 * @returns {{ label: string, rank: number }} rank 越小越新
 */
export function timeBucketOf(mtime, now = Date.now()) {
  const t = Date.parse(mtime || '');
  if (!Number.isFinite(t) || !t) return { label: '更早', rank: 1e9 };
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (t >= start) return { label: '今天', rank: 0 };
  if (t >= start - DAY) return { label: '昨天', rank: 1 };
  if (t >= start - 7 * DAY) return { label: '前 7 天', rank: 2 };
  if (t >= start - 30 * DAY) return { label: '前 30 天', rank: 3 };
  const d = new Date(t); const n = new Date(now);
  const monthsAgo = (n.getFullYear() * 12 + n.getMonth()) - (d.getFullYear() * 12 + d.getMonth());
  return { label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, rank: 4 + Math.max(0, monthsAgo) };
}

/** 默认按哪根轴叠：件数少不叠；混着好几类按类型，清一色（比如全是生成图）按时间 */
export function autoAxis(items) {
  if (!items || items.length <= STACK_MIN) return 'none';
  return new Set(items.map(typeLabelOf)).size > 1 ? 'type' : 'time';
}

/**
 * 分堆。
 * @param {Array<{type, mtime}>} items
 * @param {'none'|'type'|'time'} axis
 * @returns {Array<{ key: string, label: string, items: Array }>|null} null = 不叠
 */
export function stackGroups(items, axis, now = Date.now()) {
  if (axis !== 'type' && axis !== 'time') return null;
  const groups = new Map();
  for (const o of items) {
    const g = axis === 'type'
      ? { label: typeLabelOf(o), rank: TYPE_ORDER.includes(typeLabelOf(o)) ? TYPE_ORDER.indexOf(typeLabelOf(o)) : 99 }
      : timeBucketOf(o?.mtime, now);
    if (!groups.has(g.label)) groups.set(g.label, { key: `${axis}:${g.label}`, label: g.label, rank: g.rank, items: [] });
    groups.get(g.label).items.push(o);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(({ key, label, items: its }) => ({ key, label, items: latestFirst(its) }));
}
