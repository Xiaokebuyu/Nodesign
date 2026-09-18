/**
 * lib/export-collect.js — 按「产物卡」收集要导出的东西（2026-08-17）
 *
 * 导出的寻址单位从「会话当前产物」换成**画布上的那张卡**：卡的类型决定收什么。
 * site 卡收站点那棵树、图片卡收那张图，以此类推。
 *
 * 为什么按卡 id 就够、不用再造一份枚举：
 *   卡 id 本身**就是地址**（`site:<产物根>` / `deck:<html路径>` / 文件卡是裸路径），
 *   前端 `BoardCanvas` 拼它、服务端 `board-store.mapId` 认它，用的是同一套前缀判据。
 *   这里只解析地址、落到磁盘上收，权威清单仍然只有 `/artifacts` 那一份。
 *
 * 素材只收**这份产物真正引用到的**（`asset-refs.js` 扫出来的），不再像旧交付包那样
 * 把整个项目级 `shared/assets` 一锅端 —— 那会把别的任务的图一起交出去，生产上最大的
 * 项目那个目录有 280MB。
 *
 * ── 2026-08-17 评审后修的四个洞（都有单测钉着）──
 *   1. **根级站点卡**（`site:`，rel 为空 —— 扁平化后「根 index.html = 一个站」是常态）
 *      从工作区根盲走，把 `assets/`、`exports/`、`board.json`、别的任务全打进包，
 *      280MB 病原样复活。
 *   2. **单页站点卡**（`site:任务/_drafts/试作.html`）整类 400 —— 它是画布上真实存在
 *      的一种卡，收集器却要求 site 必须是目录。
 *   3. **`.ndignore` 基准**从卡 id 字符串上切第一段，只有「深度 1 的任务文件夹」这一
 *      种布局碰巧对；根级构建站、嵌套站全取错，忽略规则静默失效。
 *   4. **软链逃逸**：`safeResolve` 只做词法检查，工作区里一个指向外面的软链能把
 *      工作区外的文件收进包（实测读出过 /tmp 下的文件内容）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { walkTaskFiles, loadIgnore, RESERVED_DIRS, isReservedFile } from './task-scan.js';
import { collectAssetRefs } from './asset-refs.js';
import { kindDef, taskManifest, can } from './kinds/index.js';
import { fileKindOfPath, fileKindDef } from './kinds/file-kinds.js';
// 越界判据收在一处（原来这里有第二份实现，docx 页图路由抄它的形状时抄漏了 realpath）
import { safeResolveRead as safeResolve } from './safe-path.js';

/**
 * 卡 id → { kind, rel }。
 *
 * ⚠️ 前缀只认纯字母（`deck:` `site:`）—— 路径里本来就可能有冒号，判据必须跟
 * 前端 `stage.js` 的 `zoneOfObjectId` 和服务端 `board-store.mapId` 保持一致。
 * 没有合法前缀 = 文件卡，类型按路径推。
 * 认哪些前缀问注册表（kindDef）—— 原来是两个手写 Set，加形态时这里必漏，
 * 新形态的卡会被当成裸文件路径去解析（「写死表家族」第 5 处，2026-08-18 收）。
 *
 * ⚠️ 已知歧义：根层一个叫 `final:v2.png` 的文件，卡 id 就是裸路径，这里会把
 * `final` 当前缀剥掉。三处判据是**一致地**这样，改判据要三处一起改；collectCard
 * 里对这种情况有一次「整串当路径」的回退。
 */
export function parseCardId(cardId) {
  if (!cardId || typeof cardId !== 'string') return null;
  const c = cardId.indexOf(':');
  if (c > 0 && /^[a-z]+$/.test(cardId.slice(0, c))) {
    const kind = cardId.slice(0, c);
    const rel = cardId.slice(c + 1).replace(/\\/g, '/');
    if (kindDef(kind)) return { kind, rel };
    return { kind: fileKindOfPath(rel), rel };
  }
  const rel = cardId.replace(/\\/g, '/');
  return { kind: fileKindOfPath(rel), rel };
}


/** 这种形态能导出成什么。single = 单页产物，没有「整站 zip」可言（跟 taskManifest 的 decorate 同一条剥除） */
export function exportFormatsFor(kind, { single = false } = {}) {
  const list = kindDef(kind)?.exportFormats || fileKindDef(kind)?.exportFormats || [];
  return single ? list.filter(f => f !== 'site') : list;
}

/**
 * 忽略规则的基准目录 = **`.ndignore` 自己所在的那一层**，从产物根往上找第一个。
 *
 * 这跟 `.gitignore` 是同一条语义：规则文件的作用域就是它自己的目录。
 *
 * 曾经从卡 id 字符串上切第一段（`rel.split('/')[0]`）当基准，只有「深度 1 的任务
 * 文件夹」这一种布局碰巧对：根级构建站（`site:dist`）会切出 `dist`、嵌套站
 * （`site:客户/官网`）会切出 `客户`，两种情况下忽略规则都**静默失效**。
 * 也试过问 `taskManifest` 谁认领了这个产物根，但构建站的 `dist/` 自己看起来也像
 * 个站，从深往浅问会停在 `dist` 上 —— 而 `.ndignore` 明明在更外面。
 * 按规则文件自己的位置找，三种布局一次都不会错。
 */
async function ignoreBaseFor(workspaceRoot, rel) {
  const segs = rel ? rel.split('/') : [];
  for (let i = segs.length; i >= 0; i--) {
    const cand = segs.slice(0, i).join('/');
    const dir = cand ? path.join(workspaceRoot, cand) : workspaceRoot;
    try {
      await fs.access(path.join(dir, '.ndignore'));
      return cand;
    } catch { /* 这层没有，往上找 */ }
  }
  return '';   // 一个都没有：基准取工作区根（规则为空，等价于不过滤）
}

/**
 * 收一张卡。
 *
 * @returns {Promise<{cardId, kind, rel, title, single, files, assets, missing, unresolved, exportFormats}>}
 *   files       产物自身的文件（rel 相对工作区根）
 *   assets      它真正引用到、且磁盘上确实存在的素材
 *   missing     引用了但磁盘上找不到的（裂图预警）
 *   unresolved  算不出来的引用（动态拼接 / 脚本字面量 / 树外引用 / `<base href>`）
 */
export async function collectCard({ workspaceRoot, cardId }) {
  const parsed = parseCardId(cardId);
  if (!parsed) throw Object.assign(new Error(`认不出这张卡：${cardId}`), { status: 400 });

  let { kind, rel } = parsed;
  let abs = await safeResolve(workspaceRoot, rel);
  let stat = null;
  if (abs) { try { stat = await fs.stat(abs); } catch { /* 下面回退 */ } }

  // 前缀剥错了的回退：`final:v2.png` 这种文件名会被当成 `final:` 前缀
  if (!stat && cardId !== rel) {
    const whole = cardId.replace(/\\/g, '/');
    const absWhole = await safeResolve(workspaceRoot, whole);
    if (absWhole) {
      try {
        stat = await fs.stat(absWhole);
        abs = absWhole; rel = whole; kind = fileKindOfPath(whole);
      } catch { /* 仍然没有 */ }
    }
  }
  if (!abs) throw Object.assign(new Error(`路径越界或指向工作区外：${rel}`), { status: 400 });
  if (!stat) throw Object.assign(new Error(`产物不存在：${rel}`), { status: 404 });

  const files = [];
  // 「这种形态有没有目录型」问注册表（kind 条目声明 directory）。整树打包只对
  // browsable 的目录型成立（站点 = 一棵互相引用的树）；word 文件夹也是目录型，
  // 但 .docx 成员各自自包含，卡级导出走下面挑主成员那条，不走树
  const dirKind = !!kindDef(kind)?.directory;
  // 单页站点（`_drafts/试作.html` 这类）也是 site 卡，只是它是一个文件不是一棵树
  const single = dirKind && can(kind, 'browsable') && stat.isFile();
  const isTree = dirKind && can(kind, 'browsable') && stat.isDirectory();

  const deepWarn = [];
  if (isTree && !rel) {
    // ⭐**根站不盲走。** 扁平化后「根 index.html = 一个站」是常态，而根站的「树」
    // 就是整个工作区 —— 盲走会把项目基础设施和**别的任务**一起卷进来。
    // 正解是问权威解析器要页面清单：`taskManifest` 的根站条目（site / 非 single /
    // 无 srcRoot，跟 assets.js 判 rootSite 同一口径）里的 `pages` 就是它认领了哪些页。
    // 别的任务的 index.html 不在这份 pages 里，天然被排除；页面引用到的 css/js/图
    // 由下面的 refs 收。这比我自己拿一张保留目录表去猜要靠谱 —— 谁属于这个站，
    // 只有解析器说了算。
    const m = await taskManifest(workspaceRoot).catch(() => null);
    const rootSite = (m?.artifacts || []).find(a => a.kind === 'site' && !a.single && !a.srcRoot);
    for (const pg of (rootSite?.pages || [])) {
      // ⚠️ pages 是**产物根相对**（构建型根站 root='dist' 时是 'index.html' 不是
      // 'dist/index.html'）——对着工作区根解析会抓到源文件或落空（08-24 对齐）
      const pRel = (rootSite.root ? `${rootSite.root}/` : '') + String(pg).replace(/\\/g, '/');
      const pAbs = await safeResolve(workspaceRoot, pRel);
      if (!pAbs) continue;
      try { if ((await fs.stat(pAbs)).isFile()) files.push({ abs: pAbs, rel: pRel }); } catch { /* 页面刚被删 */ }
    }
    if (!files.length) {
      // 解析器认不出根站（还没写出 index.html 之类）→ 退回入口文件本身，
      // 绝不退回「盲走整个工作区」
      const entryAbs = await safeResolve(workspaceRoot, 'index.html');
      if (entryAbs) {
        try { if ((await fs.stat(entryAbs)).isFile()) files.push({ abs: entryAbs, rel: 'index.html' }); } catch { /* */ }
      }
    }
  } else if (isTree) {
    const ignoreBaseRel = await ignoreBaseFor(workspaceRoot, rel);
    const ignoreBaseAbs = (await safeResolve(workspaceRoot, ignoreBaseRel)) || workspaceRoot;
    const ignore = await loadIgnore(ignoreBaseAbs);
    const walked = await walkTaskFiles(abs, { maxDepth: 6, ignore, ignoreBase: ignoreBaseAbs });
    for (const f of walked) {
      const r = path.relative(workspaceRoot, f.abs).replace(/\\/g, '/');
      files.push({ abs: f.abs, rel: r });
      // maxDepth 撞顶是静默截断的（walkTaskFiles 不给信号）。贴着上限的文件说明
      // 这棵树很深，更深的东西可能没进包 —— 报出来，别让人以为齐了。
      // ⚠️ 深度要按 **walk 相对卡根** 的路径算（`f.rel`），不是工作区相对的 `r`：
      // 嵌套站 `客户/官网/a/b/c/x.png` 在工作区坐标下有 6 段，但 walk 只走了 4 层，
      // 离截断远着 —— 用错坐标系会往交付物里印假警报。
      if (f.rel.split('/').length >= 6) deepWarn.push(r);
    }
  } else if (kind === 'docx' && stat.isDirectory()) {
    // word 文件夹卡（`docx:报告`）：地址是文件夹，导出对象是主成员 —— 窗里的
    // 导出按钮会点名具体成员（`docx:报告/文档v2.docx`），走上面的单文件分支；
    // 这条是卡级导出的兜底。挑主成员的判据在 kinds/docx.js，别在这儿抄第二份。
    let names = [];
    try { names = kindDef('docx').sortDocxNames(await fs.readdir(abs)); } catch { /* 下面报 404 */ }
    if (!names.length) throw Object.assign(new Error(`${rel} 里没有 .docx`), { status: 404 });
    rel = `${rel}/${names[0]}`;
    files.push({ abs: path.join(abs, names[0]), rel });
  } else {
    if (!stat.isFile()) throw Object.assign(new Error(`${rel} 不是文件`), { status: 400 });
    files.push({ abs, rel });
  }

  if (!files.length) {
    throw Object.assign(new Error(`${rel} 里没有可导出的文件`), { status: 400 });
  }

  // 树外引用只认 `assets/`、产物自己的目录，以及树外的素材文件（09-18，拖出 assets/ 的生成图；页面仍挡）。
  // 根层产物的自有前缀是空串 = 不设闸：它的树本来就是整个工作区，这条认账。
  const ownPrefix = isTree ? (rel ? `${rel}/` : '') : (path.posix.dirname(rel) === '.' ? '' : `${path.posix.dirname(rel)}/`);
  // 只有**标记语言**产物需要跟着引用扫下去。`browsable` 正好是这条线：能用浏览器
  // 打开 = 由 html/css 组成 = 有外部引用要带。docx 是自包含的 zip（图片字体都在
  // 包里），拿二进制去跑引用扫描器是白费力气，还可能在压缩字节里撞出假路径。
  // 问注册表和能力，不问形态名 —— 加第四种形态时这行不用动。
  const scannable = !!kindDef(kind) && can(kind, 'browsable');
  let refs = []; let unresolved = []; let candidates = [];
  if (scannable) {
    // ⭐**传递引用要跟着扫下去。** html 引 css、css 再引图 —— 只扫产物自身的话，
    // 那张图既不进包也不进清单（用户拍的规矩里最坏的状态），解压即裂图且零预警。
    // deck 卡 / 单页站 / 根站三类全中，因为它们的 files 里只有页面本身。
    // 定点到不动为止，最多四轮（防环、也防超深链把单次导出拖垮）。
    const allow = ownPrefix === '' ? [] : [ownPrefix, 'assets/'];
    const scanned = new Set(files.map(f => f.rel));
    let batch = files;
    for (let round = 0; round < 4 && batch.length; round++) {
      const r = await collectAssetRefs({ files: batch, baseRoot: workspaceRoot, allowPrefixes: allow, allowMedia: true });
      refs.push(...r.refs); unresolved.push(...r.unresolved); candidates.push(...r.candidates);
      batch = [];
      for (const rr of r.refs) {
        if (scanned.has(rr) || !/\.(html?|css|m?js|cjs)$/i.test(rr)) continue;
        scanned.add(rr);
        const a = await safeResolve(workspaceRoot, rr);
        if (a) batch.push({ abs: a, rel: rr });
      }
    }
    refs = [...new Set(refs)];
  }
  if (deepWarn.length) {
    unresolved.push({
      from: rel || '(工作区根)',
      why: `目录深度贴到上限 6 层，更深的文件没有进包（命中 ${deepWarn.length} 个）`,
      snippet: deepWarn.slice(0, 3).join(' / '),
    });
  }

  const assets = []; const missing = [];
  const ownSet = new Set(files.map(f => f.rel));
  // 脚本里的完整字面量路径（画廊 / lightbox 那种）：**磁盘上真有这个文件就不是猜**，
  // 提升成素材；解析不到的仍然只进清单。这不违反「扫不到的不多塞」——
  // 它扫得到，只是来源是脚本而不是标签。
  for (const c of candidates) {
    const a = await safeResolve(workspaceRoot, c.rel);
    if (!a || ownSet.has(c.rel)) continue;
    try {
      if ((await fs.stat(a)).isFile()) { refs.push(c.rel); continue; }
    } catch { /* 不存在 */ }
    unresolved.push({ from: c.from, why: '脚本里的字符串字面量（磁盘上没找到对应文件）', snippet: c.snippet });
  }
  refs = [...new Set(refs)].sort();
  for (const r of refs) {
    const a = await safeResolve(workspaceRoot, r);
    if (!a) continue;                                    // 软链逃逸的引用直接不收
    let st = null;
    try { st = await fs.stat(a); } catch { missing.push(r); continue; }
    if (st.isFile()) { assets.push({ abs: a, rel: r }); continue; }
    if (st.isDirectory()) {
      // pretty-URL（`href="about/"`）指的是 `about/index.html`，不是裂图。
      // 不处理的话每个多页站导出都会带一堆假的缺失警报。
      const idxRel = `${r.replace(/\/$/, '')}/index.html`;
      if (ownSet.has(idxRel)) continue;
      const idxAbs = await safeResolve(workspaceRoot, idxRel);
      if (idxAbs) {
        try {
          if ((await fs.stat(idxAbs)).isFile()) { assets.push({ abs: idxAbs, rel: idxRel }); continue; }
        } catch { /* 落 missing */ }
      }
    }
    missing.push(r);
  }

  return {
    cardId, kind, rel, single,
    title: path.basename(rel) || rel || '产物',
    files, assets, missing, unresolved,
    exportFormats: exportFormatsFor(kind, { single }),
  };
}

/**
 * 按类型收一批卡（「导出全部图片」这种）。
 * 单张失败不拖累整批 —— 收不到的记进 skipped，让人看见少了什么。
 */
export async function collectCards({ workspaceRoot, cardIds }) {
  const bundles = []; const skipped = [];
  for (const id of cardIds) {
    try {
      bundles.push(await collectCard({ workspaceRoot, cardId: id }));
    } catch (err) {
      skipped.push({ cardId: id, reason: err.message, status: err.status || 500 });
    }
  }
  return { bundles, skipped };
}
