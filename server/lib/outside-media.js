/**
 * outside-media.js —— 站点引用了自己目录之外、又不在 assets/ 下的素材时，打包把它带上（2026-09-18）
 *
 * 发布（site-publish）、工程包（handoff）、旧整站 zip（/exports/site）三条出口原来只认一种树外引用：
 * `(../)+assets/…`，整份拷 `assets/` 再按深度改前缀。站主 09-18 定「真搬文件」之后，生成图会被
 * 拖出 `assets/generated/` 摆到桌面或别的文件夹，站点里的引用随之改写成 `../hero.webp`、
 * `../素材/a.png` —— 这三条出口会把它静默丢掉，发布出去就是裂图。
 *
 * 这里把这类引用收进包里的 `assets/_ws/<工作区相对路径>`，并把页面里那一处引用改到包内位置。
 * 只收**素材扩展名**（图、视频、音频、字体）：`<a href="../别的站/x.html">` 这种树外页面不是
 * 本站的东西，收进来就是把别人的产物打包（asset-refs.js 头注第 6 条病）。
 */
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { rewriteRefsInText } from './rewrite-refs.js';

/** 算素材的扩展名（能被页面当资源加载、自己不是页面） */
export const MEDIA_EXT = /\.(png|jpe?g|webp|gif|avif|svg|ico|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|woff2?|ttf|otf)$/i;
/** 包内落点前缀（相对站点根） */
export const OUTSIDE_PREFIX = 'assets/_ws';

const dirOf = (rel) => (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));

/**
 * 改写一个页面里的树外素材引用，并报出要额外带进包的文件。
 *
 * @param {string} text
 * @param {object} p
 * @param {string} p.ext            文件扩展名（html / css / svg …，不带点）
 * @param {string} p.pageRel        页面的工作区相对路径
 * @param {string} p.siteRoot       站点根的工作区相对路径（'' = 工作区根，此时没有「树外」）
 * @param {string} p.root           工作区根（绝对路径）
 * @returns {{ text: string, files: Array<{ wsRel: string, bundleRel: string }> }}
 *   bundleRel 相对站点根（调用方按自己的包布局再加前缀）
 */
export function bundleOutsideMedia(text, { ext, pageRel, siteRoot, root }) {
  if (!siteRoot) return { text, files: [] };
  const files = new Map();
  const inside = (rel) => rel === siteRoot || rel.startsWith(`${siteRoot}/`);
  const resolveMove = (target) => {
    if (inside(target) || target.startsWith('assets/') || !MEDIA_EXT.test(target)) return null;
    const abs = path.join(root, ...target.split('/'));
    try { if (!existsSync(abs) || !statSync(abs).isFile()) return null; } catch { return null; }
    const bundleRel = `${OUTSIDE_PREFIX}/${target}`;
    files.set(target, bundleRel);
    return `${siteRoot}/${bundleRel}`;
  };
  const dir = dirOf(pageRel);
  const r = rewriteRefsInText(text, { ext, oldDir: dir, newDir: dir, resolveMove });
  return { text: r.text, files: [...files].map(([wsRel, bundleRel]) => ({ wsRel, bundleRel })) };
}
