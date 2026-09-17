/**
 * assets/artifact-thumb.js — `GET /:pid/artifact-thumb?path=&kind=&v=` 的处理器（09-17，问题库 iss_mu0v5pa5_3ojg）
 *
 * 画布拉远时站点 / deck 卡上显示的那张服务端截图。生成、缓存、失效、限流都在 lib/artifact-thumb.js；
 * 这里只管 HTTP 这一层。单开文件的理由同 docx-page.js（assets.js 压在行数棘轮上，依赖注入不绕环）。
 *
 * 缓存头：
 *   - 进门先设 no-store，错误路径全带着它（artifact-file 路由 2026-07-29 那次：CF 会把没写缓存头的
 *     错误响应按后缀缓存几小时）。这条路径没有扩展名，CF 本来按动态处理，这里仍照同一规矩写。
 *   - 成功与 304 回 `private, max-age=60` + ETag（同 /cover 与 /docx-page）。ETag 带源签名，
 *     文件一改就换；前端地址上的 `v` 只用来换 src，服务端不读它。
 *   - 204 = 此刻没有图（截图失败 / 请求方已走），前端的 <img> 走 onError 退回图标占位。
 */

import { thumbService } from '../../lib/artifact-thumb.js';

const OK_CACHE = 'private, max-age=60';

export function makeArtifactThumbHandler({ getSharedDir, guardProject, thumbs = thumbService }) {
  return async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!guardProject(req, res)) return;
      // 镜头拉回、卡移出视口时浏览器会掐掉这次请求：排队中的截图据此跳过（见 lib 头注第 4 条）
      let gone = false;
      res.on('close', () => { if (!res.writableFinished) gone = true; });
      const out = await thumbs.get({
        pid: req.params.pid,
        sharedDir: getSharedDir(req.params.pid),
        relPath: req.query.path,
        kind: String(req.query.kind || ''),
        ifNoneMatch: req.headers['if-none-match'],
        isGone: () => gone,
      });
      if (out.status === 304 || out.status === 200) {
        res.setHeader('ETag', `"${out.etag}"`);
        res.setHeader('Cache-Control', OK_CACHE);
        if (out.status === 304) return res.status(304).end();
        return res.type('image/webp').send(out.buffer);
      }
      if (out.status === 204) return res.status(204).end();
      return res.status(out.status).json({ error: out.error });
    } catch (err) { next(err); }
  };
}
