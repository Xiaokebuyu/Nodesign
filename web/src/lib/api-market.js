/**
 * web/src/lib/api-market.js — skill 市场的前端调用（2026-09-08）
 *
 * 同一组调用两种部署形态各走各的前缀：
 *   hosted（网页）  /api/market/…        cookie 登录墙
 *   local（桌面版） /api/local/market/…  本机转站点（设备令牌在本机，浏览器带不了）
 * 响应形状两边一样（本机那层是透传），页面代码不用分支。前缀在**调用时**看 globalStore.authProfile，
 * 别在模块加载时定死 —— /api/auth/status 回来之前它还是默认的 hosted。
 *
 * 站主的审核台只在 hosted：/api/admin/market/…
 */

import { jsonRequest } from './api.js';
import { useGlobalStore } from '../stores/globalStore.js';

export function marketBase() {
  return useGlobalStore.getState().authProfile === 'local' ? '/api/local/market' : '/api/market';
}

async function multipart(path, fd, { method = 'POST' } = {}) {
  const res = await fetch(path, { method, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { try { window.dispatchEvent(new Event('nd:unauthorized')); } catch { /* test */ } }
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status, code: data.code, body: data });
  }
  return data;
}

export const Market = {
  list: () => jsonRequest('GET', marketBase()),
  mine: () => jsonRequest('GET', `${marketBase()}/mine`),
  featured: () => jsonRequest('GET', `${marketBase()}/featured`),
  get: (id) => jsonRequest('GET', `${marketBase()}/${encodeURIComponent(id)}`),
  imageUrl: (id, n = 0) => `${marketBase()}/${encodeURIComponent(id)}/images/${n}`,
  /**
   * 发布。网页：skillName（从我装着的打包）+ showcaseId（没传图就截封面）+ images[]；
   * 桌面版本机那层收同一组字段（本机打包、本机截图）。
   */
  publish: ({ title, note, skillName, showcaseId, images = [] }) => {
    const fd = new FormData();
    fd.set('title', title);
    fd.set('note', note || '');
    if (skillName) fd.set('skillName', skillName);
    if (showcaseId) fd.set('showcaseId', showcaseId);
    for (const f of images) fd.append('images', f);
    return multipart(marketBase(), fd);
  },
  withdraw: (id) => jsonRequest('DELETE', `${marketBase()}/${encodeURIComponent(id)}`),
  /** 装到我这（网页：我的 plugin 根；桌面版：本机）。同名已装 → 409，body.existing / incoming；force 覆盖 */
  /** 照着来一个（v2）：开一个新项目，参考图入座、skill 装上，回 { projectId, prompt }。桌面版 409 WEB_ONLY */
  fork: (id) => jsonRequest('POST', `${marketBase()}/${encodeURIComponent(id)}/fork`),
  install: (id, { force } = {}) => jsonRequest('POST', `${marketBase()}/${encodeURIComponent(id)}/install${force ? '?force=1' : ''}`),
};

export const AdminMarket = {
  list: (state = 'pending') => jsonRequest('GET', `/api/admin/market?state=${encodeURIComponent(state)}`),
  get: (id) => jsonRequest('GET', `/api/admin/market/${encodeURIComponent(id)}`),
  review: (id, state, reviewNote) => jsonRequest('POST', `/api/admin/market/${encodeURIComponent(id)}/review`, { state, reviewNote }),
  setFeatured: (id, featuredRank) => jsonRequest('PATCH', `/api/admin/market/${encodeURIComponent(id)}`, { featuredRank }),
  /** admin 看图走公开那条（admin 对任何状态都放行） */
  imageUrl: (id, n = 0) => `/api/market/${encodeURIComponent(id)}/images/${n}`,
};
