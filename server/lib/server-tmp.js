/**
 * server/lib/server-tmp.js — 服务端自己的临时文件根（2026-09-17）
 *
 * 导出、整站打包、发布、docx 渲页、中继收图、生图 / 视频拉片这些服务端流程原来各自 mkdtemp 在 /tmp 根上
 * （nd-export-*、nd-publish-*、ndocx-* …），里面装着某个用户的产物与文档。托管版的 Bash 沙盒不能整个遮住 /tmp
 * （CLI 的出网代理 socket 在 /tmp 下、名字随机，遮了就断网，见 engine/agent/isolation.js），于是这些目录在存在期间
 * 别的用户的 agent 读得到。
 *
 * 做法：服务端的临时文件一律落在这个固定名字的根下，isolation.js 把它整个遮读。名字带 uid，同机不同用户不串。
 * 权限 0700 只挡同机其它系统用户；沙盒里的 agent 与服务端同 uid，挡它的是沙盒的遮读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';

export const SERVER_TMP_ROOT = path.join(path.resolve(os.tmpdir()), `nd-srv-${uid}`);

/** 建根（幂等）。系统清 /tmp 后下一次调用会重建 */
export function ensureServerTmpRoot() {
  fs.mkdirSync(SERVER_TMP_ROOT, { recursive: true, mode: 0o700 });
  return SERVER_TMP_ROOT;
}

/** fs.mkdtemp 的替身：目录建在私有根下 */
export async function makeServerTmpDir(prefix) {
  ensureServerTmpRoot();
  return fs.promises.mkdtemp(path.join(SERVER_TMP_ROOT, prefix));
}

/** 私有根下的一个文件路径（调用方自己负责写与删） */
export function serverTmpPath(name) {
  ensureServerTmpRoot();
  return path.join(SERVER_TMP_ROOT, name);
}
