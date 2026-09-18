/**
 * generated-folder.js —— 生成图住进「生成图」文件夹（2026-09-18，站主定）
 *
 * ## 为什么
 *
 * 画布乱的第二个源头是散落的图：生图产线每出一张就往桌面上摊一张。站主 09-17 定「生成的图默认
 * 进文件夹，agent 要用哪张再 pin 出来」，09-18 补定「真搬文件，以后都这样，画布位置变动代表
 * 文件变动」。
 *
 * ## 为什么是 `assets/generated/` 本身，不是根上另建一个 `生成图/`
 *
 * 图在磁盘上一直就住在 `assets/generated/`，桌面上摊着反而是「画布说在桌面、磁盘说在文件夹」。
 * 把这个目录直接显示成文件夹卡，画布就对上了磁盘，生成路径一行不改。另建目录的话，站点里的
 * `assets/generated/…` 引用、导出与发布只认 `assets/` 的老路、缩略图与 .meta 的读取口、提示词里
 * 教 agent 的写法，四十来处要跟着改，而最常见的「生成 → 站点引用 → 发布」这条路会先断。
 *
 * ## 旧板不迁移
 *
 * 09-18 之前就摆在桌面上的生成图，第一次打开时打上 `desk: true`，留在桌面（跟 08-28 上传件
 * 「老项目 assets/ 里已有的不迁」同一个口径）。这是唯一一处画布与磁盘不一致，只给存量。
 * 用户把它拖进「生成图」文件夹卡，标记就清掉（moveEntry）。
 *
 * ⚠️ 前端 web/src/lib/generated-folder.js 是同一份事实的镜像（两个常量 + 一个判据），
 * generated-folder.test.js 逐字比对。
 */

export const GENERATED_DIR = 'assets/generated';
export const GENERATED_TITLE = '生成图';

/** 旧板留在桌面上的那几张（只认生成图目录里的文件，别的路径带着 desk 也不算） */
export function isDeskPinned(id, entry) {
  return !!entry?.desk && String(id).startsWith(`${GENERATED_DIR}/`);
}

/** 这个工作区相对路径是不是生成图文件夹里的一件（直接子级） */
export function inGeneratedDir(rel) {
  const s = String(rel || '');
  return s.startsWith(`${GENERATED_DIR}/`) && !s.slice(GENERATED_DIR.length + 1).includes('/');
}
