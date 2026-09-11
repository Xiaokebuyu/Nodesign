/**
 * 把一个真实项目清成「新手示例模板」（2026-09-12）。
 *
 *   node server/scripts/build-sample-project.mjs [源 shared 目录] [输出目录]
 *
 * 默认源是生产上的雾岭咖啡（`proj_mtx1gt4r_vj1h`），输出 `server/onboarding/sample/`。
 * 输出目录会被**整个重建**，所以别往里手工放东西 —— 要改就改这个脚本。
 *
 * ## 为什么要有这么一道
 *
 * 新用户第一次进来时会拿到这份模板的一份副本（server/onboarding/seed.js）。
 * 直接拷贝原项目有三个问题，每一个都只能在这儿一次性解决：
 *
 * 1. ⛔ **会话不能带**：转录里有 1100+ 处本机绝对路径、站主的账号 id 和个人邮箱
 *    （每轮注入的 userEmail 块）。所以 `.nd/`（会话私有目录）整个不要，板书和记忆
 *    frontmatter 里的 `session:` / `originSessionId` 也抹掉。
 * 2. **9MB 的原图不该进安装包**：桌面版每个用户都要下载它。原图转 webp（保留透明）、
 *    最长边压到 1600，引用跟着改 —— board.json 的 key 就是路径，改名要顺着 key、
 *    bindings 和正文一起改，漏一处就是画布上一张裂图。
 * 3. **画布上有 4 张指向空文件的卡**（`品牌手册/_t1..4.json`，issue iss_mtx1v74x_9p5v）：
 *    示例里不能留，新人第一眼看到的就是坏卡。
 *
 * 工作区家具（CLAUDE.md / .claude / .gitignore / git 仓库）不进模板：
 * 那些是 ensureProjectWorkspace 建项目时自己写的，模板里再放一份只会两边打架。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const sharp = require(path.join(REPO, 'node_modules/sharp'));

const SRC = process.argv[2]
  || '/home/wangang-dev/projects/Nodesign/server/projects-data/proj_mtx1gt4r_vj1h/shared';
const OUT = process.argv[3] || path.join(REPO, 'server/onboarding/sample');

/** 不进模板的（会话痕迹 / 工作区家具 / 临时件） */
const SKIP = new Set(['.git', '.nd', '.claude', '.gitignore', 'CLAUDE.md', 'pending-changes.json']);
/** 图片压到最长边这么大（画布卡最宽 960，双倍屏也够） */
const MAX_EDGE = 1600;
/** 正文里要改引用的文本文件 */
const TEXT_EXT = new Set(['.md', '.json', '.html', '.css', '.js', '.txt']);

const isImage = (f) => /\.(png|jpe?g)$/i.test(f);

async function copyTree(src, out, rel = '') {
  const entries = await fs.readdir(src, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(out, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      files.push(...await copyTree(from, to, r));
    } else {
      await fs.copyFile(from, to);
      files.push(r);
    }
  }
  return files;
}

/** 原图转 webp（保留透明），返回 { 旧相对路径: 新相对路径 } */
async function toWebp(out, files) {
  const renames = {};
  for (const rel of files) {
    if (!isImage(rel)) continue;
    const abs = path.join(out, rel);
    const next = rel.replace(/\.(png|jpe?g)$/i, '.webp');
    const meta = await sharp(abs).metadata();
    const resize = Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE
      ? { width: meta.width >= meta.height ? MAX_EDGE : null, height: meta.height > meta.width ? MAX_EDGE : null }
      : null;
    let img = sharp(abs);
    if (resize) img = img.resize(resize);
    await img.webp({ quality: 82 }).toFile(path.join(out, next) + '.tmp');
    await fs.rm(abs);
    await fs.rename(path.join(out, next) + '.tmp', path.join(out, next));
    renames[rel] = next;
  }
  return renames;
}

/** 板书 / 记忆 frontmatter 里的会话编号，以及生图元数据里的 sessionId / runId */
function stripSessionIds(text, ext) {
  if (ext === '.json') {
    try {
      const j = JSON.parse(text);
      let touched = false;
      for (const k of ['sessionId', 'runId', 'originSessionId', 'session']) {
        if (k in j) { delete j[k]; touched = true; }
      }
      return touched ? `${JSON.stringify(j, null, 2)}\n` : text;
    } catch { return text; }
  }
  // ⚠️ 允许前导空格：记忆文件里 originSessionId 缩在 metadata 下面两格，
  // 只钉行首的话会漏（09-12 第一版就漏了，靠下面 audit 那道自查拦住的）
  return text
    .replace(/^[ \t]*(?:session|originSessionId):[ \t]*\S+[ \t]*\r?\n/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}

async function rewriteText(out, files, renames) {
  const pairs = Object.entries(renames);
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const abs = path.join(out, rel);
    let text;
    try { text = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const before = text;
    for (const [from, to] of pairs) {
      text = text.split(from).join(to);
      text = text.split(path.basename(from)).join(path.basename(to));
    }
    text = stripSessionIds(text, ext);
    if (text !== before) await fs.writeFile(abs, text);
  }
}

/** 画布：删掉指向不存在文件的卡，以及连着它们的线 */
async function pruneBoard(out) {
  const p = path.join(out, 'board.json');
  const board = JSON.parse(await fs.readFile(p, 'utf8'));
  const dropped = [];
  for (const id of Object.keys(board.objects || {})) {
    // `type:name` 这种是产物卡（站点 / docx / 演出），不是盘上的路径
    if (/^[a-z]+:/.test(id)) continue;
    if (!(await fs.stat(path.join(out, id)).catch(() => null))) {
      delete board.objects[id];
      dropped.push(id);
    }
  }
  for (const [bid, b] of Object.entries(board.bindings || {})) {
    if (dropped.includes(b.from) || dropped.includes(b.to)) delete board.bindings[bid];
  }
  await fs.writeFile(p, `${JSON.stringify(board, null, 2)}\n`);
  return dropped;
}

/** 自查：模板里不许再出现这些 */
async function audit(out, files) {
  const bad = [];
  const patterns = [
    [/\/home\/[a-z0-9_-]+/i, '本机绝对路径'],
    [/u_[a-z0-9]{8}_[a-z0-9]{5}/i, '用户 id'],
    [/[\w.+-]+@(?!mistridge\.coffee)[\w-]+\.[\w.]+/, '邮箱'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, '会话 UUID'],
    [/sk-[a-z0-9-]{12,}/i, '疑似密钥'],
  ];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text;
    try { text = await fs.readFile(path.join(out, rel), 'utf8'); } catch { continue; }
    for (const [re, what] of patterns) {
      const m = text.match(re);
      if (m) bad.push(`${rel}: ${what} → ${m[0].slice(0, 60)}`);
    }
  }
  return bad;
}

async function size(dir) {
  let total = 0; let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = await size(p); total += s.total; n += s.n; }
    else { total += (await fs.stat(p)).size; n += 1; }
  }
  return { total, n };
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
const copied = await copyTree(SRC, OUT);
const renames = await toWebp(OUT, copied);
const after = copied.map((f) => renames[f] || f);
await rewriteText(OUT, after, renames);
const dropped = await pruneBoard(OUT);
const bad = await audit(OUT, after);
const { total, n } = await size(OUT);

console.log(`源：${SRC}`);
console.log(`出：${OUT}`);
console.log(`文件 ${n} 个，共 ${(total / 1024 / 1024).toFixed(2)} MB`);
console.log(`转 webp ${Object.keys(renames).length} 张：`, Object.entries(renames).map(([a, b]) => `${path.basename(a)} → ${path.basename(b)}`).join(', ') || '（无）');
console.log(`画布删掉的坏卡 ${dropped.length} 张：`, dropped.join(', ') || '（无）');
if (bad.length) {
  console.log('\n⛔ 自查没过，这些东西不该留在模板里：');
  for (const b of bad) console.log('  ', b);
  process.exit(1);
}
console.log('自查通过：没有本机路径 / 用户 id / 邮箱 / 会话编号 / 密钥');
