/**
 * move-entry.js —— 「把一个东西搬到另一个文件夹」的唯一实现（2026-08-14 抽出）。
 *
 * 之前它整个住在 `POST /:pid/move` 的路由体里。agent 的整理工具
 * （organize_board）要同一套语义 —— 按单一真相源纪律抽成一份，两个调用方
 * （用户拖拽 / agent 归纳）共用，别长出第二套"怎么算搬得动"。
 *
 * 语义（见原路由注释，搬运时一字未改）：
 *   ① fs.rename 先动磁盘，失败画布一个字节不改
 *   ② renameBoardPaths 同一步改画布身份（物件/文件夹/归属/关系线端点）+ 转发表
 *   ③ 调用方拿到新 board（前端要用它重写 layoutRef）
 *   ④ commit 交给调用方（路由在响应后 commit；agent 工具每轮本来就落 commit）
 *
 * 09-18 补上后半件（lib/move-follow.js，站主定「画布位置变动代表文件变动」）：
 *   伴随件（png/webp 另一半、.meta、grounding、缩略）跟主文件一起搬；全工作区的引用与板书锚点
 *   改到新路径。三个调用方（拖卡 / organize_board / pin_to_board）以前只有 organize_board 改引用。
 *   批量调用方传 `follow:false`，自己攒齐 moves 之后调一次 followMoves（省得每件扫一遍工作区）。
 *
 * 失败用 MoveError 抛（带 status），路由映射成 http 状态码，工具映射成文案。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getSharedDir } from './workspace.js';
import { renameBoardPaths, readBoard, patchBoard } from './board-store.js';
import { GENERATED_DIR } from '../lib/generated-folder.js';
import { taskManifest, KIND_SITE } from '../lib/artifact-target.js';
import { RESERVED_DIRS } from '../lib/task-scan.js';
import { CHALK_DIR } from '../lib/chalk.js';
import { moveCompanions, followMoves } from '../lib/move-follow.js';

/** 能放回「生成图」文件夹的：图与视频（跟画布扫描的 IMAGE/VIDEO 两类对齐） */
const MEDIA_RE = /\.(png|webp|jpe?g|gif|avif|mp4|webm|mov)$/i;

export class MoveError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * 哪些东西不许搬走：真·基础设施。
 * `assets/` 2026-08-13 放开；`notes/` 2026-08-14 用户拍板放开 —— 便签也参与
 * 归纳。搬出 notes/ 的 .md **明码换形态**（便签卡 → 阅读器文件卡，失去分面
 * 翻页），这是桌面语义的自然结果不是事故；搬回 notes/ 仍被目标目录守卫挡着
 *（RESERVED_DIRS），"升格回便签"要做的话单独开闸。
 */
const NO_MOVE_OUT = new Set(['exports', 'node_modules', 'agent-memory']);

/**
 * @param {string} pid
 * @param {string} fromRaw  工作区相对路径（文件或文件夹）
 * @param {string} toRaw    目标文件夹（'' = 工作区根）
 * @param {object} [opts]   { createFolder: 目标夹不存在就 mkdir（agent 归纳常配新夹）；
 *                          follow: 搬完顺手改引用（默认 true）}
 * @returns {Promise<{ok:true, from:string, to:string, moved:boolean, board?:object,
 *   moves?: Array<{from,to}>, follow?: object|null, followError?: string}>}
 *   moves 含伴随件；follow 是引用改写的结果（follow:false 时为 null）
 */
export async function moveEntry(pid, fromRaw, toRaw, { createFolder = false, follow = true } = {}) {
  const root = getSharedDir(pid);
  const from = norm(fromRaw);
  const to = norm(toRaw);
  if (!from) throw new MoveError(400, 'from required');

  const absFrom = path.resolve(root, from);
  const absToDir = to ? path.resolve(root, to) : root;
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  if (!inside(absFrom) || absFrom === root || !inside(absToDir)) {
    throw new MoveError(400, 'path escapes workspace');
  }
  const guardSeg = (rel) => rel.split('/')[0];
  if (NO_MOVE_OUT.has(guardSeg(from)) || guardSeg(from).startsWith('.')) {
    throw new MoveError(400, '这个位置的东西不参与搬家');
  }
  // 板书不参与搬家（08-24，上报 iss_mt5qujy1）：它是画布上的**话**，不是文件产物。
  // 拖拽误触把它挪出 notes/板书/ 会丢 chalk 身份渲染成普通细条卡，且没有正规
  // 归位通道。搬出一律拒；搬回（下面目标守卫的例外）留给误逃文件的恢复。
  if (from === CHALK_DIR || from.startsWith(`${CHALK_DIR}/`)) {
    throw new MoveError(400, '板书是画布上的话，不参与搬家');
  }
  // 生成图文件夹本身不搬（09-18）：它是生图产线的落点，搬走了下一张图又会在原处长出一个
  if (from === GENERATED_DIR) throw new MoveError(400, '「生成图」文件夹是生成图的落点，不参与搬家');
  if (to && (RESERVED_DIRS.has(guardSeg(to)) || guardSeg(to).startsWith('.'))) {
    // 例外一：把误逃的 .md 送**回**板书目录（恢复通道；organize_board 同享。
    // 不限根层 —— groupInto 误触会把板书埋进"新建文件夹/"里，也得捞得回来）
    const isChalkReturn = to === CHALK_DIR && /\.md$/i.test(from);
    // 例外二（09-18）：图和视频可以放回「生成图」文件夹
    const isGeneratedReturn = to === GENERATED_DIR && MEDIA_RE.test(from);
    if (!isChalkReturn && !isGeneratedReturn) throw new MoveError(400, to === GENERATED_DIR ? '「生成图」文件夹只收图和视频' : '不能搬进这个目录');
  }
  // 搬进自己肚子里（文件夹拖到它自己的子文件夹上）—— fs.rename 会报
  // EINVAL，但那时目录树已经没法自洽了，提前拦住
  if (to === from || to.startsWith(from + '/')) {
    throw new MoveError(400, '不能把文件夹搬进它自己里面');
  }

  const srcStat = await fs.stat(absFrom).catch(() => null);
  if (!srcStat) throw new MoveError(404, 'source not found');
  let dirStat = await fs.stat(absToDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    if (!createFolder || !to) throw new MoveError(404, 'target folder not found');
    await fs.mkdir(absToDir, { recursive: true });
    dirStat = await fs.stat(absToDir);
  }

  // 目标目录**本身是一件产物**（整站）时不许搬进去：它的内部结构由
  // 形态解析器管，塞进去的东西会从产物枚举里彻底消失（既不是页面也不是卡）。
  // 站点收素材的正路是它的 assets/ 子目录（那一层不是产物根，照常放行）。
  if (to) {
    const m = await taskManifest(absToDir);
    const opaque = (m?.artifacts || []).some(
      a => a.kind === KIND_SITE && !a.single && !a.root);
    if (opaque) throw new MoveError(400, '这是一件产物，不是收纳文件夹（站点收素材放它的 assets/ 子目录）');
  }

  const base = path.basename(from);
  const nextRel = to ? `${to}/${base}` : base;
  if (nextRel === from) {
    // 旧板桌面上的生成图拖进「生成图」文件夹卡：文件本来就在这儿，清掉 desk 标记它就归进文件夹（09-18）
    if (to === GENERATED_DIR) {
      const cur = await readBoard(pid);
      if (cur.objects?.[from]?.desk) {
        const board = await patchBoard(pid, { objects: { [from]: { desk: false } } });
        return { ok: true, from, to: from, moved: false, filed: true, board };
      }
    }
    return { ok: true, from, to: from, moved: false };
  }
  if (await exists(path.resolve(root, nextRel))) {
    throw new MoveError(409, `「${base}」在那儿已经有一个了`);
  }

  await fs.rename(absFrom, path.resolve(root, nextRel));                    // ①
  const extra = srcStat.isFile() ? (await moveCompanions(root, from, nextRel)).moves : [];
  const moves = [{ from, to: nextRel }, ...extra];
  let { board } = await renameBoardPaths(pid, moves.map((m) => [m.from, m.to]));   // ②
  // desk 只对「留在桌面的旧生成图」有意义：搬过一次就不再是旧板存量，标记跟着清（09-18）
  if (board?.objects?.[nextRel]?.desk) board = await patchBoard(pid, { objects: { [nextRel]: { desk: false } } });
  let followed = null; let followError;
  if (follow) {
    try { followed = await followMoves(root, moves); } catch (err) { followError = err?.message || String(err); }
  }
  return { ok: true, from, to: nextRel, moved: true, board, moves, follow: followed, ...(followError ? { followError } : {}) };   // ③
}
