/**
 * server/shared/locales.js — 支持的界面语言（服务端真相源，2026-08-26）
 *
 * 服务端要这份表做三件事：校验 `users.locale` 的写入、按语言挑用户可见的报错、
 * 给 agent 注语言指令。前端另有一份带显示名的 `web/src/lib/i18n.js` —— 那份要
 * 「中文 / English」这种给人看的标签，塞进服务端没意义。
 *
 * 双份表的宿命是漂移，所以配了 `web/src/lib/i18n-locales.parity.test.js` 逐项对账
 * （跟 board-kind-sizes 那对表同款纪律）。加语言要同时改两处，忘了就红。
 */

/** 语言 id。第一项是默认值 —— 这个产品是中文优先的，英文是第二语言 */
export const LOCALES = Object.freeze(['zh-CN', 'en']);

export const DEFAULT_LOCALE = LOCALES[0];

export function isLocale(id) {
  return LOCALES.includes(id);
}

/**
 * 把语言 tag 归一到支持的语言，认不出返回 null。
 * `zh` / `zh-Hans` / `zh-TW` 全落 zh-CN（繁体没单独做，先给中文别给英文）。
 */
export function normalizeLocale(tag) {
  if (!tag) return null;
  const s = String(tag).toLowerCase();
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('en')) return 'en';
  return null;
}

/**
 * 解析 HTTP `Accept-Language`，按 q 值排序取第一个认识的。
 * 拿不到就返回 null —— 由调用方决定落什么默认，这里不替它做主。
 *
 * 例：`en-US,en;q=0.9,zh-CN;q=0.8` → 'en'
 */
export function localeFromAcceptLanguage(header) {
  if (!header) return null;
  const ranked = String(header).split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim(), q: q ? parseFloat(q.split('=')[1]) || 0 : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const hit = normalizeLocale(tag);
    if (hit) return hit;
  }
  return null;
}

/**
 * Accept-Language 里有没有**至少一个像语言 tag 的东西**（2026-08-29）。
 *
 * 用来区分两种"认不出"：
 *   `ja,ko;q=0.9` —— 人家明确说了自己读日语韩语，只是我们没有这两门 → 给英文
 *   `???` / `;;;` / `*` / 空 —— 什么都没说清 → 中文优先照旧
 * 前一种落回中文等于递给他一页看不懂的字；后一种没有任何证据，不该乱猜。
 */
export function statesAnyLanguage(header) {
  if (!header) return false;
  return String(header).split(',').some((part) => {
    const tag = part.trim().split(';')[0].trim();
    return tag !== '*' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag);
  });
}
