/**
 * server/api/exports/build-standalone.js
 *
 * 把 hybrid canvas.html 打包成"自包含离线 HTML"——CDN 全 inline，用户拿到能离线双击打开。
 *
 * 触发条件：检测到 <script type="text/babel"> 存在 = hybrid 文件 → 走管道
 * 老 deck（无 babel script）→ 不走管道，调用方降级到 injectViewportFit 文本替换
 *
 * 7 步管道：
 *   1. parse：抽 importmap / babel scripts / Tailwind CDN script tag
 *   2. esbuild bundle：babel script 内容当 entry，import 走 esm.sh HTTP plugin（in-memory LRU cache）
 *   3. tailwind extract：跑 tailwindcss CLI on stdin，--content 指 raw html，--output 拿 used CSS
 *   4. replace tags：删 importmap / Babel CDN / Tailwind CDN script，替换 babel scripts 为 type=module 的 bundled JS
 *   5. inline tailwind CSS：插入 <style> 到 <head>
 *   6. inject viewport fit（复用 injectViewportFit）—— 跟 commit 1 / 2 / 3 已有的 fit script 兼容
 *   7. return assembled HTML
 *
 * 性能预期：首次导出 5-10s（CDN fetch 耗时）；缓存命中后 1-2s（仅 esbuild bundle + tailwind extract）
 *
 * 错误降级：管道任一步失败 → throw，调用方应回落到原 injectViewportFit（保证导出至少能拿到能用的 HTML）
 */

import { build } from 'esbuild';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeServerTmpDir } from '../../lib/server-tmp.js';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { fitInjectionBlock } from '../standalone-fit.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Tailwind CLI 路径 — 项目本地 install */
const TAILWIND_BIN = path.resolve(__dirname, '../../../node_modules/.bin/tailwindcss');

/**
 * 去掉 HTML 注释——避免 regex 把注释里的 `<script type="text/babel">` 字面
 * 字符当成真 script tag 抓（template 顶部就有这种注释提示）。
 *
 * 仅用于 parser 内部 regex 扫描；assemble 阶段仍用原始 rawHtml（保留注释作为 doc）。
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Hybrid 文件检测（heuristic）——任意一个 CDN 依赖都算"需要打包"。
 *
 * 检测信号（OR）：
 *   - <script type="text/babel">（agent 用了 React mount）
 *   - <script src="cdn.tailwindcss.com">
 *   - <script src="...@babel/standalone...">
 *   - <script type="importmap">（依赖 esm.sh 远程模块）
 *
 * 任意一个出现都说明 raw HTML **离线打开会失败**——必须走自包含管道。
 * 即使 agent 没用 React mount（纯静态 + Tailwind），Tailwind CDN 离线也挂。
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isHybridHtml(html) {
  const scan = stripHtmlComments(html);
  return (
    /<script[^>]*type=["']text\/babel["']/i.test(scan) ||
    /<script[^>]*src=["']https?:\/\/cdn\.tailwindcss\.com/i.test(scan) ||
    /<script[^>]*src=["'][^"']*@babel\/standalone/i.test(scan) ||
    /<script[^>]*type=["']importmap["']/i.test(scan)
  );
}

/**
 * 主入口：打包成自包含 HTML
 *
 * @param {string} rawHtml canvas.html 原文
 * @param {object} [opts]
 * @param {string} [opts.sessionRoot]   sessions/<sid>/ 绝对路径；用来 resolve 图片
 *                                       相对路径（assets/generated/...）。不给则
 *                                       跳过图片 inline（导出仍能用，但 <img> 会断）
 * @param {boolean} [opts.injectFit=true] 是否注入分页 fit script。**站点必须传 false**：
 *                                       那段脚本把每个 section 包成整屏 frame + scroll-snap，
 *                                       是幻灯片范式，注进网站等于把长页改造成翻页器
 * @returns {Promise<string>} 自包含 HTML（CDN + 图片全 inline，可离线打开）
 * @throws 任一步骤失败抛——调用方应降级到 injectViewportFit 文本替换
 */
export async function buildStandaloneHtml(rawHtml, opts = {}) {
  if (!isHybridHtml(rawHtml)) {
    throw new Error('Not a hybrid HTML — caller should fall back to injectViewportFit');
  }

  // 1. parse —— 抽出关键段
  const parsed = parseHybridDoc(rawHtml);

  // 2. bundle JS（esbuild + esm.sh HTTP plugin）—— commit 2 填实现
  const bundledJs = await bundleBabelScripts(parsed.babelScripts, parsed.importmap);

  // 3. extract Tailwind used CSS（tailwindcss CLI on stdin）—— commit 2 填实现
  // 把 agent 解析出的 fontFamily 传进去 merge superset，否则 agent 选的 latin
  // family（Manrope / Playfair / Geist / Lyon 等）在 build 时会被 hardcoded
  // superset 的 'Inter' / 'Instrument Serif' 覆盖，导出 PDF/PPT 英文字体跟
  // preview 不一致（preview 走运行时 Tailwind config 看着对、导出错的根因）。
  const tailwindCss = await extractTailwindCss(rawHtml, parsed.agentFontFamily);

  // 4-7. 重写 HTML —— inline 所有外部 CDN
  let html = assembleStandaloneHtml({
    rawHtml,
    parsed,
    bundledJs,
    tailwindCss,
    injectFit: opts.injectFit !== false,
  });

  // 8. inline 本地图片（<img src="assets/..."> + background-image: url(...))。
  // 单文件 self-contained 必须做这一步——脱离 sessions/<sid>/ 后相对路径都失效。
  // sessionRoot 不给时跳过（fail-soft，调用方可能不知道 sessionRoot）
  if (opts.sessionRoot) {
    // baseDir：相对路径以 deck 文件所在目录为基准（任务 deck 写的是
    // `../../assets/generated/x.png`，按 sessionRoot 解会跳出 workspace → 全裂图）
    html = await inlineLocalImages(html, opts.baseDir || opts.sessionRoot, opts.sessionRoot);
  }

  // 9. inline Google Fonts → @font-face data URL。
  // 离线打开 / CDN 慢时字体不再 fallback 到系统字体；fail-soft（fetch 失败保留原 link）
  html = await inlineGoogleFonts(html);

  return html;
}

// ──────────────────────────────────────────────────────────────────
// Step 1 · parseHybridDoc
// ──────────────────────────────────────────────────────────────────

/**
 * 抽出 hybrid HTML 的关键段：importmap / babel scripts / Tailwind CDN tag / Babel standalone tag
 *
 * @param {string} html
 * @returns {{
 *   importmap: object | null,
 *   importmapTagFull: string | null,
 *   babelScripts: Array<{ content: string, fullTag: string }>,
 *   tailwindCdnTag: string | null,
 *   babelCdnTag: string | null,
 *   tailwindConfigTag: string | null
 * }}
 */
export function parseHybridDoc(html) {
  // 关键：先 strip HTML 注释——避免 template 顶部 doc-comment 里的字面 <script>
  // 字符串被 regex 误抓。assemble 阶段仍 replace 原始 rawHtml，所以注释保留。
  const scan = stripHtmlComments(html);

  // importmap
  let importmap = null;
  let importmapTagFull = null;
  const importmapMatch = scan.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (importmapMatch) {
    importmapTagFull = importmapMatch[0];
    try { importmap = JSON.parse(importmapMatch[1]); } catch { /* malformed */ }
  }

  // babel scripts —— 多个段都收
  const babelScripts = [];
  const babelRe = /<script[^>]*type=["']text\/babel["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = babelRe.exec(scan)) !== null) {
    babelScripts.push({ content: m[1], fullTag: m[0] });
  }

  // Tailwind CDN tag —— 替换目标
  const tailwindCdnMatch = scan.match(/<script[^>]*src=["']https?:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*><\/script>/i);
  const tailwindCdnTag = tailwindCdnMatch ? tailwindCdnMatch[0] : null;

  // Tailwind config tag （tailwind.config = {...}）—— 移除（运行时不再需要）
  const tailwindConfigMatch = scan.match(/<script>[\s\S]*?tailwind\.config[\s\S]*?<\/script>/i);
  const tailwindConfigTag = tailwindConfigMatch ? tailwindConfigMatch[0] : null;

  // 解析 tailwind.config 里 agent 写的 fontFamily（agent 选的 latin family——
  // Manrope / Playfair Display / Geist / Lyon 等）。提取出来后 build 阶段 merge
  // 到 superset，否则 build-standalone 编译 Tailwind class 用硬编码 superset，
  // agent 选的 latin family 在 PDF/PPT 导出里会被 override 成 Inter / Instrument
  // Serif（preview 看着对、导出看着错的根因）。fail-soft：解析失败不抛错。
  let agentFontFamily = null;
  if (tailwindConfigTag) {
    agentFontFamily = extractAgentFontFamily(tailwindConfigTag);
  }

  // Babel standalone tag —— 删除（已 esbuild 预编译）
  const babelCdnMatch = scan.match(/<script[^>]*src=["'][^"']*@babel\/standalone[^"']*["'][^>]*><\/script>/i);
  const babelCdnTag = babelCdnMatch ? babelCdnMatch[0] : null;

  return { importmap, importmapTagFull, babelScripts, tailwindCdnTag, babelCdnTag, tailwindConfigTag, agentFontFamily };
}

/**
 * 从 `<script>tailwind.config = {...}</script>` tag 内容里提取 fontFamily 对象。
 *
 * agent 写法多样（单引号 / 双引号 / 多种 indent），用 vm 沙箱跑代码 + 拿
 * fontFamily —— 比正则鲁棒，比 acorn AST 解析轻量。沙箱 context 只暴露空对象，
 * 跑出问题（语法错 / 引用未定义符号）也只影响该函数返 null，不阻塞导出。
 *
 * @param {string} tagText `<script>...</script>` 完整 tag
 * @returns {Record<string, string[]> | null} fontFamily 对象 或 null
 */
function extractAgentFontFamily(tagText) {
  try {
    // 抽 <script> 标签里的代码
    const codeMatch = tagText.match(/<script>([\s\S]*?)<\/script>/i);
    if (!codeMatch) return null;
    const code = codeMatch[1];

    // 用 Node vm 沙箱跑：模拟 tailwind 全局对象，让 `tailwind.config = {...}` 赋值
    // 后能从沙箱拿到 config.theme.extend.fontFamily
    // 不用 eval/new Function 避免污染主进程作用域
    const sandbox = { tailwind: { config: null } };
    runInNewContext(code, sandbox, { timeout: 200 });
    const ff = sandbox?.tailwind?.config?.theme?.extend?.fontFamily;
    if (!ff || typeof ff !== 'object') return null;

    // 校验每个 key 的 value 是 string[]（agent 偶尔会写 string，规范化）
    const out = {};
    for (const [key, val] of Object.entries(ff)) {
      if (Array.isArray(val) && val.every(s => typeof s === 'string')) {
        out[key] = val;
      } else if (typeof val === 'string') {
        out[key] = [val];
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (err) {
    // sandbox 跑挂（agent 引用了未定义的全局符号 / 语法错）—— 静默返 null，
    // build 阶段会用 superset
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Step 2 · bundleBabelScripts —— esbuild + esm.sh HTTP plugin
// ──────────────────────────────────────────────────────────────────

/**
 * In-memory LRU cache for esm.sh fetched modules.
 * Key = absolute URL after redirect resolution.
 * Value = { contents: string, contentType: string }
 *
 * 容量 500 entries（一个 deck bundle 涉及 ~30-100 个 esm.sh 子模块；缓存几个 deck 够用）。
 * 每条 entry size 通常 5-50KB → cache 顶峰 ~10MB，进程重启就清。
 */
const REMOTE_CACHE_MAX = 500;
const remoteCache = new Map();

function cacheGet(key) {
  if (!remoteCache.has(key)) return undefined;
  const v = remoteCache.get(key);
  remoteCache.delete(key);  // LRU 用 Map 顺序，命中时挪到末尾
  remoteCache.set(key, v);
  return v;
}

function cacheSet(key, val) {
  if (remoteCache.size >= REMOTE_CACHE_MAX) {
    const oldestKey = remoteCache.keys().next().value;
    remoteCache.delete(oldestKey);
  }
  remoteCache.set(key, val);
}

/**
 * 把每段 babel script 当独立 ES module 喂 esbuild bundle；用合成 entry
 * `import './_nd_script_0_'; import './_nd_script_1_';` 串起来驱动执行。
 *
 * 为什么不直接 concat：浏览器里每个 `<script>` 是自己的作用域，agent 习惯写
 * 多段（譬如 `__nd-shadcn-lite` 段定义 `function Card`，`__nd-app` 段再
 * `const { Card } = window.__ndShadcn`）。两段直接拼成一个 esbuild entry 会
 * 撞 "The symbol Card has already been declared"，整条 standalone 管道炸 →
 * 用户拿到没 inline 图片的降级 HTML。改成多 module 后各自顶层作用域隔离，
 * 跟 `<script>` 语义对齐；共享 react 实例靠 importmap 同 URL 自动 dedupe。
 *
 * @param {Array<{ content: string, fullTag: string }>} babelScripts
 * @param {object | null} importmap importmap 的 imports 字段是 bare specifier → URL 的映射
 * @returns {Promise<string>} bundled ESM JS（已 minify）
 */
export async function bundleBabelScripts(babelScripts, importmap) {
  // 0 个 babel script 是常见场景：agent 写了纯静态 + Tailwind 的 deck，
  // importmap / @babel/standalone 是 boilerplate copy 但实际用不到。
  // 这种 case 直接返空，assemble 阶段不注入 module script。
  if (babelScripts.length === 0) return '';

  const importmapImports = importmap?.imports || {};

  // 每段当独立虚拟模块，合成 entry 按声明顺序依次 side-effect import
  const scriptVfs = new Map();
  const entryImports = babelScripts.map((s, i) => {
    const vp = `/__nd_script_${i}__.tsx`;
    scriptVfs.set(vp, s.content);
    return `import '${vp}';`;
  }).join('\n');

  const result = await build({
    stdin: {
      contents: entryImports,
      loader: 'tsx',
      sourcefile: '__nd_entry__.tsx',
      resolveDir: '/',  // 让虚拟绝对路径 import 能命中 onResolve
    },
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
    write: false,            // 不写盘，结果在 outputFiles
    plugins: [
      scriptVfsPlugin(scriptVfs),
      esmShHttpPlugin(importmapImports),
    ],
    // tsx loader 默认 jsx: classic（变 React.createElement），我们模板用 import React 就走通
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  });

  if (result.errors.length > 0) {
    throw new Error('esbuild errors: ' + result.errors.map(e => e.text).join('; '));
  }
  return result.outputFiles[0].text;
}

/**
 * 把每段 babel script 解析成独立虚拟 module，给 esbuild bundle 用。
 * 路径形如 `/__nd_script_0__.tsx`，靠 scriptVfs Map 查内容。
 */
function scriptVfsPlugin(scriptVfs) {
  return {
    name: 'nd-script-vfs',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\/__nd_script_\d+__\.tsx$/ }, (args) => ({
        path: args.path,
        namespace: 'nd-script-vfs',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'nd-script-vfs' }, (args) => ({
        contents: scriptVfs.get(args.path) || '',
        loader: 'tsx',
      }));
    },
  };
}

/**
 * esbuild plugin：把 bare specifier（react / recharts / @radix-ui/...）按 importmap 解析到
 * esm.sh URL，HTTP fetch 内容（with LRU cache + redirect 跟随），返给 esbuild bundle。
 *
 * @param {Record<string, string>} importmapImports
 */
function esmShHttpPlugin(importmapImports) {
  return {
    name: 'esm-sh-http',
    setup(buildApi) {
      // 第一层：bare specifier（react / 'react-dom/client' / '@radix-ui/react-dialog'）
      // 走 importmap 查表 → URL
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        // 已经是 https:// 的相对/绝对 URL（来自前一个 fetch 的 import 解析），下面那条 filter 接
        if (/^https?:\/\//.test(args.path)) {
          return { path: args.path, namespace: 'esm-http' };
        }
        // bare specifier → importmap
        if (importmapImports[args.path]) {
          return { path: importmapImports[args.path], namespace: 'esm-http' };
        }
        // bare specifier 带子路径，如 'react-dom/client'：先查 importmap 完全匹配
        // 没有就找 trailing-slash 前缀（importmap 'react/' 风格）
        for (const [k, v] of Object.entries(importmapImports)) {
          if (k.endsWith('/') && args.path.startsWith(k)) {
            const rest = args.path.slice(k.length);
            return { path: v + rest, namespace: 'esm-http' };
          }
        }
        // 不在 importmap 里就让 esbuild 走默认（多半 fail，但留余地）
        return null;
      });

      // 第二层：从 esm-http 命名空间的 module 内部解析相对路径（esm.sh 返的代码会
      // import './chunk-XXX.mjs' 这种 relative）
      buildApi.onResolve({ filter: /.*/, namespace: 'esm-http' }, (args) => {
        // resolve relative URL based on importer
        if (args.path.startsWith('http')) {
          return { path: args.path, namespace: 'esm-http' };
        }
        try {
          const resolved = new URL(args.path, args.importer).toString();
          return { path: resolved, namespace: 'esm-http' };
        } catch {
          return null;
        }
      });

      // 第三层：HTTP fetch
      buildApi.onLoad({ filter: /.*/, namespace: 'esm-http' }, async (args) => {
        const cached = cacheGet(args.path);
        if (cached) {
          return { contents: cached.contents, loader: cached.loader };
        }
        const res = await fetch(args.path, { redirect: 'follow' });
        if (!res.ok) {
          throw new Error(`esm.sh fetch failed: ${res.status} ${args.path}`);
        }
        const finalUrl = res.url;  // 跟随 redirect 后
        const contents = await res.text();
        const ct = res.headers.get('content-type') || '';
        const loader = ct.includes('css') ? 'css' : 'js';
        cacheSet(finalUrl, { contents, loader });
        if (finalUrl !== args.path) cacheSet(args.path, { contents, loader });
        return { contents, loader };
      });
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Step 3 · extractTailwindCss (commit 2 实现)
// ──────────────────────────────────────────────────────────────────


/**
 * 跑 tailwindcss CLI 提取该 HTML 实际用到的 utility class 对应的 CSS。
 *
 * 输入 raw HTML（含 <head>/Tailwind config + <body>/Tailwind class 用法）：
 *   - 写到 tmp html 文件让 tailwindcss --content 扫描
 *   - 跑 CLI on stdin 读 input CSS（@tailwind base/components/utilities），stdout 拿编译后 CSS
 *   - cleanup tmp file
 *
 * @param {string} rawHtml
 * @param {Record<string, string[]> | null} [agentFontFamily] — agent 在原 HTML
 *   tailwind.config 里写的 fontFamily（parseHybridDoc 解析），merge 优先级最高。
 *   不给 / null 时只用 superset 默认。
 * @returns {Promise<string>} minified CSS（含 base reset + agent 用到的所有 utility）
 */
export async function extractTailwindCss(rawHtml, agentFontFamily = null) {
  // 写 raw html 到 tmpfile，tailwindcss CLI 扫描它的 class
  const tmpDir = await makeServerTmpDir('nd-tw-');
  const htmlPath = path.join(tmpDir, 'src.html');
  const cfgPath = path.join(tmpDir, 'tailwind.config.js');
  const inputCssPath = path.join(tmpDir, 'in.css');

  // ── superset fontFamily（兜底）──
  // 当 agent 没在 inline tailwind.config 里 extend fontFamily 时，用这份 superset。
  //
  // ⚠️ 字体 chain 4 段式（跟 SKILL.md 铁律 + canvas.template.html 一致）：
  //   latin → 苹果 CJK（PingFang/Songti）→ Noto CJK（inline 兜底）→ generic
  //
  // 历史教训：
  //   1. 之前没 PingFang/Noto SC——导致 agent 即使在原 HTML 写了 4 段 chain，
  //      build 时 tailwindcss CLI 用 superset 编译，font-sans / font-serif 等
  //      Tailwind class 全是老 chain（无 CJK）。font-serif 更夸张：没 extend
  //      直接用 Tailwind 默认 [ui-serif, Georgia, ...]，CJK 走 generic 全错。
  //   2. agent 选 Manrope / Playfair / Geist 等 latin family，但 build superset
  //      硬编码 sans=Inter / display=Instrument Serif —— agent 选的 latin family
  //      在导出 PDF/PPT 里被 override 成 Inter，preview 看着对、导出英文错。
  //      为修第 2 条：parseHybridDoc 解析 agent inline config 提取 fontFamily，
  //      在这里 merge 进 superset，agent 选的 family 优先（见 finalFontFamily）。
  const supersetFontFamily = {
    sans:    ['Inter', 'PingFang SC', 'Noto Sans SC', 'system-ui', 'sans-serif'],
    serif:   ['Instrument Serif', 'Songti SC', 'Noto Serif SC', 'serif'],
    mono:    ['JetBrains Mono', 'monospace'],
    display: ['Instrument Serif', 'Songti SC', 'Noto Serif SC', 'serif'],
  };

  // ── merge：agent 写什么 build 就用什么 ──
  // agent 是 senior，css 字体 chain 是设计意图——不要 second-guess、不要"贴心"
  // 自动补 CJK / generic。SKILL.md 已经教 agent 写 4 段 chain，agent 自己负责
  // 完整性。agent 没写的 key 才用 superset 兜底。
  const finalFontFamily = { ...supersetFontFamily };
  if (agentFontFamily && typeof agentFontFamily === 'object') {
    for (const [key, list] of Object.entries(agentFontFamily)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      finalFontFamily[key] = list;  // 原样覆盖

      // dev warn: agent chain 短于 4 段时给开发者排查信号（不改 merge 行为，trust 设计保留）
      // 4 段铁律：latin → 苹果 CJK（PingFang/Songti）→ Noto CJK（inline 兜底）→ generic
      // 不足 4 段在 Linux/Windows 没装 latin family 时 fallback 链断，跨平台字体效果可能跟设计意图差很远
      if (list.length < 4) {
        console.warn(
          `[build-standalone] agent fontFamily.${key} 只有 ${list.length} 段 chain，` +
          `跨平台可能 fallback 不全（建议 4 段：latin → 苹果 CJK → Noto CJK → generic）。` +
          `当前 chain: ${JSON.stringify(list)}`
        );
      }
    }
  }

  const fontFamilyJson = JSON.stringify(finalFontFamily, null, 6).replace(/^/gm, '      ').trim();

  const config = `module.exports = {
  content: ['${htmlPath}'],
  theme: {
    extend: {
      fontFamily: ${fontFamilyJson},
    },
  },
  // 不开 corePlugins.preflight=false：保留 Tailwind base reset（tile 默认含 box-sizing 等基础）
};
`;
  const inputCss = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';

  await Promise.all([
    fs.writeFile(htmlPath, rawHtml, 'utf8'),
    fs.writeFile(cfgPath, config, 'utf8'),
    fs.writeFile(inputCssPath, inputCss, 'utf8'),
  ]);

  try {
    const { stdout } = await execFileAsync(TAILWIND_BIN, [
      '-c', cfgPath,
      '-i', inputCssPath,
      '--minify',
    ], {
      maxBuffer: 10 * 1024 * 1024,  // CSS 最大 10MB（远超实际 ~50KB）
    });
    return stdout;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

// ──────────────────────────────────────────────────────────────────
// Step 4-7 · assembleStandaloneHtml
// ──────────────────────────────────────────────────────────────────

/**
 * 重写 HTML：删 CDN script tag / 替换 babel scripts / 注入 inline CSS
 *
 * @param {{
 *   rawHtml: string,
 *   parsed: ReturnType<typeof parseHybridDoc>,
 *   bundledJs: string,
 *   tailwindCss: string
 * }} args
 * @returns {string} 自包含 HTML
 */
export function assembleStandaloneHtml({ rawHtml, parsed, bundledJs, tailwindCss, injectFit = true }) {
  let html = rawHtml;

  // ⚠️ 关键：用 split+join 而不是 string.replace，因为 minified JS bundle 里
  // 有大量 `$&` `$'` `$1` 等字面字符串，String.replace 的 replacement 字符串会
  // 把它们当作 backreference（substitute matched/captured groups），导致 1MB
  // bundle 替换后产物炸到 7 倍大小。split+join 是字面替换，无 $ 解读。
  const literalReplace = (str, search, replacement) =>
    str.split(search).join(replacement);

  // 4a. 删 importmap（已 esbuild bundled）
  if (parsed.importmapTagFull) {
    html = literalReplace(html, parsed.importmapTagFull, '<!-- importmap inlined by build-standalone -->');
  }

  // 4b. 删 Babel standalone CDN（已预编译）
  if (parsed.babelCdnTag) {
    html = literalReplace(html, parsed.babelCdnTag, '<!-- @babel/standalone removed (precompiled by esbuild) -->');
  }

  // 4c. 替换 Tailwind CDN script tag → 后续 inline <style>
  if (parsed.tailwindCdnTag) {
    html = literalReplace(html, parsed.tailwindCdnTag, '<!-- Tailwind Play CDN replaced by extracted inline CSS -->');
  }

  // 4d. 移除 tailwind.config 运行时 inline config（已在 extract 阶段消费）
  if (parsed.tailwindConfigTag) {
    html = literalReplace(html, parsed.tailwindConfigTag, '<!-- tailwind.config consumed at build time -->');
  }

  // 4e. 替换所有 babel scripts 为单个 type=module bundle（必须 literal——bundledJs 含 $）
  // 0 个 babel script 时跳过——纯静态 deck 不需要 module 入口
  for (let i = 0; i < parsed.babelScripts.length; i++) {
    const tag = parsed.babelScripts[i].fullTag;
    const replacement = i === 0 && bundledJs
      ? `<script type="module">\n/* bundled by esbuild from ${parsed.babelScripts.length} babel script(s) */\n${bundledJs}\n</script>`
      : '<!-- babel script bundled into the first module -->';
    html = literalReplace(html, tag, replacement);
  }

  // 5. inline Tailwind CSS 到 <head>（CSS 也可能含 $，用 literal）
  const tailwindStyleTag = `<style id="__nd-tailwind-extracted">\n${tailwindCss}\n</style>`;
  if (html.includes('</head>')) {
    html = literalReplace(html, '</head>', tailwindStyleTag + '\n</head>');
  } else {
    html = tailwindStyleTag + '\n' + html;
  }

  // 6-7. fit script（**只给 deck**，2026-07-28）——
  //    去重：agent 偶尔会自己写一个 fit script（譬如 letterbox 风格的
  //    Math.min(vw/W, vh/H)），跟服务端注入的 frame-snap fit 叠加导致 scale 双重缩放或
  //    DOM 层级冲突。strategy：识别所有"看起来像 fit script"的 inline script 段全删，
  //    再注入一个权威 standard fit script，保证只有一份在跑。
  //
  //    站点（injectFit=false）两步都跳过：注入会把自然滚动的长页改造成翻页器；
  //    stripFitScripts 的启发式（含 `transform: scale(` 写法）会误删站点里正当的
  //    hero 缩放动画。删了还查不出来 —— 导出物打开只是"动画没了"，没人会怀疑导出。
  if (injectFit) {
    html = stripFitScripts(html);
    html = injectStandardFitScript(html);
  }

  return html;
}

/**
 * Heuristic：找真·fit/scale 脚本删除（避免跟服务端注入的 standard fit script 双 scale）。
 *
 * 旧版命中条件 `body.includes('__nd-deck-wrap')` 太松——所有合法的 keyboard nav /
 * scroll-spy / page indicator 都 query wrap，会被误杀。改严：只删带"明确 scale 行为
 * 信号"的脚本。识别信号要求**同时含 transform-style scale 写法 + 1920/DESIGN_W
 * 这种 viewport 比值算式**，单一标识符（如纯 `__nd-deck-wrap`）不再触发。
 *
 * Escape：带 `data-nodesign-keep` attribute 的 script 永不删（agent 显式声明保留）。
 */
function stripFitScripts(html) {
  // 只匹配 inline script（无 src 属性）；外联 fit script 在 NoDesign 范式里不存在
  // attrs group 抓 <script ...> 里 attributes 字符串供 escape 检测
  const scriptRe = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  return html.replace(scriptRe, (full, attrs, body) => {
    // Escape：显式声明保留（带 data-nodesign-keep 的 nav 脚本永不删）
    if (/\bdata-nodesign-keep\b/i.test(attrs)) return full;

    // Heuristic 1：使用 NoDesign 私有 class `__nd-fit-active` 且带 classList 操作
    // —— 这是 fit script 唯一的"添加 fit 状态" 写法，nav/scroll-spy 不会碰这个 class
    const usesFitActiveClass =
      body.includes('__nd-fit-active') && /\bclassList\.(add|remove|toggle)\b/.test(body);

    // Heuristic 2：viewport 比值算式 + 任何 scale 写法（即使 transform 跟 scale 之间被
    // 三元/quote 隔开）—— 模板原 fit 写法 `var s = vw / W;` + `... 'scale(' + s + ')'`
    const hasViewportRatio =
      /Math\.min\s*\(\s*\w+\s*\/\s*1920/i.test(body)
      || (/DESIGN_W\b/.test(body) && /\bscale\b/.test(body))
      || (/\bvw\s*\/\s*W\b/.test(body) && /['"`]scale\s*\(/.test(body))
      || (/window\.innerWidth/.test(body) && /1920/.test(body) && /\bscale\b/.test(body));

    // Heuristic 3：明示的 transform: scale 写法（CSS 风格连续）
    const hasInlineScaleTransform = /transform\s*[:=]\s*['"]?\s*scale\s*\(/i.test(body);

    const isFitScript = usesFitActiveClass || hasViewportRatio || hasInlineScaleTransform;
    return isFitScript ? '<!-- fit script removed by build-standalone (will inject standard) -->' : full;
  });
}

/**
 * 注入唯一权威 standard fit script（调 standalone-fit 的 fitInjectionBlock）。
 * 放在 </body> 前；如无 </body> 末尾追加。
 */
function injectStandardFitScript(html) {
  const block = fitInjectionBlock();
  if (html.includes('</body>')) {
    return html.split('</body>').join(block + '\n</body>');
  }
  return html + block;
}

// ────────────────────────────────────────────────────────────────────
// inlineLocalImages —— 自包含必需：把 <img src> + background:url() 里指
// 向本地 assets/ 的相对路径转 base64 data URL。
//
// 触发场景：generate_image MCP 工具落档 assets/generated/foo.png，agent
// 在 canvas.html 写 `<img src="assets/generated/foo.png">`。导出单文件
// HTML 后用户双击打开，浏览器 file:// 找不到 assets/，图全断。inline 后
// 100% self-contained。
//
// 范围：
//   - 只处理本地相对路径（不带 scheme，不是 // 开头，不是 data:）
//   - resolve 到 sessionRoot（sessions/<sid>/assets softlink → shared/assets，
//     fs.readFile 自动跟链）
//   - 防 traversal：必须 startsWith sessionRoot（realpath 校验）
//   - mime 按扩展名定（png/jpg/jpeg/webp/gif/svg），其它扩展跳过
//   - 缺失文件：替换为 broken-image SVG 占位 + 注释，不阻塞导出
// ────────────────────────────────────────────────────────────────────

const IMAGE_EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const BROKEN_PLACEHOLDER_DATA_URL =
  'data:image/svg+xml;utf8,'
  + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">'
    + '<rect width="120" height="80" fill="%23eee" stroke="%23bbb"/>'
    + '<text x="60" y="44" text-anchor="middle" font-family="sans-serif" font-size="11" fill="%23999">image not found</text>'
    + '</svg>',
  );

async function inlineOneAsset(srcPath, baseDir, rootGuard, cache) {
  if (cache.has(srcPath)) return cache.get(srcPath);

  // 路径白名单：scheme/protocol-relative/data url 一律放过
  if (/^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(srcPath)) {
    cache.set(srcPath, srcPath);
    return srcPath;
  }
  // 绝对路径（agent 不该写，防御性处理）—— 也放过原值
  if (path.isAbsolute(srcPath)) {
    cache.set(srcPath, srcPath);
    return srcPath;
  }

  const ext = path.extname(srcPath).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext];
  if (!mime) {
    cache.set(srcPath, srcPath);  // 非图片资源不动
    return srcPath;
  }

  // 相对 deck 自己的目录解（`../../assets/...` 正是从 tasks/<任务>/ 往上两级），
  // 越界判定仍以 workspace 根为准
  const abs = path.resolve(baseDir, srcPath);
  const root = rootGuard || baseDir;
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    console.warn(`[build-standalone] image path escapes session: ${srcPath}`);
    cache.set(srcPath, BROKEN_PLACEHOLDER_DATA_URL);
    return BROKEN_PLACEHOLDER_DATA_URL;
  }

  let buf;
  try {
    buf = await fs.readFile(abs);  // 跟 softlink
  } catch (err) {
    console.warn(`[build-standalone] image not found, using placeholder: ${srcPath} (${err.code || err.message})`);
    cache.set(srcPath, BROKEN_PLACEHOLDER_DATA_URL);
    return BROKEN_PLACEHOLDER_DATA_URL;
  }

  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  cache.set(srcPath, dataUrl);
  return dataUrl;
}

/**
 * 扫 HTML 把所有本地 <img src> 和 url(...) 引用替换成 data URL。
 *
 * @param {string} html
 * @param {string} baseDir     绝对路径，HTML 里的相对路径从这里 resolve（deck 自己的目录）
 * @param {string} [rootGuard] 越界判定根（缺省 = baseDir）
 * @returns {Promise<string>}
 */
export async function inlineLocalImages(html, baseDir, rootGuard = null) {
  const cache = new Map();  // 同一图被多次引用只读一次盘 + base64 一次

  // ── 收集所有候选 src（先收集再异步批量替换）──
  const tasks = [];

  // <img src="..."> / <img ... src='...' ...>
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1] || m[2];
    if (src) tasks.push(src);
  }

  // background-image: url(...) / background: ... url(...) （style 属性 + <style> 块）
  const urlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+?))\s*\)/gi;
  while ((m = urlRe.exec(html)) !== null) {
    const src = m[1] || m[2] || m[3];
    if (src) tasks.push(src.trim());
  }

  // 去重 + 并行 inline
  const uniq = [...new Set(tasks)];
  await Promise.all(uniq.map((s) => inlineOneAsset(s, baseDir, rootGuard || baseDir, cache)));

  // ── 替换：用 cache 拿到的 data URL 替换原 src ──
  // 注：split+join literal 替换避免 base64 里的 $ 被当 backreference
  let out = html;
  for (const [orig, replacement] of cache) {
    if (orig === replacement) continue;  // 没改的跳
    // <img src="ORIG"> 和 url(ORIG) 都要替换；用包含 quote/paren 的字面字符串
    // 减少误伤（避免一个 path 段也匹配 alt 文字之类）
    const variants = [
      `"${orig}"`, `'${orig}'`,
      `(${orig})`, `( ${orig} )`,
      `("${orig}")`, `('${orig}')`,
    ];
    for (const v of variants) {
      const replaceVariant = v
        .replace(orig, replacement);
      out = out.split(v).join(replaceVariant);
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────
// inlineGoogleFonts —— 把 Google Fonts CSS 链接转成 inline @font-face
// + woff2 base64 data URL，让导出 HTML 离线打开字体仍正确。
//
// 流程：
//   1. 找所有 <link href="https://fonts.googleapis.com/css2?..."> tag
//   2. fetch 每个 CSS（带浏览器 UA 让 Google 返 woff2 而不是 truetype）
//   3. CSS 里 `url(https://fonts.gstatic.com/...)` 全部 fetch + base64 替换
//   4. 把原 link tag 替换为 inline <style>
//   5. 顺手删 fonts.gstatic.com / fonts.googleapis.com 的 preconnect link
//
// 进程级 LRU cache：同一 deck reload 多次 / 多 deck 共字体免重 fetch
// fail-soft：fetch 失败保留原 link tag，离线失败但不破坏导出
// ────────────────────────────────────────────────────────────────────

const FONT_CACHE_MAX = 200;  // 200 个字体文件够 50 个 deck 用
const fontCache = new Map();

function fontCacheGet(key) {
  if (!fontCache.has(key)) return undefined;
  const v = fontCache.get(key);
  fontCache.delete(key);
  fontCache.set(key, v);
  return v;
}

function fontCacheSet(key, val) {
  if (fontCache.size >= FONT_CACHE_MAX) {
    const oldest = fontCache.keys().next().value;
    fontCache.delete(oldest);
  }
  fontCache.set(key, val);
}

const FONT_EXT_MIME = {
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
};

// 模拟 Chrome UA 让 Google Fonts CSS 返 woff2 而不是 truetype
const FONT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchAsBase64(url) {
  const cached = fontCacheGet(url);
  if (cached) return cached;
  const res = await fetch(url, { headers: { 'User-Agent': FONT_UA } });
  if (!res.ok) throw new Error(`font fetch ${res.status}`);
  const ab = await res.arrayBuffer();
  const ext = (url.match(/\.(woff2|woff|ttf|otf)(?:[?#]|$)/i) || [])[1];
  const mime = ext ? FONT_EXT_MIME['.' + ext.toLowerCase()] : 'font/woff2';
  const dataUrl = `data:${mime};base64,${Buffer.from(ab).toString('base64')}`;
  fontCacheSet(url, dataUrl);
  return dataUrl;
}

/**
 * 解析 unicode-range 字符串为 [start, end] 数组。
 * 支持：U+0041 / U+0041-005A / U+30?? (wildcards 替换为 0/F)
 *
 * @param {string} rangeStr "U+0000-00FF, U+0131, ..."
 * @returns {Array<[number, number]>}
 */
function parseUnicodeRange(rangeStr) {
  return rangeStr.split(',').map(r => r.trim()).map(r => {
    const m = r.match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) return null;
    const startHex = m[1].replace(/\?/g, '0');
    const endHex = m[2] || m[1].replace(/\?/g, 'F');
    const start = parseInt(startHex, 16);
    const end = parseInt(endHex, 16);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return [start, end];
  }).filter(Boolean);
}

/**
 * 检查 @font-face 块的 unicode-range 是否跟 deck 用到的字符有交集。
 * 没声明 unicode-range 的块认为匹配（无范围限制即覆盖全字符）。
 */
function fontFaceBlockNeeded(block, usedCharCodes) {
  const m = block.match(/unicode-range\s*:\s*([^;}]+)/i);
  if (!m) return true;
  const ranges = parseUnicodeRange(m[1]);
  if (ranges.length === 0) return true;
  for (const cp of usedCharCodes) {
    for (const [s, e] of ranges) {
      if (cp >= s && cp <= e) return true;
    }
  }
  return false;
}

async function inlineGoogleFonts(html) {
  // 找所有 Google Fonts CSS link
  const linkRe = /<link\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  const matches = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] || m[2];
    if (/^https?:\/\/fonts\.googleapis\.com\/css/i.test(href)) {
      matches.push({ fullTag: m[0], href });
    }
  }

  if (matches.length === 0) return html;

  // 一次性扫描整个 HTML 提取所有 codepoint（粗扫，包括 script/style/comment 内容也算。
  // 安全过头比漏字符强 —— 漏字符 = 用户看到 □ tofu 灾难性，过头只是多 inline 一两个块）
  const usedCharCodes = new Set();
  for (const c of html) {
    usedCharCodes.add(c.codePointAt(0));
  }

  let out = html;

  for (const { fullTag, href } of matches) {
    let cssText;
    try {
      const cached = fontCacheGet(href);
      if (cached) {
        cssText = cached;
      } else {
        const res = await fetch(href, { headers: { 'User-Agent': FONT_UA } });
        if (!res.ok) throw new Error(`Google Fonts CSS ${res.status}`);
        cssText = await res.text();
        fontCacheSet(href, cssText);
      }
    } catch (err) {
      console.warn(`[build-standalone] Google Fonts CSS fetch failed: ${href} (${err.message})`);
      continue;  // fail-soft 保留原 link
    }

    // 拆 @font-face 块按 unicode-range 子集匹配 ——
    // CJK 字体 (Noto Sans SC) 1 个 weight 能拆 7 个 range × 多 weight = 几十个 woff2，
    // 全 inline 文件能上百 MB。按用到的字符过滤 unicode-range 后 latin-only deck 通常
    // 只剩 1-2 个块、~50KB；CJK deck 也只 inline 实际用到的 range（也可能 5-10MB 但
    // 不再是百 MB 灾难）
    const blockRe = /@font-face\s*\{[^}]*\}/g;
    const allBlocks = [...cssText.matchAll(blockRe)].map(x => x[0]);
    const keptBlocks = allBlocks.filter(b => fontFaceBlockNeeded(b, usedCharCodes));

    // 不在 @font-face 块里的 CSS 内容（注释 / 其他 rule）保留
    const nonBlockCss = cssText.replace(blockRe, '').trim();
    let assembledCss = (nonBlockCss ? nonBlockCss + '\n' : '') + keptBlocks.join('\n');

    if (allBlocks.length > 0) {
      console.log(`[build-standalone] fonts inline: ${keptBlocks.length}/${allBlocks.length} @font-face kept (${href})`);
    }

    // 收集 keptBlocks 内的 woff2 url，base64 fetch（别的 url 不动）
    const fontUrlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g;
    const fontUrls = new Set();
    for (const block of keptBlocks) {
      let fm;
      const localRe = new RegExp(fontUrlRe.source, 'g');
      while ((fm = localRe.exec(block)) !== null) {
        const u = fm[1] || fm[2] || fm[3];
        if (u && /^https?:\/\/.*\.(woff2|woff|ttf|otf)(?:[?#]|$)/i.test(u)) {
          fontUrls.add(u);
        }
      }
    }

    const uniq = [...fontUrls];
    const results = await Promise.allSettled(uniq.map(u => fetchAsBase64(u)));
    for (let i = 0; i < uniq.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        assembledCss = assembledCss.split(uniq[i]).join(r.value);
      } else {
        console.warn(`[build-standalone] font file fetch failed: ${uniq[i]} (${r.reason?.message})`);
      }
    }

    const styleTag = `<style id="__nd-google-fonts-inlined">\n${assembledCss}\n</style>`;
    out = out.split(fullTag).join(styleTag);
  }

  // 顺手删 preconnect（已不需要联网）
  out = out.replace(
    /<link\b[^>]*\bhref\s*=\s*["'](?:https?:\/\/fonts\.(?:googleapis\.com|gstatic\.com))[^"']*["'][^>]*>\s*/gi,
    '',
  );

  return out;
}
