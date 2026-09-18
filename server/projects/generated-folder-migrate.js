/**
 * generated-folder-migrate.js —— 生成图文件夹的存量迁移（2026-09-18）
 *
 * 判据与常量在 lib/generated-folder.js（纯模块，canvas-id 也要 import，不能带 board-store）。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBoard, patchBoard } from './board-store.js';
import { getSharedDir } from './workspace.js';
import { inGeneratedDir } from '../lib/generated-folder.js';

/** 迁移做过的记号：住工作区的 .nd/（私档，不进 git、不上画布），不往 board.json 加顶层字段 */
const DONE_MARK = path.join('.nd', 'gen-folder-migrated');

/**
 * 存量迁移（幂等，一个工作区只跑一次）：板上已有条目的生成图打上 desk。
 * 条目一律带坐标（board-sanitize 缺省补 0），「有条目」就等于「已经摆在桌面上」；
 * 没条目的（还在待摆队列里的）不算存量，归进文件夹。
 * @returns {Promise<number>} 这次标了几件（0 = 早迁过或没有）
 */
export async function ensureGeneratedFolder(pid) {
  const mark = path.join(getSharedDir(pid), DONE_MARK);
  try { await fs.access(mark); return 0; } catch { /* 没迁过 */ }
  const board = await readBoard(pid);
  const objects = {};
  for (const [id, e] of Object.entries(board.objects || {})) {
    if (inGeneratedDir(id) && !e?.desk) objects[id] = { desk: true };
  }
  if (Object.keys(objects).length) await patchBoard(pid, { objects });
  await fs.mkdir(path.dirname(mark), { recursive: true });
  await fs.writeFile(mark, `${new Date().toISOString()} ${Object.keys(objects).length}\n`);
  return Object.keys(objects).length;
}
