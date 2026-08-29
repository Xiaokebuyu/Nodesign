/**
 * server/shared/messages.js — 服务端吐给用户的话（2026-08-26 i18n）
 *
 * 跟前端 `web/src/lib/i18n.js` 同一个约定：**key 就是中文原文**，查不到落回原文。
 * 所以把 `error: '用户名或密码错误'` 改成 `error: msg(req, '用户名或密码错误')`
 * 对中文用户是空操作 —— zh-CN 没有词表，msg() 恒等返回。
 *
 * ## 只翻用户真会撞上的
 *
 * 服务端的中文报错有两类：用户操作的自然结果（密码错、配额满、模型不开放），
 * 和用户根本不该看到的内部错（`dir 跑出了项目工作区`、`canvas.html 没有 <section>`）。
 * 只翻第一类。第二类翻了也没人读，还会让词表看起来比实际覆盖得多。
 *
 * ## 语言从哪来
 *
 * `req.user.locale` 优先，没有就读 `Accept-Language`。**登录失败时压根没有
 * req.user**（那正是最需要说对语言的时刻），所以 header 兜底不是可选项。
 */

import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage } from './locales.js';
import en from './messages-en.js';

const CATALOGS = { 'zh-CN': null, en };

/**
 * 这个请求该用哪种语言。
 * 顺序：账号上记的 > Accept-Language > 中文。
 */
export function localeOf(req) {
  const fromUser = req?.user?.locale;
  if (isLocale(fromUser)) return fromUser;
  const fromHeader = localeFromAcceptLanguage(req?.headers?.['accept-language']);
  return fromHeader || DEFAULT_LOCALE;
}

/** `{name}` 占位符。参数缺了留占位符，别把 undefined 印给用户 */
function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (whole, k) => (
    params[k] === undefined || params[k] === null ? whole : String(params[k])
  ));
}

/**
 * 按语言取一句话。
 *
 *   msg(req, '用户名或密码错误')
 *   msg(req, '今天的免费轮次用完了（{used} / {limit}），明天零点刷新', { used, limit })
 *
 * 查不到词条返回中文原文 —— 这是设计。
 */
export function msg(req, key, params) {
  return withLocale(localeOf(req), key, params);
}

/** 手上只有 locale 没有 req 时用（比如后台任务、WS 推送） */
export function withLocale(locale, key, params) {
  const dict = CATALOGS[isLocale(locale) ? locale : DEFAULT_LOCALE];
  const v = (dict && dict[key] !== undefined) ? dict[key] : key;
  return params ? interpolate(v, params) : v;
}
