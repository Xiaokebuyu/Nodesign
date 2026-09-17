/**
 * 画布远景缩略图的地址（09-17，问题库 iss_mu0v5pa5_3ojg）。
 *
 * 服务端 `GET /api/projects/:pid/artifact-thumb`（server/api/assets/artifact-thumb.js）按源签名
 * 缓存截图、回 ETag；`v` 只用来换 src —— 同一个地址 React 不会重新拉，agent 改了产物、前端的
 * 文件版本号变了，这里的地址才变。服务端不读 `v`。
 *
 * 单开文件是因为 lib/api.js 已经顶在行数棘轮的 600 上。
 *
 * @param {string} pid
 * @param {string} relPath  产物入口 html，相对工作区根
 * @param {{ kind: 'deck'|'site', v?: number }} opts
 */
export function artifactThumbUrl(pid, relPath, { kind, v } = {}) {
  const q = new URLSearchParams({ path: String(relPath || ''), kind: String(kind || '') });
  if (v) q.set('v', String(v));
  return `/api/projects/${encodeURIComponent(String(pid || ''))}/artifact-thumb?${q}`;
}
