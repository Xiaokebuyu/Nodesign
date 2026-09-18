/**
 * api/exports/handoff.js — 旧的「工程交付包」打包逻辑（2026-08-17 从 exports.js 拆出）
 *
 * ⚠️ **这是旧口径，正在被 exports/cards.js 那条替换。** 它的已知毛病：
 *   - `design/assets/` 把整个项目级 `shared/assets` 递归打包（最大的项目 280MB，
 *     会把别的任务的图一起交出去）
 *   - `prompt.txt` 恒空、`chat-history.json` 只有 runId 列表
 *   - `spec.json` 是 agent 私域档案却进包，而真决策（notes/决策.md）反而没进
 *   - README 是静态模板，不讲怎么跑 / 依赖 / 改哪里
 *
 * 拆出来是为了两件事：exports.js 贴着行数棘轮上限；以及把「待退役的那一坨」
 * 圈在一个文件里，退役时整份删掉即可，不用在大文件里挑。
 * MCP 工具 `export_handoff` 还在用它，退役要连那条一起换。
 */

import path from 'path';
import { promises as fs } from 'fs';
import JSZip from 'jszip';
import { walkTaskFiles, loadIgnore } from '../../lib/task-scan.js';
import { KIND_SITE } from '../../lib/artifact-target.js';
import { bundleOutsideMedia } from '../../lib/outside-media.js';

/**
 * 共享 handoff 打包逻辑 —— HTTP 路由 + MCP tool（export_handoff）共用。
 *
 * @param {string} sessionRoot  sessions/<sid>/ 绝对路径（canvas/spec 在这）
 * @param {string} sharedRoot   shared/ 绝对路径（assets 在这）
 */
export async function buildHandoffZip(sessionRoot, sharedRoot, { projectId, projectName, skillId, sessionId, runs = [], deckPath = 'canvas.html', kind = null } = {}) {
  const zip = new JSZip();
  const isSite = kind === KIND_SITE;

  if (isSite) {
    // 站点：产物根整个进 design/，保留文件名与子目录 —— 只留入口页并改名叫
    // canvas.html 的话，子页和 style.css 全丢，页间相对链接必然断。
    // dirname(入口) 就是产物根（手写 = 任务根，构建型 = dist/）；忽略规则
    // 从任务根读（.ndignore 住那），试作 `_drafts/` 不进交付包。
    const artifactDirAbs = path.dirname(path.resolve(sessionRoot, deckPath));
    // 忽略规则（.ndignore）住工作区根；构建型站点的产物根是 dist/，
    // 规则却写在源那边，所以这两个目录必须分开取
    const taskRootAbs = path.resolve(sessionRoot);
    const siteFiles = await walkTaskFiles(artifactDirAbs, {
      maxDepth: 6,
      ignore: await loadIgnore(taskRootAbs),
      ignoreBase: taskRootAbs,
    });
    // 树外素材（09-18：拖出 assets/ 的生成图）收进 design/assets/_ws/，页面引用改到包内（lib/outside-media.js）
    const siteRoot = path.relative(taskRootAbs, artifactDirAbs).split(path.sep).join('/');
    const outside = new Map();
    for (const f of siteFiles) {
      try {
        if (/\.(html?|css)$/i.test(f.rel)) {
          const b = bundleOutsideMedia(await fs.readFile(f.abs, 'utf8'), {
            ext: path.extname(f.rel).slice(1).toLowerCase(), pageRel: siteRoot ? `${siteRoot}/${f.rel}` : f.rel, siteRoot, root: taskRootAbs,
          });
          for (const x of b.files) outside.set(x.wsRel, x.bundleRel);
          zip.file(`design/${f.rel}`, b.text);
        } else zip.file(`design/${f.rel}`, await fs.readFile(f.abs));
      } catch { /* 中途被删就跳过 */ }
    }
    for (const [wsRel, bundleRel] of outside) {
      try { zip.file(`design/${bundleRel}`, await fs.readFile(path.join(taskRootAbs, ...wsRel.split('/')))); } catch { /* 同上 */ }
    }
    // 站内 html/css 的 `../../assets/` 归一（zip 布局是 design/<页面> + design/assets/）
    for (const rel of Object.keys(zip.files)) {
      if (zip.files[rel].dir || !/\.(html?|css)$/i.test(rel)) continue;
      const depth = rel.split('/').length - 2;             // design/ 之下还有几层
      const up = '../'.repeat(Math.max(0, depth));
      const text = await zip.files[rel].async('string');
      zip.file(rel, text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    }
  } else {
    try {
      // deckPath 相对 sessionRoot（任务模型下是 tasks/<任务>/canvas.html）
      const raw = await fs.readFile(path.resolve(sessionRoot, deckPath), 'utf8');
      // zip 里的布局是 design/canvas.html + design/assets/…，而任务 deck 写的是
      // `../../assets/generated/x.png`（相对它在 workspace 里的位置）—— 不改写的话
      // 解压出来图全裂。统一压成 `assets/…`。
      const html = raw.replace(/(["'(])(?:\.\.\/)+assets\//g, '$1assets/');
      zip.file('design/canvas.html', html);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      zip.file('design/canvas.html', '<!-- canvas.html not yet generated -->');
    }
  }

  try {
    const spec = await fs.readFile(path.join(sessionRoot, 'spec.json'), 'utf8');
    zip.file('design/spec.json', spec);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // assets 来自 shared/（跨 session 共享）—— 递归走子目录，
  // 主要是 assets/generated/（generate_image MCP 落档处）必须进 zip，
  // 否则 canvas.html 里的 <img src="assets/generated/..."> 在打开导出时全 404。
  const assetsDir = path.join(sharedRoot, 'assets');
  await zipDirRecursive(zip, assetsDir, 'design/assets');

  const chatHistory = (runs || []).map((row) => ({ runId: row.id }));
  zip.file('chat-history.json', JSON.stringify({ projectId, sessionId, runs: chatHistory }, null, 2));

  zip.file('prompt.txt', '');
  zip.file('README.md', renderReadme({ id: projectId, name: projectName, skillId, sessionId, kind }));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * 递归把 srcDir 下所有文件加进 zip（保留相对路径），dst 是 zip 内根前缀。
 * srcDir 不存在时静默 noop（fail-soft）。子目录中的 dotfile / 软链按需可扩展。
 */
async function zipDirRecursive(zip, srcDir, dstPrefix, { skipDotfiles = false } = {}) {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (skipDotfiles && e.name.startsWith('.')) continue;
    const srcAbs = path.join(srcDir, e.name);
    const dstRel = `${dstPrefix}/${e.name}`;
    if (e.isDirectory()) {
      await zipDirRecursive(zip, srcAbs, dstRel, { skipDotfiles });
      continue;
    }
    if (!e.isFile()) continue;  // 跳软链 / fifo 等
    const buf = await fs.readFile(srcAbs);
    zip.file(dstRel, buf);
  }
}

function renderReadme(project) {
  return `# ${project.name}

NoDesign 工程交付包。

## 文件结构

${project.kind === 'site' ? `- \`design/\` — 站点全部文件（保留原目录结构与文件名）
- \`design/${'index.html'}\` — 入口页
- \`design/assets/\` — 站点引用到的项目素材` : `- \`design/canvas.html\` — 单文件 self-contained HTML，主产物
- \`design/assets/\` — 项目共享素材`}
- \`design/spec.json\` — 设计意图档案（agent 私域记忆）
- \`chat-history.json\` — runs 摘要
- \`prompt.txt\` — 占位

## 怎么用

${project.kind === 'site' ? `把 \`design/\` 整个目录当站点根目录发布（任何静态托管都行），或者直接双击
\`design/index.html\` 在本地浏览 —— 页面之间是相对链接，不依赖服务器。` : `直接在浏览器打开 \`design/canvas.html\` 看 deck。
导出 PDF：用浏览器打印（${'${DECK.width}'}×${'${DECK.height}'} 视口最佳）。`}

---
导出时间：${new Date().toISOString()}
项目 ID：${project.id}
Session ID：${project.sessionId}
Skill：${project.skillId}
`;
}
