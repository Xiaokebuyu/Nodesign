/**
 * server/api/assets.js — 上传素材到 project shared workspace
 *
 * POST   /api/projects/:pid/assets             multipart file → 写到 shared/assets/
 * GET    /api/projects/:pid/assets             列 shared/assets/ 下的文件
 * DELETE /api/projects/:pid/assets/:filename   删 shared/assets/<filename>
 *
 * H3 改造：assets 是 project 共享资源（跨 session），落在 shared/assets/。
 * agent 通过 additionalDirectories 跨目录 Read。
 */

import express from 'express';
import multer from 'multer';
import { promises as fs } from 'fs';
import path from 'path';
import { validateProjectId, getProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  getSharedDir, ensureProjectWorkspace, removeSessionWorkspace, commitWorkspace,
} from '../projects/workspace.js';
import { patchBoard, readBoard, reconcileBoardRenames, pruneDanglingBindings, forwardId, forwardPath, renameBoardPaths } from '../projects/board-store.js';
import { moveEntry, MoveError } from '../projects/move-entry.js';
import { reconcileAutoRefsThrottled } from '../lib/auto-relations.js';
import { taskManifest, ENTRY_FILE, KIND_SITE, docxClaimedFiles, isDirArtifact } from '../lib/artifact-target.js';
import { RESERVED_DIRS, HARD_IGNORE_DIRS, DRAFTS_DIR, isReservedFile, loadIgnore } from '../lib/task-scan.js';
import { OUTPUT_DIRS } from '../lib/kinds/site.js';
import { ensurePlays, dropStage } from '../engine/stage/manager.js';
import { listReferences } from '../lib/reference-assets.js';
import { resolveArtifactFile, isServablePath } from '../lib/artifact-file-path.js';
import { USER_UPLOAD_DIR, ensureUploadDir, uploadRefPath, listUploadedAssets, deleteUploadedAsset } from '../lib/user-uploads.js';
import { getProjectCover } from '../lib/cover.js';
import { makeDocxPageHandler, makeDocxPdfHandler } from './assets/docx-page.js';
import { mountNotesRoutes } from './assets/notes.js';
import { safeSegment, decorateNoteText, decorateFilePreview, PREVIEW_EXTS } from './assets/helpers.js';
import { CHALK_DIR } from '../lib/chalk.js';
import {
  sendImage, isThumbPath, findOriginalForThumbnail, imageCacheControl,
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY,
} from '../lib/image-variant.js';
import { injectSrcset } from '../lib/html-srcset.js';
import { sendVideo, isVideo } from '../lib/video-variant.js';
import { IMAGE_EXTS, VIDEO_EXTS, decorateCardKind } from '../lib/kinds/file-kinds.js';
import { noteBoardDirty } from '../lib/board-dirty.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),  // 先收到内存再写磁盘（方便 sanitize 文件名）
  limits: { fileSize: 16 * 1024 * 1024 },
});

/**
 * 文件名净化 —— 保留原名的可读性，只挡掉真正危险的字符。
 *
 * 老版本是 ASCII 白名单（`[^A-Za-z0-9._-]` → '_'），中文名进来整个变成一串
 * 下划线：「品牌规范-2026.pdf」落盘成「_____-2026.pdf」。文件名是 agent 判断
 * 素材是什么的第一手信号（turn 的 assets 提示里就是列文件名给它看），抹掉等于
 * 每次上传都丢一层语义。
 *
 * 现在按"排除法"：路径分隔符、Windows 保留字符、控制字符、空白 → '_'（agent 会在
 * Bash 里引用这些路径，带空格容易出事）；开头的点去掉（防隐藏文件）；长度按码点
 * 截断（别把 UTF-8 从中间切断）。连字符和中文原样留着。
 * 落盘后仍然只在 assets/ 一层里用，路径逃逸由调用处的 resolve 前缀校验兜底。
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .normalize('NFC')
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'unnamed';
  const chars = [...cleaned];
  if (chars.length <= 80) return cleaned;
  // 超长时保住扩展名 —— 后面的 mime 判断 / 是否当图上墙全看它
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(cleaned)?.[0] || '';
  return chars.slice(0, 80 - ext.length).join('') + ext;
}

/**
 * multer 按 RFC 7578 把 multipart 的 filename 当 latin1 读，中文名到手就是
 * 「æµè¯.txt」这种乱码。浏览器实际发的是 UTF-8 字节，按 latin1 还原成 Buffer
 * 再用 UTF-8 解一次就对了。解出来不是合法 UTF-8 时保留原值。
 */
function decodeUploadName(raw) {
  const name = String(raw || '');
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') ? name : fixed;
  } catch { return name; }
}

/** 单层文件名：不许带路径、不许 '..'、不许以点开头（隐藏文件） */
router.post('/:pid/assets', upload.single('file'), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    if (!req.file) return res.status(400).json({ error: 'no file (field name: file)' });

    await ensureProjectWorkspace(req.params.pid);
    const assetsDir = await ensureUploadDir(getSharedDir(req.params.pid));

    const originalName = decodeUploadName(req.file.originalname);
    let filename = sanitizeFilename(originalName);
    const targetPath = path.join(assetsDir, filename);
    if (await exists(targetPath)) {
      const ts = Date.now().toString(36);
      filename = `${ts}_${filename}`;
    }

    const finalPath = path.join(assetsDir, filename);
    await fs.writeFile(finalPath, req.file.buffer);

    res.status(201).json({
      asset: {
        // path 给 agent Read 用 — 相对 cwd（sessions/<sid>/）走 ../shared/assets/
        // 或者用 SDK additionalDirectories 拿到的绝对路径前缀；前端展示用 name 即可。
        path: uploadRefPath(USER_UPLOAD_DIR, filename),
        name: filename,
        originalName,
        size: req.file.size,
        mime: req.file.mimetype,
      },
    });
  } catch (err) { next(err); }
});

router.get('/:pid/assets', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const assets = await listUploadedAssets(getSharedDir(req.params.pid));

    // 参考素材单独一组，走抽屉不上画布。为什么它们此前完全看不见（以及为什么
    // 修法是加扫描口不是改形态注册表）见 lib/reference-assets.js 文件头。
    const references = await listReferences(assetsDir);

    res.json({ assets, references });
  } catch (err) { next(err); }
});

// H4b：删 asset 文件
router.delete('/:pid/assets/:filename', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;

    const filename = req.params.filename;
    // 防 traversal：单层文件名 + resolve 后必须还在 assets/ 里
    // （不能用 ASCII 白名单——中文名的素材会删不掉）
    if (!safeSegment(filename)) {
      return res.status(400).json({ error: 'invalid filename' });
    }

    const outcome = await deleteUploadedAsset(getSharedDir(req.params.pid), filename);
    if (outcome === 'invalid') return res.status(400).json({ error: 'invalid filename' });
    if (outcome === 'not_found') return res.status(404).json({ error: 'asset not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── 工作台产物墙（2026-07-27 v1）──
// 产物 = 目前是文件（上传素材 + generated 生成图）；未来扩展便签 / 关键帧 /
// 文案 / 时序 / 视频时在这里加 kind。前端 ArtifactBoard 消费。

const ARTIFACT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.zip': 'application/zip',
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  // ⚠️ `.mjs` 缺了会当 application/octet-stream 发，浏览器**拒绝当模块加载**
  // （而 screenshot 那边承诺"动态 import 跟用户看到的一致"，原来只对 .js 成立）。
  // 字体缺 mime 不致命但会走错缓存/解码路径；.wasm 缺了 instantiateStreaming 直接失败。
  '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
};
// 「什么算图片 / 视频」的真相源在 lib/kinds/file-kinds.js（2026-08-17 从这里挪过去）——
// 导出按卡类型收产物时也要问同一个问题，抄两份会分叉成「画布认、导出不认」。

/**
 * 文件夹递归深度上限。
 *
 * 3 层是给用户的（prelude 里也是这么跟 agent 说的："层级别超过两三层"）——
 * 再深就得点进去好几下才看得见东西，桌面这个隐喻本身就失效了。这不是防御性
 * 的深度限制，构建目录 / node_modules 那类由 RESERVED_DIRS + HARD_IGNORE_DIRS
 * 挡在外面，跟深度无关。
 */
const FOLDER_MAX_DEPTH = 3;

/**
 * 「这个文件夹是真没了，还是只是这一瞬看不见」的两次判定。
 *
 * 记的是**上一次扫描时哪些是可疑的**。只有连着两次都不在才算死。一次 mv、
 * 一次改名、agent 写到一半的目录都活不过第二次判定 —— 而它们只要活到 turn
 * 结束，git 的改名检测就能把画布上那条改成新名字（reconcileBoardRenames）。
 *
 * 同时跳过正在改名窗口里的 id：转发表说它刚被改成别的名字，那它当然不在
 * 磁盘上，删了就等于把刚改好的名字又废掉。
 */
const zoneSuspects = new Map();   // pid → Set(上一轮可疑的 zone id)

function confirmDeadZones(pid, suspects, live) {
  const prev = zoneSuspects.get(pid) || new Set();
  const dead = suspects.filter(z => prev.has(z) && forwardId(pid, z) === z);
  // 这一轮的可疑名单留给下一轮；已经确认死掉的不用再留
  zoneSuspects.set(pid, new Set(suspects.filter(z => !dead.includes(z))));
  // 活过来的（改完名又出现、或者 agent 重新建了）自然从名单里消失
  for (const z of live) zoneSuspects.get(pid).delete(z);
  return dead;
}

/**
 * GET /:pid/artifacts — 产物清单（project 级，跨 session）。
 * 返回 { artifacts: [{ kind, name, path, size, mtime, ext, hasThumb }] }
 *   kind: 'generated'（agent 生成图，assets/generated/）| 'upload'（用户上传，assets/ 顶层）
 *   path: agent 视角相对路径（'assets/...'，session cwd 软链下直接可 Read / 引用）
 */
router.get('/:pid/artifacts', async (req, res, next) => {
  try {
    const project = guardProject(req, res);
    if (!project) return;

    // 结构迁移挂在这里而不是只挂在「发消息 / 上传」上：这是**打开项目必调**的
    // 那个接口，而迁移一旦晚于第一次渲染，用户会先看到一个叫 `tasks` 的文件夹
    // 套着他的文件夹。跑过之后是三次 stat 的事（幂等早退），不值得省。
    await ensureProjectWorkspace(req.params.pid);
    // 跟上 agent 在画布背后做的改名（挂在这让第一帧就对齐；无新 commit 时只一次 rev-parse）
    await reconcileBoardRenames(req.params.pid).catch(
      (err) => console.warn('[board] 改名对账失败:', err.message));
    await pruneDanglingBindings(req.params.pid).catch(() => {});   // 悬空线 30s 节流清扫（理由见 board-store）
    // 演出的老形状（根上的 stage/ + 角色/ …）收进一场戏的文件夹（09-05 晚；幂等，三次 stat 的事）
    await ensurePlays(req.params.pid).catch((err) => console.warn('[stage] 迁移失败:', err.message));

    const assetsDir = path.join(getSharedDir(req.params.pid), 'assets');
    const artifacts = [];

    /**
     * 任务目录里**不该被当成收纳文件夹**的那些子目录。
     *
     * 任务目录是有槽位约定的：构建产物在 dist/out/build/_site/public，站点试作在
     * _drafts/，便利贴在 notes/（它单独扫、有自己的形态）。这些都由各自的 kind
     * 解析器管，递归进去只会把构建中间物倒到画布上。
     */
    const NOT_A_FOLDER = new Set([
      'dist', 'out', 'build', '_site', 'public',   // 构建产物（site.js 的 OUTPUT_DIRS）
      '_drafts',                                    // 站点试作（各自是独立产物）
      'notes',                                      // 便利贴（单独扫成 note 形态）
      'node_modules',
      // 扁平化之后扫描根变成整个工作区，这两个是基础设施不是收纳文件夹：
      // assets/ 上面已经按 upload / generated / note 三种语义单独扫过一遍，
      // 不挡的话每张图会以两个不同的 path 上墙两次。
      'assets', 'exports',
    ]);

    /**
     * @param {number} depth 还能往下几层。收纳只做**一层** —— 再深就不是"收纳"
     *   而是目录树了，画布上表达不了，也不是用户要的东西。
     */
    // 工作区根的 relPrefix 是空串，`${prefix}/${name}` 会拼出 `/canvas.html`
    // 这种带头斜杠的路径 —— 它会一路当成物件 id 传到画布和 artifact-file 路由。
    const joinRel = (prefix, name) => (prefix ? `${prefix}/${name}` : name);

    const scanDir = async (dir, kind, relPrefix, depth = 0) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          // 收纳文件夹（2026-08-07）：agent 用 mkdir + mv 把同主题的东西归到
          // 一起，画布把它显示成一组。它是**真目录**，不是画布上的虚拟分组 ——
          // 「文件系统即真相」这条不能因为加了个分组就破。
          if (depth <= 0) continue;
          if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
          if (NOT_A_FOLDER.has(e.name)) continue;
          await scanDir(path.join(dir, e.name), kind, joinRel(relPrefix, e.name), depth - 1);
          continue;
        }
        if (!e.isFile()) continue;
        if (e.name.startsWith('.')) continue;
        // 兄弟 webp 不单独上墙（否则每张生成图都是重影，两张卡还指同一份 sidecar）。
        // 留 PNG：母版是产物，webp 是显示副本。见 lib/image-variant.js
        if (/\.webp$/i.test(e.name)
            && entries.some(x => x.isFile() && x.name === e.name.replace(/\.webp$/i, '.png'))) continue;
        // 基础设施不上墙（board.json 是画布自己的布局档、*.template.* 是起手模板）
        if (isReservedFile(e.name)) continue;
        const ext = path.extname(e.name).toLowerCase();
        // agent 正在写的时候文件可能在 readdir 和 stat 之间消失（重写 / 改名）。
        // 原来这里 stat 抛出会一路冒到路由 → 500 → 前端把画布清空。
        // 单个文件读不到就跳过它，不能因此让整份清单失败。
        let stat;
        try {
          stat = await fs.stat(path.join(dir, e.name));
        } catch { continue; }
        const item = {
          kind,
          name: e.name,
          path: joinRel(relPrefix, e.name),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          ext,
          isImage: IMAGE_EXTS.has(ext),
          isVideo: VIDEO_EXTS.has(ext),
          // 不再探盘：缩略图地址对任何 generated 图都一定能出图（artifact-file
          // 缺文件时回原图现编一张，见 lib/image-variant.js）。原来那次 exists()
          // 探的是 .thumb.jpg，改名成 .thumb.webp 之后它会对老图一律返 false，
          // 让产物墙退回去加载 3MB 原图 —— 正好是这轮要消灭的东西。
          hasThumb: kind === 'generated' && IMAGE_EXTS.has(ext),
        };
        decorateCardKind(item);
        // 语义元数据（generate-image.js 落 .meta/<base>.json sidecar：prompt /
        // assetRole / provider / aspectRatio / sessionId / runId）—— 物件不只是
        // 文件，带着它的来历上墙
        if (kind === 'generated') {
          try {
            const metaRaw = await fs.readFile(
              path.join(dir, '.meta', `${e.name.slice(0, -ext.length)}.json`), 'utf8');
            item.meta = JSON.parse(metaRaw);
          } catch { /* 无 sidecar（旧图）→ 无 meta */ }
        }
        // 便签/板书带正文、文本文件带 1KB 预览（完整内容都走 artifact-file；见 helpers）
        // ⚠️ upload 也要（2026-08-29）：用户上传的角色卡/世界卡就住在 用户内容/，
        // kind='upload' —— 原来只认 task-file，于是上传来的 json/md 卡面永远是空的
        // 细条。json 预览器做完才发现最常见的那一类 json 根本走不到这里。
        if (kind === 'note' && ext === '.md') await decorateNoteText(item, path.join(dir, e.name));
        else if ((kind === 'task-file' || kind === 'upload') && PREVIEW_EXTS.has(ext)) {
          await decorateFilePreview(item, path.join(dir, e.name));
        }
        artifacts.push(item);
      }
    };

    await scanDir(assetsDir, 'upload', 'assets');
    await scanDir(path.join(assetsDir, 'generated'), 'generated', 'assets/generated');
    await scanDir(path.join(assetsDir, 'notes'), 'note', 'assets/notes');

    // ── 项目产物（2026-08-07 扁平化）────────────────────────────────────
    //
    // 产物直接住工作区根，一个项目可以并排放**多个平等产物**：顶层每个 .html
    // 各是一份 deck、根 index.html = 一个站（子页和 style.css 不各自上墙）、
    // 无根站时带 index.html 的子目录各是一个站、_drafts/*.html 各是一个单页。
    // 没有主 / 试作等级。
    //
    // ── 文件夹枚举（2026-08-08）──────────────────────────────────────────
    //
    // 工作区就是一张桌面：产物可以摊在根上，也可以收进文件夹，文件夹还能套
    // 文件夹。所以解析器要**按文件夹跑**，一个文件夹一份 manifest。
    //
    // 字段名仍叫 `tasks`（前端的取数路径不用动），但语义已经是「文件夹」：
    // `id` 是**工作区相对路径**，根用 `''`。所有 id 都是路径，画布上的身份和
    // 磁盘上的位置是同一个字符串 —— 这样 agent `mv` 一个文件之后，git 的改名
    // 检测能直接翻译成画布 id 的改名（见 board-store 的 reconcileBoardRenames）。
    const workspaceRoot = getSharedDir(req.params.pid);
    const rootIgnore = await loadIgnore(workspaceRoot);
    const tasks = [];
    let hasRootSite = false;
    // 根站认领的一级子目录（pages 顶层段）—— 散文件过滤要用同一口径
    const rootSiteClaims = new Set();

    /** manifest 里的路径是相对**它那个目录**的，挂到工作区坐标系上要加前缀 */
    const under = (base, p) => (!p ? p : (base ? `${base}/${p}` : p));
    // 文件夹清单跟产物清单分开：**空文件夹也要出现在桌面上**（你刚建的那个
    // 还没往里放东西的文件夹，不该等有了产物才显形）
    const folders = [];

    const collect = async (dir, rel, depth) => {
      let stat;
      try { stat = await fs.stat(dir); } catch { return; }

      const manifest = await taskManifest(dir);
      const list = manifest?.artifacts || [];
      if (!rel) {
        const rs = list.find(a => a.kind === KIND_SITE && !a.single && !a.srcRoot);
        hasRootSite = !!rs;
        for (const pg of (rs?.pages || [])) {
          const seg = String(pg).split('/')[0];
          if (seg && seg !== pg) rootSiteClaims.add(seg);
        }
      }

      if (list.length) {
        tasks.push({
          id: rel,
          title: rel ? rel.split('/').pop() : (project.name || '产物'),
          kind: manifest.kind,
          sessionId: null,          // 产物与会话脱钩（2026-08-07）
          mtime: stat.mtime.toISOString(),
          exports: manifest.exportFormats || [],
          artifacts: list.map((a) => ({
            kind: a.kind,
            view: a.view,
            single: !!a.single,
            file: under(rel, a.file),        // deck / 单页：html 文件（相对工作区根）
            root: under(rel, a.root) || rel,
            srcRoot: under(rel, a.srcRoot),  // 站点源目录；root≠srcRoot = 构建型
            // entry 是**相对 base 的**，base + '/' + entry 必须永远拼得出真实路径。
            // 单页站点以前 base 给空、entry 给全路径，前端拿不到 base 就回退成
            // 文件夹名，拼出 `rin/rin/_drafts/…` 这种双前缀（实测 404）。
            // 现在单页也给 base（= 入口文件所在目录），两种站点一个拼法。
            entry: a.single ? path.basename(a.entryRel || '') : a.entry,
            entryRel: under(rel, a.entryRel),
            // word 的 token 源与成员表。⚠️ 都过 under()：manifest 给任务相对路径，前端要工作区相对，透传 404
            ...(a.sourceFile ? { sourceFile: under(rel, a.sourceFile) } : {}),
            ...(a.members ? { members: a.members.map(m => ({ ...m, file: under(rel, m.file), sourceFile: m.sourceFile ? under(rel, m.sourceFile) : null })) } : {}),
            base: a.single
              ? under(rel, path.dirname(a.entryRel || '.')).replace(/^\.$/, rel)
              : (under(rel, a.root) || rel),
            pages: a.pages,                  // 站点内部路径，相对站根，不加前缀
            title: a.title,
            exports: a.exportFormats,
            // 其余形态没有这个字段，前端按 kind 分支取用。
            nodes: a.nodes,
            truncated: a.truncated,   // 撞深度上限被截断的目录，要让人看见
            // 演出（09-05）：卡面要的在场者 / 拍数 / 皮肤（kinds/stage.js instanceManifest 给的）
            ...(a.stage ? { stage: a.stage } : {}),
          })),
        });
      }

      if (depth >= FOLDER_MAX_DEPTH) return;

      // 这个目录里，哪些子目录**已经被上面那份 manifest 认领**了。
      //
      // 一个站点目录既能被父目录扫成一件产物（`site:伊蕾娜手账研究站`），又能被
      // 当成一个文件夹递归进去 —— 不去重的话它在桌面上出现两次：一张站点卡 +
      // 一张同名文件夹卡，点哪个都对一半。认领了就跳过：**它是产物，不是容器**，
      // 里面的 `assets/` `pages/` 是这个站的内部结构，不是并列的文件夹。
      const claimed = new Set();
      for (const a of list) {
        for (const p of [a.root, a.srcRoot, a.file, a.entryRel]) {
          const seg = String(p || '').split('/')[0];
          if (seg && seg !== p) claimed.add(seg);       // 只有带下级路径的才算认领
          else if (seg && isDirArtifact(a)) claimed.add(seg);   // 顶层段整段认领：只有目录型产物有资格（判据问注册表）
        }
        // 根站（root='' srcRoot=''）：上面四个字段全切不出认领段，可它的 pages
        // 跨着子目录（'posts/chapter-1.html'）。那些子目录是站点内部结构，不是
        // 并列容器 —— 不认领的话它们会被递归成独立任务、页面被 deck 解析器
        // 再收编一遍，同一份文件在桌面上出现两个身份（站点页 + deck 卡），
        // 而且卡还打不开（实测 proj_mss59y9l_8ems，2026-08-14）。
        // 只在根站场景做：非根站的 root 目录本身已被认领，内部结构扫不到。
        if (a.kind === KIND_SITE && !a.single && !a.root && !a.srcRoot) {
          for (const pg of (a.pages || [])) {
            const seg = String(pg).split('/')[0];
            if (seg && seg !== pg) claimed.add(seg);
          }
        }
      }

      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        if (RESERVED_DIRS.has(e.name) || HARD_IGNORE_DIRS.has(e.name)) continue;
        if (e.name === DRAFTS_DIR) continue;      // 站点试作，由 site 解析器管
        // 构建目录不当独立站/收纳夹（site:dist 案）；递归也吃根 .ndignore（与页面清单同规则）
        if (OUTPUT_DIRS.includes(e.name) || rootIgnore(under(rel, e.name), true)) continue;
        if (claimed.has(e.name)) continue;        // 已经是一件产物了
        folders.push(under(rel, e.name));
        await collect(path.join(dir, e.name), under(rel, e.name), depth + 1);
      }
    };

    try {
      await collect(workspaceRoot, '', 0);
      // 散文件（agent 写的 .md、数据文件、脚本…）：**每个目录只平铺自己那一层**。
      //
      // `folders` 已经是递归全量（含嵌套），所以根扫一层 + 每个文件夹各扫一层
      // 正好覆盖一遍。之前根这里传的是 depth=1（自己递归下去一层），跟后面
      // 那个 folders 循环重叠 —— 文件夹里的每个文件都被吐两遍，实测一个项目
      // 24 条产物里 6 条重复，画布上就是一张卡叠着另一张同名卡。
      await scanDir(workspaceRoot, 'task-file', '', 0);
      await scanDir(path.join(workspaceRoot, 'notes'), 'note', 'notes');
      // 板书住 notes/板书/（不进 notes/ 顶层：便利贴注入只列顶层，板书另有自己的注入）
      await scanDir(path.join(workspaceRoot, CHALK_DIR), 'note', CHALK_DIR);
      for (const rel of folders) {
        // 用户上传的落点扫成 upload 而不是 task-file：来源轴（board-kinds.sourceOf）
        // 按 kind 分「我放的 / agent 做的」，落回 task-file 的话用户自己拖进来的图
        // 会被标成「agent 做的」。子目录仍按普通文件夹走。
        const kind = rel === USER_UPLOAD_DIR ? 'upload' : 'task-file';
        await scanDir(path.join(workspaceRoot, rel), kind, rel, 0);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // .html 不当普通文件卡上墙（deck / 站点物件已经代表它们了）。
    //
    // ⚠️ 这里曾写 `if (hasRootSite) return false` —— 根站一存在，**全工作区**
    // 任何文件夹里的散文件一律隐形。用户把便签搬进文件夹，卡当场凭空消失
    // （文件在磁盘上完好，2026-08-14 实案）。根站只吞**自己的地盘**：根层
    // 散文件（.md 除外 —— 那是阅读卡）+ 认领子目录（pages 顶层段）里的文件；
    // 别的文件夹照常上墙。口径与前端 resolveObjectId / exports 的根站规则一致。
    // word 认领的文件（.docx + token 源）不当散文件卡，同 .html 被产物卡代表一条规则（判据在 kinds/index.js）
    const docxClaims = docxClaimedFiles(tasks);
    const filtered = artifacts.filter((a) => {
      if (a.kind !== 'task-file') return true;
      if (docxClaims.has(String(a.path))) return false;
      if (hasRootSite) {
        const p = String(a.path);
        const slash = p.indexOf('/');
        const swallowed = slash < 0
          ? !p.toLowerCase().endsWith('.md')
          : rootSiteClaims.has(p.slice(0, slash));
        if (swallowed) return false;
      }
      return !a.name.toLowerCase().endsWith('.html');
    });

    // 剪掉画布上没有对应目录的文件夹 —— **但要等它连着两次都不在**。
    //
    // 跟物件不一样，文件夹有权威清单（`folders` 就是刚扫出来的磁盘真相），所以
    // 剪是可以剪的。物件那边不行：board.objects 是稀疏的，"不在 board 里"是常态。
    //
    // 但立刻剪是错的，而且是**破坏性**的：这个接口在一轮对话中途会被反复调用
    // （每次 listVersion 跳动），而 agent 的 `mv 稿件 定稿` 要到 turn 结束才进
    // git。中间那次扫描一看「稿件」没了就删，而 patchBoard 的端点级联会把连着
    // 这个文件夹的关系线一起删掉 —— 等 turn 结束、对账把里面的物件改好名时，
    // 文件夹的位置、标题、连线已经没了，找不回来。
    //
    // 两道闸：① 正在改名窗口里的（转发表里有）一律不碰 ② 连续两次扫描都不在
    // 才算真没了。改名、临时 mv、agent 写到一半，都活不过第二次判定。
    const live = new Set(folders);
    const board = await readBoard(req.params.pid);
    const suspects = Object.keys(board.zones || {}).filter(z => !live.has(z));
    const deadZones = confirmDeadZones(req.params.pid, suspects, live);
    if (deadZones.length) {
      await patchBoard(req.params.pid, {
        zones: Object.fromEntries(deadZones.map(z => [z, null])),
      });
      console.log(`[board] ${req.params.pid} 清掉 ${deadZones.length} 个没有目录撑着的文件夹: ${deadZones.slice(0, 3).join(', ')}`);
    }

    filtered.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    // 自动落线对账（2026-08-14）：manifests 正好在手，顺手把「html 真实引用
    // 了哪些素材」落成 by:'auto' 的 ref 边。fire-and-forget + 30s 节流，
    // 绝不拖累清单接口。详见 lib/auto-relations.js 头注。
    reconcileAutoRefsThrottled(req.params.pid, workspaceRoot, tasks);
    res.json({ artifacts: filtered, tasks, folders });
  } catch (err) { next(err); }
});

/**
 * GET /:pid/cover — 项目封面 webp（首页卡片缩略图）
 *
 * 服务端截最新产物的图（见 lib/cover.js 里为什么不是 iframe）。缓存按源 mtime，
 * 命中就是读盘；没命中要起一次 chromium，串行排队，冷启动 1-3s。
 * 没产物 / 截图环境不可用 → 204，前端画占位框（不是错误，别报 500）。
 */
// .docx 页图（画布缩略图 + 产物窗翻页共用一份缓存）。实现在 assets/docx-page.js —— 
router.get('/:pid/docx-page', makeDocxPageHandler({ getSharedDir, guardProject }));
router.get('/:pid/docx-pdf', makeDocxPdfHandler({ getSharedDir, guardProject }));   // 整份 PDF，同一份缓存

router.get('/:pid/cover', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    let result;
    try {
      result = await getProjectCover(req.params.pid, getSharedDir(req.params.pid));
    } catch (err) {
      console.warn('[cover] render failed:', err.message);
      return res.status(204).end();
    }
    if (!result) return res.status(204).end();
    if (req.headers['if-none-match'] === `"${result.etag}"`) return res.status(304).end();
    res.set('ETag', `"${result.etag}"`);
    res.set('Cache-Control', 'private, max-age=60');
    res.type('image/webp').send(result.buffer);
  } catch (err) { next(err); }
});


/**
 * GET /:pid/artifact-file/*subPath — project 级文件服务（shared/assets 子树）。
 * 工作台缩略图 / 大图用，不依赖 session（canvas.js 的同款路由是 session 级的）。
 * 防 traversal 同 canvas.js：resolve 后必须留在 shared/assets 下。
 */
/**
 * DELETE /:pid/folders/*subPath —— 删一个文件夹（连同里面的一切）。
 *
 * 取代旧的 `DELETE /:pid/tasks/:name`。那条做三件事：删任务目录、**连带删掉
 * 绑定的那次对话**、清 board.json 里的 zone 行。中间那件随「任务=会话」一起
 * 废了 —— 会话现在归项目，跟任何文件夹都没有绑定关系，删文件夹不该动对话。
 *
 * 路径按**工作区相对路径**收（`稿件/初稿`），因为文件夹可以嵌套。
 */
/**
 * POST /:pid/folders —— 新建文件夹（`{ parent?: '稿件', name?: '初稿' }`）。
 *
 * 在这之前**用户建不了文件夹**：全仓没有任何接口或按钮，只有 agent `mkdir`
 * 会让画布上多出一个。也就是说这套收纳体系对用户是只读的 —— 能收起、能搬走、
 * 能删掉，就是不能建。桌面隐喻里这说不通。
 *
 * 重名自动加序号（「新建文件夹 2」），跟操作系统一样 —— 报错让人再想个名字
 * 是没必要的摩擦，这里没有任何东西会被覆盖。
 */
router.post('/:pid/folders', express.json(), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const root = getSharedDir(req.params.pid);
    const parent = String(req.body?.parent ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const wanted = sanitizeFilename(req.body?.name || '新建文件夹').replace(/\.+$/, '') || '新建文件夹';

    const parentAbs = parent ? path.resolve(root, parent) : root;
    if (parentAbs !== root && !parentAbs.startsWith(root + path.sep)) {
      return res.status(400).json({ error: 'path escapes workspace' });
    }
    if (parent && (RESERVED_DIRS.has(parent.split('/')[0]) || parent.startsWith('.'))) {
      return res.status(400).json({ error: '不能在这个目录里新建' });
    }
    if (!(await fs.stat(parentAbs).catch(() => null))?.isDirectory()) {
      return res.status(404).json({ error: 'parent folder not found' });
    }
    if (parent.split('/').filter(Boolean).length >= FOLDER_MAX_DEPTH) {
      return res.status(400).json({ error: `文件夹最多套 ${FOLDER_MAX_DEPTH} 层` });
    }

    let name = wanted;
    for (let n = 2; await exists(path.join(parentAbs, name)); n += 1) name = `${wanted} ${n}`;
    await fs.mkdir(path.join(parentAbs, name));
    res.status(201).json({ ok: true, folder: parent ? `${parent}/${name}` : name });
  } catch (err) { next(err); }
});

/**
 * POST /:pid/move —— 把一个东西搬到另一个文件夹里（**真的动磁盘**）。
 *
 * body: `{ from: '稿件/主稿.html', to: '定稿' }`（to='' = 搬到工作区根）
 *
 * 这是「拖进文件夹 = 真 mv」那条交互的落点。语义按操作系统桌面走：画布上
 * 在哪，磁盘上就在哪，永远一致。代价是**移动 = 换身份**（id 就是路径），
 * 所以这一步的顺序不能错：
 *
 *   ① fs.rename          先动磁盘。失败就整个失败，画布一个字节不改
 *   ② renameBoardPaths   同一个请求内改画布身份（物件 / 文件夹 / 归属字段 /
 *                        关系线端点），顺带在转发表里记一笔
 *   ③ 带着新 board 响应   前端拿到就重写 layoutRef —— 不给的话它手上还是旧 id，
 *                        800ms 后那一发防抖 flush 会把旧条目写回来
 *   ④ 同步 commit         对账器稍后会看到这次改名并重放一遍；因为 ② 已经做完，
 *                        重放是个空操作（幂等）。不 commit 的话它下次算 diff
 *                        时才看到，中间任何一次扫描都可能把旧文件夹当死的剪掉
 */
router.post('/:pid/move', express.json(), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    // 语义（NO_MOVE_OUT 白名单史 / 产物目录不透明规则 / ①②③④ 顺序）全部住在
    // moveEntry —— 2026-08-14 抽成唯一实现，agent 的 organize_board 共用同一份
    const out = await moveEntry(req.params.pid, req.body?.from, req.body?.to);
    res.json(out);                                                            // ③
    if (out.moved) {
      // 板上动静（2026-08-29 刀 4）：用户搬了文件，agent 下次摸板前该知道
      try { noteBoardDirty(req.params.pid, [{ kind: 'mv', id: out.from, to: out.to }]); } catch { /* 记不上不挡搬家 */ }
      // ④ 响应之后再 commit：它只服务于稍后的对账，不该让用户多等一次 git add
      commitWorkspace(req.params.pid, null, `move: ${out.from} → ${out.to}`, { author: 'user' })
        .catch(err => console.warn('[git] move commit failed:', err.message));
    }
  } catch (err) {
    if (err instanceof MoveError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * POST /:pid/rename —— 给一个东西改名（**真的动磁盘**，位置不变只换最后一段）。
 *
 * body: `{ from: '稿件/主稿.html', name: '定稿' }`
 *
 * 跟 `/move` 是一对：move 换爹，rename 换名字。在这之前**画布上没有任何改名
 * 入口** —— 三层传播的机器（renameBoardPaths / git 对账 / 转发表）08-08 就造好
 * 了，缺的只是这扇门，于是文件夹只能叫「新建文件夹」，或者让 agent 去 mv。
 *
 * 扩展名归系统管：改 `主稿.html` 时用户输入的是「定稿」，我们补回 `.html`。
 * 让用户自己带扩展名的话，删掉它就等于把一份 deck 变成一个普通文件。
 */
router.post('/:pid/rename', express.json(), async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const root = getSharedDir(req.params.pid);
    const from = String(req.body?.from ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!from) return res.status(400).json({ error: 'from required' });

    const absFrom = path.resolve(root, from);
    if (!absFrom.startsWith(root + path.sep)) {
      return res.status(400).json({ error: 'path escapes workspace' });
    }
    const seg0 = from.split('/')[0];
    if (RESERVED_DIRS.has(seg0) || seg0.startsWith('.')) {
      return res.status(400).json({ error: '这个位置的东西不参与改名' });
    }
    const st = await fs.stat(absFrom).catch(() => null);
    if (!st) return res.status(404).json({ error: 'source not found' });

    const oldBase = path.basename(from);
    const ext = st.isDirectory() ? '' : (path.extname(oldBase) || '');
    // 用户输入里带的扩展名剥掉，最后统一补回原来那个
    const wanted = sanitizeFilename(String(req.body?.name ?? ''))
      .replace(new RegExp(`${ext.replace('.', '\\.')}$`, 'i'), '')
      .replace(/\.+$/, '')
      .trim();
    if (!wanted) return res.status(400).json({ error: '名字不能为空' });

    const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const nextRel = (parent ? `${parent}/` : '') + wanted + ext;
    if (nextRel === from) return res.json({ ok: true, from, to: from, renamed: false });
    if (await exists(path.resolve(root, nextRel))) {
      return res.status(409).json({ error: `「${wanted}${ext}」已经有一个了` });
    }

    // 顺序同 /move：先动磁盘，再改画布身份（物件 / 文件夹 / 归属 / 关系线端点）
    await fs.rename(absFrom, path.resolve(root, nextRel));
    const { board } = await renameBoardPaths(req.params.pid, [[from, nextRel]]);
    res.json({ ok: true, from, to: nextRel, renamed: true, board });
    commitWorkspace(req.params.pid, null, `rename: ${from} → ${nextRel}`, { author: 'user' })
      .catch(err => console.warn('[git] rename commit failed:', err.message));
  } catch (err) { next(err); }
});

router.delete('/:pid/folders/*subPath', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const raw = req.params.subPath;
    const rel = (Array.isArray(raw) ? raw.join('/') : (raw || '')).replace(/\/+$/, '');
    if (!rel) return res.status(400).json({ error: 'folder path required' });

    const root = getSharedDir(req.params.pid);
    const dir = path.resolve(root, rel);
    // 防越界 + 防把工作区自己删了；保留目录一概不许删（.claude 里是项目指引和
    // 记忆，.nd 是各次对话的暗档案，.git 是历史 —— 都不是"用户的文件夹"）
    if (dir !== path.join(root, rel) || !dir.startsWith(root + path.sep)) {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (RESERVED_DIRS.has(rel.split('/')[0])) {
      return res.status(400).json({ error: 'reserved directory' });
    }
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return res.status(404).json({ error: 'folder not found' });

    // 是个正在演的故事就先停进程、摘运行时（09-06）：不然文件夹没了它还活着，下一句话把 场景/ 重新长出来
    try { if (await dropStage(req.params.pid, rel, 'folder-deleted')) console.log(`[assets] ${req.params.pid}/${rel} 删除：演出进程已停`); } catch { /* 不是故事 */ }
    await fs.rm(dir, { recursive: true, force: true });

    // board.json 跟着剪：这个文件夹自己的那行，以及住在它里面的全部物件。
    // 不剪的话磁盘上没了、画布上还在，就是 2026-07-30 那批「删不掉的僵尸
    // 文件夹」的来源 —— 删除必须是一个动作，不能指望前端补第二刀。
    const board = await readBoard(req.params.pid);
    const patch = { zones: { [rel]: null }, objects: {} };
    const under = `${rel}/`;
    for (const id of Object.keys(board?.objects || {})) {
      const p = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
      if (p === rel || p.startsWith(under)) patch.objects[id] = null;
    }
    for (const zid of Object.keys(board?.zones || {})) {
      if (zid.startsWith(under)) patch.zones[zid] = null;      // 嵌套在里面的子文件夹
    }
    await patchBoard(req.params.pid, patch);

    res.json({ ok: true, removed: rel, objects: Object.keys(patch.objects).length });
  } catch (err) { next(err); }
});

router.get('/:pid/artifact-file/*subPath', async (req, res, next) => {
  try {
    // ⚠️ Cache-Control 必须先设、且错误路径也要带（2026-07-29 SPiCa 裸奔事故）：
    // Cloudflare 对 .css/.js/.png 等扩展名按后缀边缘缓存，源站 `no-cache` 会被
    // 改写成浏览器 max-age=14400（4 小时），**404 响应同样被缓存 4 小时** ——
    // agent 先写 index.html 后写 style.css 的间隙里用户加载一次，浏览器就把
    // "css 404" 缓存 4 小时，之后怎么刷新都裸奔。实测 `no-store` / `private`
    // 会让 CF 判为 DYNAMIC 原样透传（同路由的 .html 就是这么幸免的）。
    // 所以：默认 no-store 兜底一切错误路径，成功路径按类型再覆盖。
    res.setHeader('Cache-Control', 'no-store');
    if (!guardProject(req, res)) return;

    // 路径判据（`tasks/` 兼容、越界、点目录白名单）抽在 lib/artifact-file-path.js ——
    // 那是安全判据，住在路由里没法单测，而且它有一条错在那儿修了（见文件头）
    const resolved = await resolveArtifactFile(getSharedDir(req.params.pid), req.params.subPath);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { sharedRoot, absPath, subPath } = resolved;

    let stat;
    let servePath = absPath;
    // 缩略图地址缺文件时回原图现编一张（老图 / 生成失败 / 07-31 前的 .thumb.jpg）。
    // 产物墙的缩略图走的就是这条路由，跟 canvas 那条 session assets 路由同一份兜底。
    let servedOriginalForThumb = false;
    try {
      stat = await fs.stat(servePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // ① 改名转发（#4）：开着的窗拿的还是旧路径 —— 重命名、拖进文件夹、
      // agent mv 之后，产物窗/图片卡的 URL 都指着旧地址。转发表（board-store）
      // 记着最近几分钟的改名，按最长前缀换掉重试一次。安全检查跟主路径同款：
      // 转发目标同样不许越界、不许摸基础设施目录。
      const fwd = forwardPath(req.params.pid, subPath);
      if (fwd !== subPath) {
        const absFwd = path.resolve(sharedRoot, fwd);
        // 判据跟主路径**同一份**（lib/artifact-file-path.js）—— 这儿原来自己抄了一遍
        // 越界检查和 DOT_OK 白名单，抄第二遍就是等着哪天改一处漏一处
        if (isServablePath(sharedRoot, absFwd)) {
          try { stat = await fs.stat(absFwd); servePath = absFwd; } catch { /* ② 继续走缩略图兜底 */ }
        }
      }
      // ② 缩略图兜底
      if (!stat) {
        const original = isThumbPath(servePath) ? await findOriginalForThumbnail(servePath) : null;
        if (!original) return res.status(404).json({ error: 'file not found' });
        servePath = original;
        stat = await fs.stat(original);
        servedOriginalForThumb = true;
      }
    }
    // 目录 → 找 index.html（站点常见的 `href="about/"` 写法；deck 场景用不到但无害）
    if (stat.isDirectory()) {
      const indexPath = path.join(servePath, ENTRY_FILE[KIND_SITE]);
      try {
        const s = await fs.stat(indexPath);
        if (s.isFile()) { servePath = indexPath; stat = s; }
      } catch { /* 没有 index.html 就按下面的 not a file 处理 */ }
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });

    const ext = path.extname(servePath).toLowerCase();
    // 站点在编辑中要看到最新的那一份：html/css/js 一律 no-store —— no-cache 不够，
    // CF 会对这些扩展名边缘缓存 + 把浏览器 TTL 改写成 4 小时（见路由入口注释）。
    // 图片按 URL 有没有版本标记决定能缓多久（见 imageCacheControl）。
    // `?nd=raw` = 原样发，不走显示改写层（srcset/sizes/lazy 注入 + 派生图）。
    // 感知通道带它 —— 为什么必须带见 mcp/tools/helpers/perception-page.js 的
    // artifactFileUrl 注释（注入的 sizes 会把横向溢出藏起来，而发布出去的站点没有
    // 这层注入，agent 的眼睛该看交付物）。用户预览照旧走改写层。
    // `?nd=raw` 给主文档；`X-ND-Raw` 头给它的**子资源**（img/css/js 的请求上没有
    // query 可挂，感知 context 用 extraHTTPHeaders 一次性盖住整页）。
    const rawRequested = req.query?.nd === 'raw' || req.headers['x-nd-raw'] === '1';

    const editable = ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.js';
    res.setHeader('Cache-Control', editable ? 'no-store' : imageCacheControl(req));

    // 这条路由是站点窗的图片入口：站点页面里的 <img src="assets/x.png"> 全打这儿。
    // deck 那条 thumbnail 重写只作用于 GET /canvas，站点从来没享受过，于是一页
    // 三张生图就是 5MB 起。显示一律发派生图（原图只留给导出）后降 ~90%。
    // 尺寸由 ?w= 决定（srcset 注入产生），不传就是原尺寸：站点按真实设备宽取景，
    // 服务端自作主张缩会让桌面糊。
    if (IMAGE_EXTS.has(ext) && !rawRequested) {
      return sendImage(req, res, servePath, stat, {
        fallbackMime: ARTIFACT_MIME[ext] || 'application/octet-stream',
        maxDim: servedOriginalForThumb ? THUMBNAIL_MAX_DIM : null,
        quality: servedOriginalForThumb ? THUMBNAIL_QUALITY : undefined,
      });
    }

    // 视频：Range + 派生档。以前这条路由对视频是整个文件一次性 res.end，
    // 没有 206 浏览器拖不动进度条（见 lib/video-variant.js）。
    if (isVideo(ext)) {
      return sendVideo(req, res, servePath, stat, {
        fallbackMime: ARTIFACT_MIME[ext] || 'application/octet-stream',
      });
    }

    // 站点页面：注入 srcset 让浏览器按视口挑尺寸。只加属性不动 DOM 结构，
    // 理由见 lib/html-srcset.js（<picture> 会改盒模型，站点布局是 agent 写的）。
    if ((ext === '.html' || ext === '.htm') && !rawRequested) {
      let html = await fs.readFile(servePath, 'utf8');
      try {
        html = await injectSrcset(html, path.dirname(servePath), sharedRoot);
      } catch (err) {
        console.warn('[artifact-file] srcset inject failed:', err.message);
      }
      const body = Buffer.from(html, 'utf8');
      res.setHeader('Content-Type', ARTIFACT_MIME[ext]);
      res.setHeader('Content-Length', body.length);
      return res.end(body);
    }

    res.setHeader('Content-Type', ARTIFACT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.end(await fs.readFile(servePath));
  } catch (err) { next(err); }
});

// 便签增删改（assets/notes.js）——自成一体，不跟这里其余路由共享状态
mountNotesRoutes({ router, guardProject, getSharedDir, ensureProjectWorkspace, sanitizeFilename });

export default router;
