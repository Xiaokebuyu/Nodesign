/**
 * artifact-target.js — 产物寻址（2026-07-28 由 canvas-target.js 泛化；
 * 2026-07-29 形态判定与解析下沉到 kinds/ 注册表；2026-08-07 任务层退役）
 *
 * 定死三件事：
 *
 * **① 产物有形态（kind），文件就是真相。** 判定规则在 kinds/ 注册表：
 *    canvas.html → deck；index.html（工作区根 / 声明的产物根 / 约定构建目录）
 *    → site。
 *
 * **② 寻址永远带着 kind 一起返回。** 下游（截图 / 分页 / 导出 / fit 注入）必须
 *    能看见"这是 deck 还是 site"，才可能给出对的行为。kind 每次 resolve 按工作区
 *    现状重算，不缓存。
 *
 * **③ 源和产物可以分开。** 构建型站点的源在工作区根、产物在 dist/ 之类的产物根。
 *    resolve 返回 workspaceRoot（源，agent 的地盘）和 artifactDir（被预览 / 导出 /
 *    发布的根），deck 和手写站点两者相同。消费方要"看"产物就用 artifactDir，
 *    别再自己 dirname(entryPath)。
 *
 * 寻址顺序（越靠前越明确）：
 *   ① 调用方显式给的 path
 *   ② 本会话的"当前产物"——最近写过 / 截过 / 预览过哪份就是哪份
 *   ③ 工作区只有一份产物就是它；多份就报错列出来让调用方指定
 *
 * ## 2026-08-07：第 ③ 条曾经是第 ④ 条
 *
 * 中间夹着一条「认领绑在本会话名下那个任务」——`tasks/<任务>/.nd-task.json`
 * 里记着 sessionId，寻址时按当前会话去反查它的任务。那条规则存在的前提是
 * **一个项目里有多个任务、而每个任务属于一个会话**；线上数据说这个前提从来
 * 没成立过（13 个有产物的项目，每个都恰好一个任务）。
 *
 * 任务层拆掉之后，"这个会话的产物"这个问题本身就没有意义了 —— 产物属于项目，
 * 谁开的对话都看得见同一批。剩下的歧义（工作区里有多份产物、调用方没说哪份）
 * 由 ② 的最近使用和 ③ 的显式报错解决，这两条本来就在，而且不依赖任何绑定。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  KINDS, kindDef, readTaskMarker, taskManifest, artifactOfPath, can,
} from './kinds/index.js';

export const KIND_DECK = 'deck';
export const KIND_SITE = 'site';

/** 每种形态的入口文件名（从注册表派生；改形态契约去 kinds/） */
export const ENTRY_FILE = Object.freeze(
  Object.fromEntries(Object.values(KINDS).map(k => [k.id, k.entryFile])),
);

/**
 * 产物入口**长什么样**（扩展名集合），同样从注册表派生。
 * `.html` / `.htm` 是 deck+site 的形状，`.docx` 是 word 的 —— 加形态时这里
 * 自动跟上，不用再回来补一条正则。
 */
const ENTRY_EXTS = new Set(
  Object.values(KINDS)
    .map(k => (k.entryFile.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase())
    .filter(Boolean)
    .concat('.htm'),   // html 的老写法，注册表里只写了 .html
);

// 形态判定与解析的权威在 kinds/，这里转发老名字（消费方 import 不用改两次）
export { readTaskMarker, taskManifest, kindDef, artifactOfPath };
export { formatAllowed, docxClaimedFiles, isDirArtifact } from './kinds/index.js';
export { can };

/** sessionId → { path, kind }。会话结束不清也无妨（几个短字符串） */
const activeArtifact = new Map();

/**
 * 记住这个会话正在做哪份产物（写文件 / 截图 / 预览时调）。
 *
 * 只认**产物入口的形状**（ENTRY_EXTS，从注册表派生）。以前还认"任务内的非
 * html"（改 style.css 也算在这个任务上干活，寻址时走任务入口），任务层没了之后
 * 那一支失去了落点：改 `style.css` 说明不了在做哪一份 deck，工作区根上可能并排
 * 放着好几份。认不出来就不认，让 resolve 走"只有一份就是它 / 多份报错"那条 ——
 * 比猜一个错的默认目标强。
 */
export function setActiveArtifact(sessionId, relPath, kind) {
  if (!sessionId || typeof relPath !== 'string') return;
  const p = normalizeRel(relPath);
  if (/\.template\.(html?|css)$/i.test(p)) return;   // 模板不是产物
  const ext = (p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (!ENTRY_EXTS.has(ext)) return;
  activeArtifact.set(sessionId, { path: p, kind: kind || null });
}

export function getActiveArtifact(sessionId) {
  return (sessionId && activeArtifact.get(sessionId)) || null;
}

export function clearActiveArtifact(sessionId) {
  activeArtifact.delete(sessionId);
}

function normalizeRel(p) {
  // 尾部 ?query / #hash 一并剥掉：agent 常把预览 URL 原样拿来当 path
  //（'dist/index.html?t=18&panel=0' 落 not found，08-24 清账两案）。
  // 磁盘文件名里合法出现 ? # 的场景在这套产物约定里不存在。
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/[?#].*$/, '');
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** workspace 内才算数（resolve 不出根） */
function insideWorkspace(workspaceRoot, absPath) {
  const root = path.resolve(workspaceRoot);
  return absPath === root || absPath.startsWith(root + path.sep);
}

// （listSitePages 2026-08-24 拆除：调用 KINDS.site.manifest 这个不存在的方法，
//  一调必 TypeError，全仓无调用方 —— 死代码假装公开 API。页面清单读
//  taskManifest().artifacts[].pages。）

/**
 * 推断某个 html 路径的产物形态。
 *
 * 多产物平权：canvas.html 跟一个根站并存时仍然是 deck、about.html 是站点子页 ——
 * 同名文件形态可以不同，问 artifacts 清单而不是猜文件名。清单里找不到（文件
 * 还没写出来）才退回文件名约定。
 */
export async function kindOfPath(workspaceRoot, relPath) {
  const p = normalizeRel(relPath);
  const base = path.posix.basename(p);
  const m = await taskManifest(workspaceRoot);
  if (m) {
    const art = artifactOfPath(m, p);
    if (art) return art.kind;
    if (m.kind) return m.kind;
  }
  if (base === ENTRY_FILE[KIND_DECK]) return KIND_DECK;
  if (base === ENTRY_FILE[KIND_SITE]) return KIND_SITE;
  // 清单里没有（文件还没写出来）时按扩展名回退。.docx 只可能是 word 形态，
  // 让它落进 deck 会让感知层拿 playwright 去开一个二进制包。
  const ext = (p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const byExt = Object.values(KINDS).find(k => k.entryFile.toLowerCase().endsWith(ext) && ext !== '.html');
  if (byExt) return byExt.id;
  return KIND_DECK;   // 认不出的散装 .html 一律按 deck
}

/** 这个工作区现有的产物入口（平权，没有主次） */
export async function listWorkspaceArtifacts(workspaceRoot) {
  const m = await taskManifest(workspaceRoot);
  return (m?.artifacts || []).map(a => ({ rel: a.entryRel, kind: a.kind }));
}

/** 兼容旧名：只要 deck 那些 */
export async function listWorkspaceDecks(workspaceRoot) {
  return (await listWorkspaceArtifacts(workspaceRoot))
    .filter(a => a.kind === KIND_DECK)
    .map(a => a.rel);
}

/**
 * 解析产物目标。
 *
 * @param {string} workspaceRoot
 * @param {string|null} relPath   调用方显式给的路径（优先级最高）
 * @param {string|null} sessionId
 * @returns {Promise<{ ok: true, absPath: string, relPath: string, kind: 'deck'|'site',
 *                     task: string|null, taskDir: string|null,
 *                     artifactDir: string|null, artifactRel: string|null }
 *                  | { ok: false, message: string }>}
 *   taskDir      源（任务根，agent 的地盘）
 *   artifactDir  产物根（被预览 / 导出 / 发布的目录）；deck 和手写站点 = taskDir
 */
export async function resolveArtifactTarget(workspaceRoot, relPath, sessionId) {
  const decorate = async (rel) => {
    const p = normalizeRel(rel);
    // 按所属产物定 kind 和产物根（多产物平权：canvas.html 是 deck、
    // v2/index.html 是另一个站，root 各归各）
    let kind = null;
    let root = '';
    let artifact = null;
    const m = await taskManifest(workspaceRoot);
    if (m) {
      artifact = artifactOfPath(m, p);
      if (artifact) { kind = artifact.kind; root = artifact.root || ''; }
      else if (m.kind) { kind = m.kind; root = m.root || ''; }
    }
    if (!kind) kind = await kindOfPath(workspaceRoot, p);
    return {
      ok: true,
      absPath: path.resolve(workspaceRoot, p),
      relPath: p,
      kind,
      // task / taskDir 保留成兼容字段：任务层没了，"源目录"永远是工作区根。
      // 下游有十几处读 taskDir 当"agent 的地盘"，给它对的值比改十几处安全。
      task: null,
      taskDir: workspaceRoot,
      artifact,   // 所属产物条目（manifest.artifacts 里那条；散文件为 null）
      artifactDir: root ? path.join(workspaceRoot, root) : workspaceRoot,
      artifactRel: root || '.',
    };
  };

  const tryPath = async (rel) => {
    if (!rel) return null;
    // 先归一（反斜杠 / ./ / ?query）再落盘找：decorate 已经这么做了，找文件那一步不归一的话
    // Windows 风格的路径在别的平台上就是另一个不存在的文件名
    const abs = path.resolve(workspaceRoot, normalizeRel(rel));
    if (!insideWorkspace(workspaceRoot, abs)) return null;
    if (!(await exists(abs))) return null;
    // 给的是文件夹（站点卡的 id 就是文件夹名，导出菜单 / 工具常把它原样喂进来）→ 落到它的入口文件。
    // 以前 exists() 对目录也放行，下游 readFile 直接 EISDIR 500（09-09 桌面版 0.1.34 导出 HTML 案）。
    let st = null;
    try { st = await fs.stat(abs); } catch { return null; }
    if (st.isDirectory()) {
      const dir = normalizeRel(rel).replace(/\/+$/, '');
      const m = await taskManifest(workspaceRoot);
      const owned = (m?.artifacts || []).find(a => a.entryRel && (a.root === dir || a.srcRoot === dir));
      // 站点的 index.html 先于 deck 的 canvas.html：文件夹形态的产物几乎都是站点
      const order = [KIND_SITE, KIND_DECK, ...Object.keys(ENTRY_FILE).filter(k => k !== KIND_SITE && k !== KIND_DECK)];
      const candidates = owned ? [owned.entryRel] : order.map(k => `${dir}/${ENTRY_FILE[k]}`);
      for (const c of candidates) {
        if (await exists(path.resolve(workspaceRoot, c))) return decorate(c);
      }
      return null;
    }
    return decorate(rel);
  };

  if (relPath) {
    const hit = await tryPath(relPath);
    if (hit) { setActiveArtifact(sessionId, hit.relPath, hit.kind); return hit; }
    const abs = path.resolve(workspaceRoot, relPath);
    if (!insideWorkspace(workspaceRoot, abs)) return { ok: false, message: 'path escapes workspace' };
    // 回退：agent 常拿**产物根相对**或**源目录相对**路径来喂（'index.html'、
    // 'dist/index.html'），而这里收的是工作区相对（'jet-engine/dist/index.html'）。
    // 没命中时按各站点实例的 root / srcRoot 补前缀再试一轮，省一次注定失败的
    // 往返（08-24 案：三个工具三种写法全 not found）。
    const m = await taskManifest(workspaceRoot);
    const rel = normalizeRel(relPath);
    const prefixes = new Set();
    for (const a of (m?.artifacts || [])) {
      if (a.kind !== KIND_SITE || a.single) continue;
      if (a.root) prefixes.add(a.root);
      if (a.srcRoot && a.srcRoot !== a.root) prefixes.add(a.srcRoot);
    }
    for (const pre of prefixes) {
      const hit2 = await tryPath(`${pre}/${rel}`);
      if (hit2) { setActiveArtifact(sessionId, hit2.relPath, hit2.kind); return hit2; }
    }
    const candidates = (m?.artifacts || []).map(a => a.entryRel).filter(Boolean);
    return {
      ok: false,
      message: `${relPath} not found. Write it first, or check the path (workspace-relative).`
        + (candidates.length ? `\nExisting artifact entries:\n${candidates.map(c => `- ${c}`).join('\n')}` : ''),
    };
  }

  const active = getActiveArtifact(sessionId);
  if (active?.path) {
    const activeHit = await tryPath(active.path);
    if (activeHit) return activeHit;
  }

  const all = await listWorkspaceArtifacts(workspaceRoot);
  if (all.length === 1) {
    setActiveArtifact(sessionId, all[0].rel, all[0].kind);
    return decorate(all[0].rel);
  }
  if (all.length > 1) {
    return {
      ok: false,
      message: 'Multiple artifacts in this workspace — pass path explicitly:\n'
        + all.map(a => `- ${a.rel}  (${a.kind})`).join('\n'),
    };
  }
  return {
    ok: false,
    message: 'No artifact found. Deck = canvas.html, site = index.html — '
      + 'write one first, or pass path explicitly.',
  };
}

/**
 * 浏览器类工具的统一闸门：目标形态不能用浏览器打开就别往下走。
 *
 * 用法是 resolveCanvasTarget 之后立刻过一道：
 *   const target = await resolveCanvasTarget(...);
 *   if (!target.ok) return err(target.message);
 *   const gate = requireBrowsable(target);
 *   if (gate) return err(gate);
 *
 * 不把它塞进 resolveArtifactTarget 内部，是因为导出、寻址这些**正当**需要拿到
 * 不可浏览目标的调用方也走那个函数，在源头拦会误伤。
 *
 * @returns {string|null} 不可浏览时返回给 agent 的说明，可浏览返回 null
 */
export function requireBrowsable(target) {
  if (!target?.kind || can(target.kind, 'browsable')) return null;
  const who = target.relPath || target.kind;
  // 可渲染形态（docx）要给对路的替代方案。说"直接 Read 它的文件"是**错的建议**
  // —— 那是个二进制 zip，Read 出来是乱码，而它其实是**看得见**的，只是要先渲染。
  if (can(target.kind, 'renderable')) {
    return `${who} 是 ${target.kind} 形态，没有 DOM，读页面 / 查元素 / 取计算样式这几个工具对它无效。`
      + '看长相用 screenshot（它会渲染成页图，可以带 pages 参数指定范围）；'
      + '看结构读它的 token 源（同名 .json），别去 Read 那个 .docx 本身，它是二进制包。';
  }
  return `${who} 是 ${target.kind} 形态，没有可以用浏览器打开的入口，`
    + '截图 / 读页面 / 查元素这类工具对它没有意义。直接 Read 它的文件。';
}

/** 给各工具复用的 path 参数描述（保持措辞一致） */
export const ARTIFACT_PATH_DESC =
  'WORKSPACE-relative path of the artifact entry (deck: "canvas.html" or "稿件/主稿.html"; '
  + 'site in its folder: "my-site/index.html", or its build output "my-site/dist/index.html"; '
  + 'standalone page: "_drafts/试作.html"; word: "文档.docx"). All artifact tools share '
  + 'this one convention. Omit to use the artifact you are currently working on.';

// ── 兼容层：老名字继续可用，内部全部走上面的实现 ────────────────────────────
export const CANVAS_PATH_DESC = ARTIFACT_PATH_DESC;
export const resolveCanvasTarget = resolveArtifactTarget;
export const setActiveDeck = (sessionId, relPath) => setActiveArtifact(sessionId, relPath);
export const getActiveDeck = (sessionId) => getActiveArtifact(sessionId)?.path || null;
export const clearActiveDeck = clearActiveArtifact;
