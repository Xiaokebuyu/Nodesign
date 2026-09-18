/**
 * generated-folder.js —— 生成图住进「生成图」文件夹（2026-09-18）
 *
 * 服务端 server/lib/generated-folder.js 的镜像（理由、旧板 desk 标记的来历都写在那边）。
 * 两个常量和判据逐字一致，server/lib/generated-folder.test.js 比对。
 */

export const GENERATED_DIR = 'assets/generated';
export const GENERATED_TITLE = '生成图';

/** 旧板留在桌面上的那几张（只认生成图目录里的文件，别的路径带着 desk 也不算） */
export function isDeskPinned(id, entry) {
  return !!entry?.desk && String(id).startsWith(`${GENERATED_DIR}/`);
}
