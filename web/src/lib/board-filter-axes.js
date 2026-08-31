/**
 * board-filter-axes.js —— 画布过滤的两条轴（2026-08-31 从 board-kinds 拆出，行数棘轮）
 *
 * 拆出来的理由不只是行数：board-kinds 回答的是「这是什么形态、它长什么样、能做什么」，
 * 而这里回答的是「此刻要不要把它画出来」。前者是表，后者是按表挑人，两件事。
 * 消费者只有画布和那颗漏斗（components/canvas/board-filter.jsx）。
 *
 * 桌面过滤的**两条轴**（2026-08-18 用户定的："产物和来源叠加"）。
 *
 * ## 为什么是两条，而不是一张大清单
 *
 * 「这东西是什么」和「谁弄出来的」是两个互不包含的问题。一张站点卡可能是 agent
 * 写的，也可能是用户传上来的一整包；一张图可能是他自己拍的、生图产线画的、
 * 或者工具从参照站采回来的。压成一条轴就得列 `agent的站点 / 用户的站点 / …`
 * 这种笛卡尔积 —— 加一种形态就翻一倍。**两条独立的轴各自过滤、结果取交集**，
 * 加形态只需要在一条轴上表态。
 *
 * ## 内容轴（`category`，写在形态表上）
 *
 * - `work`     产物：agent 做出来交付的东西（deck / 站点 / word）
 * - `material` 素材：图、视频、便签、散文件 —— 用来做产物的原料
 * - `tool`     **工具卡**：既装着工具采集到的内容，本身又能点进去交互（浏览器）
 * - `ink`      画布上的笔迹：涂鸦、手写字（只给自己看，agent 读不到）
 * - `doc`      项目文档（记忆 / 品牌）的画布分身
 *
 * ## 来源轴（`sourceOf(o)`，从物件本身判，不写在形态表上）
 *
 * 它**不能**写在形态表里：同一种形态可以有不同来源（一张图可以是上传的也可以是
 * 生图产线画的）。所以按物件的实际出处判。
 *
 * - `user` 用户自己放进来的（上传）
 * - `tool` 工具产出/采集的（生图产线、浏览器采集）
 * - `agent` 其余 —— agent 写的产物和便签
 */
import { kindOf } from './board-kinds.js';

export const CATEGORIES = Object.freeze([
  { id: 'work', label: '产物' },
  { id: 'material', label: '素材' },
  { id: 'tool', label: '工具' },
  { id: 'ink', label: '笔迹' },
  { id: 'doc', label: '文档' },
]);

export const SOURCES = Object.freeze([
  { id: 'agent', label: 'agent 做的' },
  { id: 'tool', label: '工具采的' },
  { id: 'user', label: '我放的' },
]);

/** 内容轴。未知形态按 file 走（= material）。 */
export function categoryOf(o) {
  return kindOf(o).category || 'material';
}

/**
 * 来源轴。判据的**顺序有讲究**：先看路径（那是最硬的证据 —— 文件真的躺在
 * 工具的目录里），再看服务端给的 `kind`（upload/generated 是扫描时分的栏），
 * 最后才兜底 agent。
 */
export function sourceOf(o) {
  if (kindOf(o).category === 'tool') return 'tool';
  const p = String(o?.path || o?.rel || '');
  if (p.startsWith('assets/references/')) return 'tool';    // 浏览器采集 / 搜索下载
  if (p.startsWith('assets/generated/')) return 'tool';     // 生图产线
  if (o?.kind === 'generated') return 'tool';
  if (p.startsWith('用户内容/')) return 'user';           // 上传落点（2026-08-28），路径是最硬的证据
  if (o?.kind === 'upload') return 'user';
  // ⚠️ 老形状：上传的东西路径长 `../../shared/assets/x`（扁平化前的写法）。
  // 不认它的话用户上传的素材会被标成"agent 做的"。
  if (/(^|\/)shared\/assets\/[^/]+$/.test(p)) return 'user';   // legacy-ok
  return 'agent';
}

/**
 * 过滤器：两条轴各自一个"要显示哪些"的集合，**结果取交集**。
 * `null` / 空集 = 这条轴不过滤（不是"全都不要"）—— 默认状态就该是全都看得见。
 */
/**
 * 项目档案面（2026-08-27 用户拍板）：根 CLAUDE.md 和 记忆/ 是 agent 的后台
 * 档案，不是产出 —— 默认不上画布，用户点画布右上角「档案」才显形。
 * 判据按路径（物件 id 和文件夹 zone id 都是工作区相对路径，同一个函数判两边）。
 */
export function isArchivePath(p) {
  const s = String(p || '');
  return s === 'CLAUDE.md' || s === '记忆' || s.startsWith('记忆/');
}

export function passesFilter(o, filter) {
  if (!filter) return true;
  const cats = filter.categories;
  const srcs = filter.sources;
  if (cats && cats.length && !cats.includes(categoryOf(o))) return false;
  if (srcs && srcs.length && !srcs.includes(sourceOf(o))) return false;
  return true;
}
