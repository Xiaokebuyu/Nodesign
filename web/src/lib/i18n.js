/**
 * i18n —— 界面文案的语言层（2026-08-26）
 *
 * ## 为什么 key 是中文原文
 *
 * 全站 1462 条中文文案，这一轮只翻门面那 ~300 条，其余留在中文。用中文原文当
 * key，没翻到的自然落回原文，界面照常是中文；换成 `home.newProject` 那种点号键，
 * 没翻到的会在界面上露出裸键 —— 对一个中文优先、英文是第二语言的产品来说，
 * **回退到中文是对的行为，回退到裸键是 bug**。
 *
 * 代价是改中文原文会让翻译静默失配。所以配了 `i18n-catalog.lint.test.js`：
 * 词条在源码里找不到对应原文就红。契约要配 lint，注释拦不住任何人。
 *
 * ## 为什么不是 hook
 *
 * `canvas-menus.js`、`element-semantics.js`、`board-kinds.js` 这些是纯数据模块，
 * 在 React 之外被调用，拿不到 hook。所以 `t()` 是模块级函数，读模块级的
 * `current`；React 侧的重渲染由 globalStore 的 `locale` 触发（切换器同时写两处，
 * 见 setLocale）。两份状态但只有一个写入口，不是两个真相源。
 */

import en from '../locales/en.js';

/** 支持的语言。加一门语言 = 这里加一行 + locales/ 加一个文件 */
export const LOCALES = [
  { id: 'zh-CN', label: '中文', english: 'Chinese' },
  { id: 'en', label: 'English', english: 'English' },
];

export const DEFAULT_LOCALE = 'zh-CN';

/** zh-CN 没有词表：它是源语言，t() 直接返回 key */
const CATALOGS = { 'zh-CN': null, en };

export function isLocale(id) {
  return LOCALES.some((l) => l.id === id);
}

/**
 * 把浏览器给的 tag 归一到我们支持的语言。
 * `zh`、`zh-Hans`、`zh-TW` 全落 zh-CN（繁体没单独做，先给中文不给英文）；
 * `en-US`、`en-GB` 落 en；其余落 null 交给调用方决定。
 */
export function normalizeLocale(tag) {
  if (!tag) return null;
  const s = String(tag).toLowerCase();
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('en')) return 'en';
  return null;
}

/**
 * 一串浏览器语言 tag → 用哪种界面语言。
 *
 * 前两条是老规矩（按 navigator.languages 的顺序取第一个认识的）。第三条是
 * 2026-08-29 补的：**报了语言但一门都不是中英**（日语、韩语、德语…）时给英文。
 * 那种访客读英文的可能远大于读中文，落回 zh-CN 等于递给他一页看不懂的字。
 * 「中文优先」只对「没说自己读什么」的情况成立。
 *
 * ⚠️ 不按 IP 猜国家：IP 回答的是「这条网络在哪」，浏览器语言回答的是「这个人读
 * 什么」—— 两者恰恰在最要紧的场合背离（人在国外的中文用户、住在国内的英文用户、
 * 挂着代理的所有人）。而且这一条不用等任何网络往返就能定，IP 那条要么多一跳
 * 要么得让 index.html 变成动态的。
 */
export function localeFromTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (const tag of list) {
    const hit = normalizeLocale(tag);
    if (hit) return hit;
  }
  // `*` 和垃圾值不算"说了某种语言"（跟服务端 statesAnyLanguage 同一条形状判据）
  const stated = list.some((tag) => {
    const s = String(tag || '').trim();
    return s !== '*' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(s);
  });
  return stated ? 'en' : DEFAULT_LOCALE;
}

/**
 * 开机取语言。优先级：
 *   1. 用户在本机显式选过的（localStorage）—— 表态最硬，跨账号沿用
 *   2. 浏览器语言
 *   3. zh-CN
 *
 * 账号上的 `users.locale` 不在这条链里：它由 AuthGate 拿到 /auth/status 之后
 * 再调 setLocale 覆盖，前提是本机没有第 1 条。理由是「这台机器上这个人的偏好」
 * 比「账号上记的偏好」更贴近当下，跟 canvasFont / followAgent 同一个判断。
 */
function detect() {
  try {
    const saved = localStorage.getItem('nd:locale');
    if (isLocale(saved)) return saved;
  } catch { /* 隐私模式 */ }
  try {
    const tags = navigator.languages || (navigator.language ? [navigator.language] : []);
    return localeFromTags(tags);
  } catch { /* 非浏览器环境（测试 / SSR 探针） */ }
  return DEFAULT_LOCALE;
}

let current = detect();
/** 本机有没有显式表态过 —— 决定账号偏好能不能覆盖 */
let explicit = (() => {
  try { return isLocale(localStorage.getItem('nd:locale')); } catch { return false; }
})();

export function getLocale() {
  return current;
}

export function hasExplicitLocale() {
  return explicit;
}

/**
 * 换语言。`opts.explicit` 为 true 表示这是用户在切换器里点的（要记住），
 * false 表示是账号偏好回填（不记，免得盖掉本机表态）。
 */
export function setLocale(id, { explicit: isExplicit = true } = {}) {
  if (!isLocale(id)) return current;
  current = id;
  if (isExplicit) {
    explicit = true;
    try { localStorage.setItem('nd:locale', id); } catch { /* */ }
  }
  return current;
}

/** `{name}` 占位符替换。参数缺了就原样留着占位符，别把 undefined 印到界面上 */
function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (whole, k) => (
    params[k] === undefined || params[k] === null ? whole : String(params[k])
  ));
}

/**
 * 复数。中文不分单复数，所以词条写成 `{ one, other }` 只是给英文用的；
 * 数量从 `params.count` 取（没有就落 other）。
 * 只做 one/other 两档 —— 英文够了，将来真要接俄语波兰语再上 Intl.PluralRules。
 */
function pickPlural(entry, params) {
  const n = params?.count;
  return (n === 1 && entry.one !== undefined) ? entry.one : entry.other;
}

/**
 * 翻译。`t('我的项目')`、`t('{n} 件开了头', { n: 3 })`、
 * `t('{count} 个项目', { count: 1 })`（词条给 { one, other } 时按 count 选）。
 *
 * 查不到词条就返回原文 —— 这是设计，不是兜底失败。
 */
export function t(key, params) {
  const dict = CATALOGS[current];
  let v = dict ? dict[key] : undefined;
  if (v === undefined) v = key;
  if (v && typeof v === 'object') v = pickPlural(v, params);
  return params ? interpolate(v, params) : v;
}
