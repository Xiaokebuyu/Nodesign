/**
 * server/lib/folder-claims.js —— 「一个目录在画布上是不是一张文件夹卡」的唯一判据
 * （2026-09-17 从 api/assets.js 的 collect 递归里原样收出，问题库 iss_mtp465ds_ctko）
 *
 * 病根：这条判据原来只住在 /artifacts 的扫描里，入座器（engine/runs/board-seater.js）给新文件
 * 的顶层目录建文件夹坐标时另写了一份，而且那份只排除保留目录 —— 站点目录（被 manifest 认领、
 * 前端画成一张站点卡）照样被建成 zones 条目。前端只画扫描清单里的文件夹，这个条目于是是一层
 * 看不见的文件夹；锚点解析又先查文件夹层，「X（site）」被认成了这层隐形的东西。
 * 现在两边都问这一份。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isDirArtifact, taskManifest } from './kinds/index.js';
import { RESERVED_DIRS, HARD_IGNORE_DIRS, DRAFTS_DIR, loadIgnore } from './task-scan.js';
import { OUTPUT_DIRS } from './kinds/site.js';

/**
 * 文件夹递归深度上限。
 *
 * 3 层是给用户的（prelude 里也是这么跟 agent 说的："层级别超过两三层"）——
 * 再深就得点进去好几下才看得见东西，桌面这个隐喻本身就失效了。这不是防御性
 * 的深度限制，构建目录 / node_modules 那类由 RESERVED_DIRS + HARD_IGNORE_DIRS
 * 挡在外面，跟深度无关。
 */
export const FOLDER_MAX_DEPTH = 3;

/**
 * 一个目录的 manifest 已经认领了哪些子目录（认领了 = 它是产物，不是容器）。
 *
 * 一个站点目录既能被父目录扫成一件产物（`site:伊蕾娜手账研究站`），又能被
 * 当成一个文件夹递归进去 —— 不去重的话它在桌面上出现两次：一张站点卡 +
 * 一张同名文件夹卡，点哪个都对一半。认领了就跳过：里面的 `assets/` `pages/`
 * 是这个站的内部结构，不是并列的文件夹。
 *
 * @param {Array} list  taskManifest().artifacts（路径相对这个目录）
 * @returns {Set<string>} 被认领的子目录名（单段）
 */
export function claimedSubdirs(list) {
  const claimed = new Set();
  for (const a of list || []) {
    for (const p of [a.root, a.srcRoot, a.file, a.entryRel]) {
      const seg = String(p || '').split('/')[0];
      if (seg && seg !== p) claimed.add(seg);       // 只有带下级路径的才算认领
      else if (seg && isDirArtifact(a)) claimed.add(seg);   // 顶层段整段认领：只有目录型产物有资格（判据问注册表）
    }
    // 根站（root='' srcRoot=''）：上面四个字段全切不出认领段，可它的 pages
    // 跨着子目录（'posts/chapter-1.html'）。那些子目录是站点内部结构，不是
    // 并列容器 —— 不认领的话它们会被递归成独立任务、页面被 deck 解析器
    // 再收编一遍，同一份文件在桌面上出现两个身份（站点页 + deck 卡），
    // 而且卡还打不开（实测 proj_mss59y9l_8ems，2026-08-14）。
    // 只在根站场景做：非根站的 root 目录本身已被认领，内部结构扫不到。
    if (a.kind === 'site' && !a.single && !a.root && !a.srcRoot) {
      for (const pg of (a.pages || [])) {
        const seg = String(pg).split('/')[0];
        if (seg && seg !== pg) claimed.add(seg);
      }
    }
  }
  return claimed;
}

/**
 * 只看名字的那几条：隐藏 / 保留目录 / 硬忽略 / 站点试作 / 构建目录 / 根 .ndignore。
 * @param {string} name     目录名（单段）
 * @param {string} relPath  工作区相对路径（给 .ndignore 匹配用）
 * @param {Function} [ignore]  loadIgnore(工作区根) 的返回值
 */
export function folderNameAllowed(name, relPath, ignore = null) {
  if (!name || name.startsWith('.')) return false;
  if (RESERVED_DIRS.has(name) || HARD_IGNORE_DIRS.has(name)) return false;
  if (name === DRAFTS_DIR) return false;      // 站点试作，由 site 解析器管
  // 构建目录不当独立站/收纳夹（site:dist 案）；递归也吃根 .ndignore（与页面清单同规则）
  if (OUTPUT_DIRS.includes(name) || ignore?.(relPath, true)) return false;
  return true;
}

/**
 * 工作区相对路径 rel 在画布上是不是一张文件夹卡 —— 跟 /artifacts 的 collect 递归逐层同判
 * （名字规则 + 父目录 manifest 的认领 + 深度上限 + 真是目录）。
 */
export async function isCanvasFolder(workspaceRoot, rel, { ignore = null } = {}) {
  const segs = String(rel || '').split('/').filter(Boolean);
  if (!segs.length || segs.length > FOLDER_MAX_DEPTH || segs.includes('..')) return false;
  try { if (!(await fs.stat(path.join(workspaceRoot, ...segs))).isDirectory()) return false; } catch { return false; }
  const ig = ignore || await loadIgnore(workspaceRoot);
  for (let i = 0; i < segs.length; i += 1) {
    const relPath = segs.slice(0, i + 1).join('/');
    if (!folderNameAllowed(segs[i], relPath, ig)) return false;
    let manifest = null;
    try { manifest = await taskManifest(path.join(workspaceRoot, ...segs.slice(0, i))); } catch { manifest = null; }
    if (claimedSubdirs(manifest?.artifacts).has(segs[i])) return false;
  }
  return true;
}
