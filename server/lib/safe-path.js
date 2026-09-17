/**
 * lib/safe-path.js — 工作区内路径的越界检查。
 *
 * ⚠️ **词法检查不够。** `path.resolve` + `path.relative` 挡得住 `../..`，
 * 挡不住工作区里一个**指向外面的软链** —— 那条路径逐字看都在工作区内，
 * 解引用之后在 `/etc` 或者 `.env` 上。
 *
 * 这个洞在这个仓库里已经出现过两次形状相同的实例（导出收集器、docx 页图路由），
 * 第二次是照着第一次的**调用形状**抄的、没抄它的**正确性**。所以判据收成一份：
 * 谁要在工作区里按用户给的相对路径开文件，就 import 这里，别再各写一遍。
 *
 * 读和写的判据不一样，分两个函数：
 *   - 读：目标必须存在，realpath 之后仍在工作区内
 *   - 写：目标可能还不存在（正要创建），所以查**父目录**的 realpath；
 *     另外目标自己若已经是软链，一律拒 —— 顺着它写等于把别人的文件覆盖掉
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RESERVED_DIRS } from './task-scan.js';

/**
 * 按用户/agent 给的相对路径动工作区时共用的三道词法闸（越界 / 保留目录 / `.` 打头的顶层目录）。
 *
 * 09-08 在 api/assets/entries.js 立（删除类路由），09-17 挪到这里：screenshot_canvas 的
 * saveTo（问题库 iss_mt9n6bm2_nthg）也要按同一份判据落盘，引擎侧不该为此 import api 层。
 * entries.js 从这里引用，行为不变。
 *
 * ⚠️ 第三道（`.` 打头的顶层目录）原来只有 `/rename` 和 `POST /folders` 查了，
 * `DELETE /folders` **漏了** —— 于是 `DELETE /folders/.git` 能一路走到 `fs.rm`。
 * 抄守卫要抄正确性不是抄形状，所以合成一份，调用点共用。
 * 只管词法；软链穿透另走下面的 safeResolveRead / safeResolveWrite。
 *
 * @param {string} rel   工作区相对路径（正斜杠）
 * @param {string} root  工作区根（已 resolve）
 * @returns {string|null} 出错原因；`null` = 放行
 */
export function guardRel(rel, root) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return 'path escapes workspace';
  // ⛔ 09-08 评审：拿**归一化之后**的相对路径逐段查，不拿原始入参的第一段。原写法只看 `rel.split('/')[0]`，
  //   而 Express 只归一化字面的 `..`，编码斜杠不归一 —— `DELETE /folders/a%2f..%2f.git` 到这里 rel='a/../.git'，
  //   seg0='a' 放行、abs 却是 <root>/.git，直接进 fs.rm。归一化后 relN='.git'，每一段都查一遍。
  const relN = path.relative(root, abs).split(path.sep);
  if (!relN.length || !relN[0]) return 'path escapes workspace';
  if (relN.includes('..')) return 'path escapes workspace';
  if (RESERVED_DIRS.has(relN[0]) || relN[0].startsWith('.')) return 'reserved directory';
  return null;
}

/** 词法层：拼出绝对路径并确认字面上没跑出去。跑出去返回 null */
function lexical(rootAbs, rel) {
  const abs = path.resolve(rootAbs, String(rel || ''));
  const within = path.relative(rootAbs, abs);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  return abs;
}

/**
 * 读用：解析一个工作区内的相对路径。
 * @returns {Promise<string|null>} 绝对路径；越界（含软链穿透）返回 null
 *   目标不存在**不算越界** —— 让调用方自己去 stat 报 404，这里只管边界
 */
export async function safeResolveRead(workspaceRoot, rel) {
  const abs = lexical(path.resolve(workspaceRoot), rel);
  if (!abs) return null;
  try {
    const realRoot = await fs.realpath(workspaceRoot);
    const real = await fs.realpath(abs);
    const rw = path.relative(realRoot, real);
    if (rw.startsWith('..') || path.isAbsolute(rw)) return null;
  } catch (err) {
    // ENOENT：文件还没写出来，边界上没问题，留给调用方 stat
    if (err?.code !== 'ENOENT') return null;
  }
  return abs;
}

/**
 * 写用：解析一个工作区内的写入目标。
 * @returns {Promise<string|null>} 绝对路径；越界 / 目标是软链 返回 null
 */
export async function safeResolveWrite(workspaceRoot, rel) {
  const abs = lexical(path.resolve(workspaceRoot), rel);
  if (!abs) return null;
  try {
    const realRoot = await fs.realpath(workspaceRoot);
    // 目标本身若已存在且是软链 → 拒。顺着它写会覆盖软链指向的那个文件，
    // 而那个文件可以在工作区外（lstat 不解引用，这是判据的关键）
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) return null;
    } catch (err) {
      if (err?.code !== 'ENOENT') return null;   // 目标还不存在是正常的
    }
    // 父目录必须真的在工作区内（父目录是软链的话，新建的文件会落到外面）
    const realParent = await fs.realpath(path.dirname(abs));
    const rw = path.relative(realRoot, realParent);
    if (rw.startsWith('..') || path.isAbsolute(rw)) return null;
  } catch {
    return null;   // 父目录都解析不了，不给写
  }
  return abs;
}
