/**
 * lib/user-uploads.js —— 用户上传件的落点与增删查（2026-08-28）
 *
 * ## 为什么单独挪出来
 *
 * 以前上传一律落 `shared/assets/`，而 `assets/` 在画布的文件夹清单里是**基础设施
 * 目录**（RESERVED_DIRS / NOT_A_FOLDER），于是每个上传件都 homeOf 到根 —— 用户拖
 * 一张参考图进来，它就直接摊在桌面上跟产物混作一堆。用户原话：「有一件事很膈应」。
 *
 * ## 修法：给它一个真目录，不是在画布上造一个虚拟分组
 *
 * 文件夹在这套体系里从来就等于磁盘上的真目录（见 api/assets.js 的收纳文件夹注释）。
 * 凭空多一种只存在于画布上的分组，「文件系统即真相」这条就破了。真目录还白拿了
 * 整套现成能力：文件夹卡、拖进拖出、改名、MoveTo、agent 的 mv。
 *
 * ⚠️ 老项目 `assets/` 里已有的上传件**不迁**：物件 id 就是路径，搬家等于改 id，
 * 得连 board.json 绑定一起转发。它们照旧扫成 upload 摊在根上 —— 所以这里的列举和
 * 删除都**两个落点都认**，新的优先。
 */

import fs from 'fs/promises';
import path from 'path';

/** 上传落点（工作区相对）。画布上就显示成这个名字的文件夹 */
export const USER_UPLOAD_DIR = '用户内容';

/** 两个落点，新的在前 —— 列举顺序、删除尝试顺序都按它 */
const LOOKUP_DIRS = [USER_UPLOAD_DIR, 'assets'];

/** 上传写到哪（不存在就建） */
export async function ensureUploadDir(sharedRoot) {
  const dir = path.join(sharedRoot, USER_UPLOAD_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** agent / 前端拿到的引用路径。cwd 是 sessions/<sid>/，所以 `../../shared/<dir>/<name>` */
export function uploadRefPath(dirRel, filename) {
  return `../../shared/${dirRel}/${filename}`;
}

/**
 * 列两个落点下的上传件（只看顶层文件，子目录归画布的文件夹机制管）。
 * @returns {Promise<Array<{path, name, dir, size, mtime}>>} 按 mtime 新→旧
 */
export async function listUploadedAssets(sharedRoot) {
  const out = [];
  for (const dirRel of LOOKUP_DIRS) {
    let entries;
    try {
      entries = await fs.readdir(path.join(sharedRoot, dirRel), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      let stat;
      try { stat = await fs.stat(path.join(sharedRoot, dirRel, e.name)); } catch { continue; }
      out.push({
        path: uploadRefPath(dirRel, e.name), name: e.name, dir: dirRel,
        size: stat.size, mtime: stat.mtime.toISOString(),
      });
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

/**
 * 删一个上传件。两个落点依次试，**每个目录各自 resolve 复核**（别拿一个目录的
 * 判据去删另一个目录的文件）。
 * @returns {Promise<'deleted'|'not_found'|'invalid'>}
 */
export async function deleteUploadedAsset(sharedRoot, filename) {
  for (const dirRel of LOOKUP_DIRS) {
    const dirAbs = path.join(sharedRoot, dirRel);
    const filePath = path.resolve(dirAbs, filename);
    if (!filePath.startsWith(dirAbs + path.sep)) return 'invalid';
    try {
      await fs.unlink(filePath);
      return 'deleted';
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return 'not_found';
}
