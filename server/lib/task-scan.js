/**
 * task-scan.js — 任务目录的统一扫描规则（2026-07-29）
 *
 * 站点接进真实工程形态（构建步骤 / node_modules / 源目录）后，「扫任务目录」
 * 这件事在五个地方各写各的：页面清单、整站 zip、断链检测、导出勾选、素材墙。
 * 五份跳过规则各自为政的结果是：node_modules 被整站 zip 原样打包、构建缓存
 * 触发刷新记账 —— 而且每一处都是静默的。所以收拢到这一个模块。
 *
 * 两层规则：
 *   ① 硬清单 —— 永远不看的目录（依赖 / 构建缓存 / VCS）。不可配置，
 *      因为「不小心把 node_modules 打进 zip」不该是一个能配出来的状态。
 *   ② `.ndignore` —— 任务根下的忽略档，gitignore 语法子集，agent 自己写。
 *      支持：# 注释、尾 `/`（只匹配目录）、头 `/`（锚定任务根）、`*` `?` `**`。
 *      不支持 `!` 反选（要精细控制就少写点通配）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 工作区里**不是产物**的那些名字。形态扫描（deck / site）一律跳过。
 *
 * 2026-08-07 扁平化之后才需要这张表：以前形态扫描的根是 `tasks/<任务>/`，
 * 一个只装产物的干净目录；现在根是项目工作区，产物跟基础设施住在一起。
 * 不挡的话有两个实测会发生的假产物：
 *   - `canvas.template.html` / `site.template.html`（skill 拷进 cwd 的起手
 *     模板）会各自变成一张 deck 卡 —— deck 认"顶层任意 .html"；
 *   - `exports/` 里导出过一个站就会多出一张站点卡 —— 站点认"子目录里有
 *     index.html"，而导出包正好长这样。
 *
 * 点开头的（.claude / .nd / .git）扫描器本来就跳，不用列。
 */
// `agent-memory` 是老符号链接时代的残骸目录名（正规位置是 .claude/agent-memory/），
// 留在这里是为了它万一还在也不会作为一张文件夹卡出现在桌面上。
export const RESERVED_DIRS = new Set(['assets', 'exports', 'notes', 'node_modules', 'agent-memory']);

/**
 * **档案目录**（2026-08-31）：住在工作区里、agent 天天 Read，但**不是版面上的东西**。
 *
 * 跟 RESERVED_DIRS 的分别：保留目录是基础设施，桌面上根本不出现；档案目录是
 * 用户的文件夹，照常渲染成文件夹卡、照常能翻开看 —— 它们只是**不该被当作
 * "等你安置的到货"每回合催 agent 摆上版面**。
 *
 * 证据（proj_mth8wd7k，晴可 RP）：暂存架上 11 件，`角色/晴可/角色卡.md`、五份
 * 阶段人设、三份世界书、落点对账 —— 11/11 全是这类，一件都不该上版面，而状态块
 * 每回合都在催。agent 自己报了这条 friction（iss_mth9td8n）并给出了同一个修法。
 *
 * 名字是约定不是发明：`角色/` = cast-role.js 的 ROLES_DIR，`记忆/` = SDK
 * auto-memory 的家（memory-migration.js），`世界书/` `预设/` 出自 story-import
 * 那条线的酒馆卡导入。
 */
export const ARCHIVE_DIRS = new Set(['角色', '世界书', '预设', '记忆']);

/** 这条路径住在档案目录里吗（只看第一段 —— 档案是顶层目录，不是散落各处的标记） */
export function isArchivePath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const i = rel.indexOf('/');
  return i > 0 && ARCHIVE_DIRS.has(rel.slice(0, i));
}

/**
 * 不当产物看的文件：起手模板（拷进来是给 agent 抄/改的，不是成品）。
 * 2026-08-15 加 js/mjs —— RP 的管线模块 `演出.template.js` 走同一条起手文件路，
 * 规则只认 html/css 的话它会当成一张产物卡上墙。
 */
export function isReservedFile(name) {
  return /\.template\.(html?|css|jsx?|mjs)$/i.test(name) || RESERVED_FILES.has(name);
}

/**
 * 基础设施文件：住在工作区里，但**不是用户的东西**，不该在桌面上出现。
 *
 * 2026-08-08 加。在这之前只挡起手模板，于是 `board.json`（画布自己的布局档）
 * 会作为一张 .json 文件卡上墙 —— 画布把自己的存档画在自己身上。
 */
export const RESERVED_FILES = new Set([
  'board.json',        // 画布布局，画布自己的存档
  '.nd-project.json',  // 产物标记（形态兜底）
  '.gitignore',
  '.ndignore',
  // 下面三个是基础设施不是用户产物，上墙就是「画布把自己的存档画在自己身上」
  // 家族（08-24 清账补齐；ui-config.json 是黑板模式开关，曾以 .json 卡上墙）
  'ui-config.json',
  'spec.json',
  'pending-changes.json',
]);

/** 永远不扫的目录名（任何深度命中即剪枝） */
export const HARD_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.wrangler', '.cache', '.next', '.astro', '.nuxt',
  '.svelte-kit', '.output', '.parcel-cache', '.turbo', '.vite',
  'venv', '.venv', '__pycache__', 'coverage',
]);

/** 展品目录：站点的试作放这里，单独渲染成卡，不算站点页面、不进 zip */
export const DRAFTS_DIR = '_drafts';

export const NDIGNORE_FILE = '.ndignore';

/**
 * 读产物标记（`.nd-project.json`）。没有 / 读不动 → null。
 * 2026-08-24 从 kinds/index.js 迁来：site.js 现在要按子目录读 marker（构建型
 * 子目录站），住 kinds/index.js 会循环 import。kinds/index.js 原样 re-export。
 */
export async function readTaskMarker(root) {
  try {
    const raw = await fs.readFile(path.join(root, '.nd-project.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}

/** gitignore 子集 → RegExp。认不出的行按字面量处理（转义后精确匹配）。 */
function compilePattern(line) {
  let pat = line.trim();
  if (!pat || pat.startsWith('#')) return null;
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith('/');
  if (anchored) pat = pat.slice(1);
  // 转义正则元字符，再还原通配语义（** → 任意层，* → 段内任意，? → 段内单字符）
  let re = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\uE000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\uE000/g, '.*');
  // 无斜杠的裸模式（`*.bak`）匹配任何一层的条目名；带斜杠 / 锚定的按路径匹配
  const body = (!anchored && !pat.includes('/')) ? `(?:^|/)${re}` : `^${re}`;
  return { re: new RegExp(`${body}(?:/|$)`), dirOnly };
}

/**
 * 读任务的 `.ndignore`，返回匹配器 `(rel, isDir) => boolean`。
 * rel 相对任务根、'/' 分隔、不带前导斜杠。没有忽略档 → 只有硬清单生效。
 */
export async function loadIgnore(taskDir) {
  let rules = [];
  try {
    const raw = await fs.readFile(path.join(taskDir, NDIGNORE_FILE), 'utf8');
    rules = raw.split('\n').map(compilePattern).filter(Boolean);
  } catch { /* 没有 .ndignore：正常 */ }
  return (rel, isDir = false) => {
    const segs = rel.split('/');
    // 硬清单：路径里任何一段命中都算（父目录被剪枝时子路径根本走不到这，
    // 这里再查一遍是给「直接拿 rel 来问」的调用方兜底）
    if (segs.some(s => HARD_IGNORE_DIRS.has(s))) return true;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(rel + '/')) continue;
      if (r.re.test(rel)) return true;
    }
    return false;
  };
}

/**
 * 递归列任务目录下的文件（应用硬清单 + .ndignore + 跳 dot 条目）。
 *
 * @param {string} rootDir  绝对路径（任务根或产物根）
 * @param {object} [opts]
 * @param {number}   [opts.maxDepth=6]
 * @param {Function} [opts.ignore]        loadIgnore 的返回值；不传就现读
 * @param {string}   [opts.ignoreBase]    ignore 规则的基准目录（缺省 = rootDir）。
 *                                        产物根是子目录时，.ndignore 在任务根，
 *                                        rel 要先换算回任务根视角再问匹配器。
 * @param {boolean}  [opts.includeDrafts=false]  是否进 `_drafts/`
 * @returns {Promise<Array<{rel: string, abs: string, name: string, size: number}>>}
 */
export async function walkTaskFiles(rootDir, opts = {}) {
  const { maxDepth = 6, includeDrafts = false } = opts;
  const ignoreBase = opts.ignoreBase || rootDir;
  const ignore = opts.ignore || await loadIgnore(ignoreBase);
  const out = [];
  const toIgnoreRel = (abs) => path.relative(ignoreBase, abs).split(path.sep).join('/');

  const walk = async (dir, prefix, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (HARD_IGNORE_DIRS.has(e.name)) continue;
        if (!includeDrafts && e.name === DRAFTS_DIR) continue;
        if (ignore(toIgnoreRel(abs), true)) continue;
        await walk(abs, rel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (ignore(toIgnoreRel(abs), false)) continue;
      let size = 0;
      try { size = (await fs.stat(abs)).size; } catch { continue; }
      out.push({ rel, abs, name: e.name, size });
    }
  };
  await walk(rootDir, '', 1);
  return out;
}
