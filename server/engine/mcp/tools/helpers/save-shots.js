/**
 * helpers/save-shots.js — screenshot_canvas 的 saveTo：把本次渲出的 docx 页图写进工作区（09-17，问题库 iss_mt9n6bm2_nthg）
 *
 * 为什么：screenshot_canvas 对 .docx 会渲页图给 agent 看，但页图只进了上下文、落不了盘，agent 交不出去
 * （用户侧有 docx 导出 PDF，agent 侧没有）。现在渲一次、看和存共用同一批 PNG，不另起一轮渲染。
 *
 * 路径判据全部复用现有实现，不另写一套：
 *   - 词法 + 保留目录：lib/safe-path.js 的 guardRel（删除类路由同一份）；
 *   - 软链穿透：逐级 safeResolveWrite（该级不是软链、父目录 realpath 在工作区内）之后才 mkdir；
 *   - 在它们之前再拒三类 guardRel 放行、但落盘时不该放行的：绝对路径（哪怕指向工作区内）、任何一段是 `..`、
 *     任何一段以 `.` 开头（guardRel 只管顶层；`站点/.git` 这类隐藏目录里的文件画布不显示、交付也跳过），
 *     以及 task-scan 的硬忽略目录（node_modules / venv …，同理不显示）。
 * 写入前问 project-gone（用户删了项目、回合还在跑时不许把工作区长回来），逐个文件原子写（读者不会读到半张图）。
 * MCP 工具写盘不走 PostToolUse(Write|Edit) 的 file_changed 直发，这里自己发，卡片当场出现（generate_image 同款）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { guardRel, safeResolveWrite } from '../../../../lib/safe-path.js';
import { HARD_IGNORE_DIRS } from '../../../../lib/task-scan.js';
import { writeFileAtomic } from '../../../../lib/atomic-write.js';
import { isProjectGone, projectGoneMessage, projectIdOfPath } from '../../../../projects/project-gone.js';
import { Events } from '../../../agent/events.js';

const EXAMPLE = 'use a workspace-relative folder such as "交付/简历页图"';

/**
 * saveTo 的词法判定，不碰磁盘（渲染之前先判，别白渲一轮）。
 * @returns {{ok:true, rel:string} | {ok:false, message:string}}
 */
export function checkSaveDir(workspaceRoot, raw) {
  const bad = (why) => ({ ok: false, message: `saveTo rejected: ${why} (got "${raw}") — ${EXAMPLE}.` });
  const s = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!s) return bad('empty path');
  if (path.posix.isAbsolute(s) || path.win32.isAbsolute(s) || /^[a-zA-Z]:/.test(s)) return bad('absolute paths are not accepted');
  const segs = s.replace(/^(\.\/)+/, '').split('/').filter(Boolean);
  if (!segs.length) return bad('that is the workspace root; name a folder inside it');
  if (segs.includes('..')) return bad('".." is not allowed');
  const hidden = segs.find((x) => x.startsWith('.'));
  if (hidden) return bad(`"${hidden}" starts with "." — hidden/system folders (.claude, .nd, .git …) are off limits`);
  const ignored = segs.find((x) => HARD_IGNORE_DIRS.has(x));
  if (ignored) return bad(`"${ignored}" is a dependency/cache folder that the canvas and delivery skip`);
  const rel = segs.join('/');
  const why = guardRel(rel, path.resolve(workspaceRoot));
  if (why === 'reserved directory') {
    return bad(`"${segs[0]}" is a reserved folder (assets / exports / notes / node_modules / agent-memory hold system files)`);
  }
  if (why) return bad(why);
  return { ok: true, rel };
}

/** 逐级建目录，每一级先过 safeResolveWrite。返回错误原因或 null */
async function ensureDirInside(root, rel) {
  const segs = rel.split('/');
  for (let i = 1; i <= segs.length; i += 1) {
    const part = segs.slice(0, i).join('/');
    const abs = await safeResolveWrite(root, part);
    if (!abs) return `"${part}" resolves outside the workspace (a symlink on the way is not followed)`;
    try { await fs.mkdir(abs); } catch (err) { if (err?.code !== 'EEXIST') throw err; }
    if (!(await fs.lstat(abs)).isDirectory()) return `"${part}" exists and is not a folder`;
  }
  return null;
}

/** docx 页图的文件名：<文档名>-第N页.png；页码按总页数补零（pdftoppm 同一个办法），字典序即页序 */
export function pageImageName(docBase, page, width = 1) {
  return `${docBase}-第${String(page).padStart(width, '0')}页.png`;
}

/**
 * @param {object} o
 * @param {string} o.workspaceRoot
 * @param {string} [o.projectId]
 * @param {string} o.dirRel                         checkSaveDir 通过的相对目录
 * @param {Array<{name:string, file:string}>} o.items   文件名 + 渲染出来的临时文件
 * @param {object} [o.ctx]                          有 emit 就发 file_changed
 * @returns {Promise<{ok:true, saved:string[], overwritten:string[]} | {ok:false, message:string}>}
 */
export async function saveShotFiles({ workspaceRoot, projectId, dirRel, items, ctx }) {
  const root = path.resolve(workspaceRoot);
  const pid = projectId || projectIdOfPath(root);
  if (pid && isProjectGone(pid)) return { ok: false, message: projectGoneMessage(pid) };
  const saved = [];
  const overwritten = [];
  try {
    const dirProblem = await ensureDirInside(root, dirRel);
    if (dirProblem) return { ok: false, message: `saveTo rejected: ${dirProblem}.`, saved };
    for (const it of items) {
      const rel = `${dirRel}/${it.name}`;
      const abs = await safeResolveWrite(root, rel);
      if (!abs) return { ok: false, message: `saveTo rejected: ${rel} is a symlink or resolves outside the workspace; nothing more was written.`, saved };
      const existed = await fs.lstat(abs).then(() => true, () => false);
      await writeFileAtomic(abs, await fs.readFile(it.file));
      saved.push(rel);
      if (existed) overwritten.push(rel);
      try { ctx?.emit?.(Events.fileChanged(rel, existed ? 'change' : 'add')); } catch { /* 发不出去不挡落盘 */ }
    }
  } catch (err) {
    // 磁盘错误（权限 / 空间）如实报，不让整次调用变成未处理异常
    return { ok: false, message: `saveTo failed while writing: ${err?.message || err}`, saved };
  }
  return { ok: true, saved, overwritten };
}

/** 落盘结果 → caption 行 */
export function saveLines(r, dirRel) {
  const lines = [`saved ${r.saved.length} page image(s) to ${dirRel}/: ${r.saved.join(', ')}`];
  if (r.overwritten.length) lines.push(`overwrote existing file(s): ${r.overwritten.join(', ')}`);
  lines.push(`They appear on the canvas inside the folder "${dirRel}" — keep page images in a folder of their own `
    + 'rather than next to other work. To hand them over, deliver_files with that folder (delivered as one zip).');
  return lines;
}
