/**
 * server/engine/browse/capture.js — 从浏览的站上把可复用的东西带回来（2026-08-18）
 *
 * 用户的追加需求：「**此后从浏览器中获得的可复用内容都存到这里**」。关键词是
 * "此后" —— 采集要落盘，不能只进这一轮的上下文然后随会话消失。
 *
 * ## 落哪儿、为什么不新建目录
 *
 * `assets/references/web/`。**不新建"浏览器根"**：`assets/references/` 已经是既有
 * 目录、既有写入方（web-search 下载的参考图落那儿）、既有 skill 锚点。再立一个根就是
 * 「同一件事两个地方」—— 这个仓库最贵的一课。放它下面的 `web/` 子目录，与搜索图
 * 分栏但同根。
 *
 * 出处 sidecar 照抄 `generate-image.js` 已有的约定：`<产物层>/.meta/<name>.json`。
 * **不另发明一套** —— 而且那个约定的读者（assets.js 的清单合并）已经在，扩一处就能
 * 让参考素材也带出处。
 *
 * ## ⭐「可复用内容」比截图宽得多
 *
 * 对做设计这件事，从一个站上带回来最值钱的往往不是位图：**调色板**、**用了哪几个
 * 字体**、某一块的 **CSS 片段**、页面的**结构骨架**。这些能直接落成代码，位图只能
 * 靠眼睛转译。所以 capture 是五种，不是一种。
 *
 * ⚠️ 五种里四种是从 `getComputedStyle` / CDP 直接读出来的（可靠），
 * **`skeleton` 那三个数是启发式**（按布局签名聚类数"节的形状种类"），返回值里明确
 * 标着"粗略，当对照不当真相"—— 它的用处是让 site-craft 的「无聊诊断」从"靠眼睛数"
 * 变成"对参照站有对照数字"，不是当成事实。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 采集根（工作区相对）。web-search 的搜索图在同一个 references 根下、分栏放。
 *
 * ⭐ **一个参照站一个文件夹**（2026-08-18 下午，用户拍板"按 site 那种范式"）：
 * `assets/references/web/<站名>/`。理由是一次采集的五档本来就是**一个单位**
 * （同一个站、同一次、同一个 lookingFor），平铺到十几个文件之后靠文件名前缀
 * 认亲太弱；而目录 = 单位正是站点产物那条既有范式，桌面上一张卡装一个站。
 * 目录里再按**文件名表明类别**（`.screenshot.webp` / `.palette.json` / …）。
 */
export const CAPTURE_DIR = path.posix.join('assets', 'references', 'web');

/** 站名 → 目录名。去掉 www.、端口里的冒号，别让它在 Windows 上炸 */
export const siteDirOf = (url) => {
  try {
    const u = new URL(url);
    return slug(`${u.hostname.replace(/^www\./, '')}${u.port ? `-${u.port}` : ''}`);
  } catch { return 'page'; }
};

/**
 * 命中规则 → **真的能抄的 CSS 文本**。
 *
 * 这一档的全部价值是"照抄就能复现那个技术"，而包在 json 里的它得先被解开一层
 * 才能用。写成 .css 之后类别由扩展名表明，人和 agent 都能直接读。
 * 顺序 = CDP 给的级联顺序（后面的覆盖前面的），头注释里写清出处。
 */
function cssText(rules, info, selector) {
  const head = [
    '/* 从参照站采下来的命中规则（按级联顺序，后面的覆盖前面的）',
    ` * 元素：${selector}`,
    ` * 来源：${info.url}`,
    ` * 采于：${new Date().toISOString()}`,
    ' */',
    '',
  ];
  const body = rules.map((r) => {
    const decls = r.declarations.map(d => `  ${d};`).join('\n');
    const rule = `${r.selector} {\n${decls}\n}`;
    return r.media?.length
      ? `@media ${r.media.join(' and ')} {\n${rule.replace(/^/gm, '  ')}\n}`
      : rule;
  });
  return `${head.concat(body).join('\n')}\n`;
}

const slug = (s) => String(s || '')
  .replace(/[^\w一-龥-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'capture';

/** 页面里跑的采集器。⚠️ 整段在浏览器上下文里执行，不能引用外面的东西。 */
/* eslint-disable no-undef */
function collectorSource() {
  return () => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const norm = (c) => {
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
      return c;
    };

    // ── 调色板：按"用途"取，不是把图量化 ──
    // 量化位图会给一堆没名字的相近色；从 computed style 取到的是**作者的选择**，
    // 而且自带用途，拿回来能直接用。
    // ⚠️ 每一行显式声明取哪个属性 —— 第一版对每个元素同时报 color 和 background，
    // 于是出现了 `page-bg/color=black` 这种自相矛盾的行（body 的 color 是正文色）。
    const uses = [
      ['page-bg', 'body', 'backgroundColor'],
      ['body-text', 'body', 'color'],
      ['h1', 'h1', 'color'],
      ['h2', 'h2', 'color'],
      ['link', 'a', 'color'],
      ['button-bg', 'button, .btn, [class*=button]', 'backgroundColor'],
      ['button-text', 'button, .btn, [class*=button]', 'color'],
      ['card-bg', 'article, .card, [class*=card]', 'backgroundColor'],
      ['footer-bg', 'footer', 'backgroundColor'],
      ['footer-text', 'footer', 'color'],
    ];
    const palette = [];
    for (const [role, sel, prop] of uses) {
      const el = document.querySelector(sel);
      const s = cs(el);
      const v = s ? norm(s[prop]) : null;
      if (v) palette.push({ role, value: v });
    }

    // ── 字体：字族 + 实际用到的字重/字号（光有字族没法照做）──
    const fontOfEl = (el, label) => {
      const s = cs(el);
      if (!s) return null;
      return {
        role: label,
        family: s.fontFamily,
        size: s.fontSize,
        weight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
      };
    };
    const fontOf = (sel, label) => fontOfEl(document.querySelector(sel), label);

    // ⚠️ 「正文」不能拿**第一个 `<p>`**（agent 上报逮到：真站上首个 `<p>` 常是
    // 顶部公告条/导航里的一句话，字号字族都不是正文的，量出来整份报告跟着错）。
    // 改成找**最大的可见叶子文字块**：字多、够宽、且没有块级孩子替它装内容。
    // 附 selector + 文字样本 —— 量具的读数要能核对出处，不然错了没人看得见。
    const pickParagraph = () => {
      let best = null; let bestScore = 0;
      for (const el of document.querySelectorAll('p, li, dd, blockquote')) {
        if (el.querySelector('p, div, ul, ol, table, blockquote, pre, h1, h2, h3')) continue;
        const r = el.getBoundingClientRect();
        const s = cs(el);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || r.width < 120) continue;
        const text = (el.textContent || '').trim();
        if (text.length < 40) continue;
        // 长度封顶：一段 5000 字的法律条款不该只因为长就赢过真正的正文版式
        const score = Math.min(text.length, 600) * Math.min(r.width, window.innerWidth);
        if (score > bestScore) { bestScore = score; best = el; }
      }
      return best || document.querySelector('p');
    };
    const selectorOf = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const cls = [...el.classList].slice(0, 2).join('.');
      return cls ? `${tag}.${cls}` : tag;
    };
    const pEl = pickParagraph();
    const pFont = fontOfEl(pEl, 'paragraph');
    if (pFont) {
      pFont.selector = selectorOf(pEl);
      pFont.sample = (pEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    }
    const fonts = [
      fontOf('body', 'body'), fontOf('h1', 'h1'), fontOf('h2', 'h2'),
      pFont, fontOf('code, pre', 'mono'),
    ].filter(Boolean);

    // ── 结构骨架（⚠️ 启发式）──
    //
    // ⚠️ 第一版按标签选（`main > *, body > section` …），在第一个真站（MDN）上就
    // **数出 0 节**。一个在真站上读 0 的指标比没有更坏 —— 它会告诉 agent
    // 「这个参照站有 0 种形状」。所以改成按**视觉横带**找：宽度接近视口、够高、
    // 而且内部不再包含更小的带（取最内层）。人看一个页面看到的"一节"就是这个。
    const vw = window.innerWidth;
    const cand = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      // 高度门槛跟视口挂钩而不是写死 120 —— 真站上一条 104px 的 stats strip
      // 就这么整条消失了（它确实是"一节"，人一眼就看见）
      if (r.width < vw * 0.7 || r.height < Math.max(72, window.innerHeight * 0.08)) return false;
      const s = cs(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    // 取最内层的带：一个候选如果还含着别的候选，它是容器不是"一节"
    const candSet = new Set(cand);
    const sections = cand.filter(el => ![...el.querySelectorAll('*')].some(d => candSet.has(d)));

    // 「节的形状种类」按布局签名聚类：同签名的节读起来是"同一种节奏"。
    // 这是 site-craft「用户说无聊」那节要的第二个数。
    // 签名要**粗**。第一版把图/标题/文字块数都算进去（各封顶 3），结果在三个真站上
    // `形状种类 === 节数` —— 每节都独一无二，那第二个数就不携带任何信息。
    // 现在只留三个粗轴：排布方式 / 有没有图 / 文字密度档。同一种节奏才会撞在一起。
    const sig = (el) => {
      const s = cs(el);
      const layout = s.gridTemplateColumns !== 'none' ? 'grid'
        : (s.display.includes('flex') ? (s.flexDirection.startsWith('row') ? 'row' : 'col') : 'block');
      // ⚠️ `querySelector` **只找后代**。最内层的那条带很可能**自己就是**那张
      // 全幅 hero 图/视频 —— 于是它被标成 noimg，图 hero 和纯文字 hero 聚成一类。
      const IMGISH = 'img, picture, video, svg';
      const hasImg = (el.matches(IMGISH) || el.querySelector(IMGISH)) ? 'img' : 'noimg';
      const chars = (el.textContent || '').trim().length;
      const density = chars < 120 ? 'bare' : (chars < 800 ? 'some' : 'lots');
      return `${layout}|${hasImg}|${density}`;
    };
    const shapes = new Map();
    for (const el of sections) {
      const k = sig(el);
      shapes.set(k, (shapes.get(k) || 0) + 1);
    }
    // 交互重心：值得动手的东西。
    // ⚠️ 三个坑，都是审查在真站上撞出来的：
    //   ① `[class*=tab]` 是子串匹配 → `.tabular-figures`、`.tabbed-wrapper` 全中；
    //      `:not([class*=table])` 也补不完。改成按 class **token** 比对。
    //   ② 一个元素同时命中两条选择器（既 `[role=tab]` 又 `.tab-item`）会被数两遍。
    //      改用 Set 存元素再取 size。
    //   ③ 裸 `[aria-expanded]` 把汉堡菜单、下拉导航全算成"手风琴"。它们确实是
    //      disclosure，但不是"这页的交互重心"。单列一档，别混进 accordions。
    const clsTokens = (el) => (typeof el.className === 'string'
      ? el.className.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : []);
    const hasTok = (el, names) => clsTokens(el).some(t => names.has(t));
    const setOf = (sel, pred) => {
      const out = new Set();
      for (const el of document.querySelectorAll(sel)) { if (!pred || pred(el)) out.add(el); }
      return out;
    };
    const TAB_TOK = new Set(['tab', 'tabs']);
    const ACC_TOK = new Set(['accordion', 'accordions', 'collapse', 'collapsible', 'disclosure']);
    const interactive = {
      forms: setOf('form').size,
      tabs: setOf('[role=tab], [role=tablist], [class]', el => el.getAttribute('role') === 'tab'
        || el.getAttribute('role') === 'tablist' || hasTok(el, TAB_TOK)).size,
      accordions: setOf('details, [class]', el => el.tagName === 'DETAILS' || hasTok(el, ACC_TOK)).size,
      disclosures: setOf('[aria-expanded]').size,   // 多半是导航开关，单独列
      draggables: setOf('[draggable=true], input[type=range]').size,
      videos: setOf('video').size,
    };

    return {
      url: location.href,
      title: document.title,
      viewportWidth: window.innerWidth,
      palette,
      fonts,
      skeleton: {
        sectionCount: sections.length,
        shapeKinds: shapes.size,
        shapes: [...shapes.entries()].map(([k, n]) => ({ signature: k, count: n })),
        interactive,
        // disclosures 不计进"交互点"：它多半是汉堡菜单/下拉导航，
        // 每个站都有，加进去只会把这个数字变成噪音
        interactivePoints: ['forms', 'tabs', 'accordions', 'draggables', 'videos']
          .reduce((a, k) => a + interactive[k], 0),
        _note: '启发式：节的形状种类是按布局签名聚类数出来的，当对照数字用，别当真相。'
          + '同一页做 A/B 最可靠；跨页比较受各家标记方式影响，看数量级别抠个位数。',
      },
    };
  };
}
/* eslint-enable no-undef */

/**
 * 采一次。
 * @param {object} p
 * @param {import('playwright').Page} p.page
 * @param {string} p.workspaceRoot
 * @param {string[]} p.kinds  screenshot / palette / fonts / css / skeleton
 * @param {string} [p.name]   文件名主干（不给就按站名+时间）
 * @param {string} [p.lookingFor] agent 当时在找什么 —— 三天后没有这句就是一堆不知道哪来的图
 * @param {string} [p.selector] css 那一种要指一块
 * @param {object} [p.ids] {sessionId, runId}
 * @param {(buf: Buffer) => Promise<{data: string, mimeType: string, note?: string}>} [p.normalize]
 * @returns {Promise<{files: Array<{rel: string, kind: string, bytes: number}>, data: object}>}
 */
export async function capture({
  page, workspaceRoot, kinds, name, lookingFor, selector, ids = {}, normalize,
}) {
  const info = await page.evaluate(`(${collectorSource().toString()})()`);
  // 一站一文件夹（见 CAPTURE_DIR 的注释）。子目录相对工作区根的前缀，
  // 落盘和返回给 agent 的 rel 都从它拼 —— 只有一处拼法。
  const siteDir = path.posix.join(CAPTURE_DIR, siteDirOf(info.url));
  const dir = path.join(workspaceRoot, siteDir);
  const metaDir = path.join(dir, '.meta');
  await fs.mkdir(metaDir, { recursive: true });

  // 文件名主干不再重复站名（目录已经说了是哪个站）：给的名字优先，
  // 否则用页面在站内的位置 + 时间 —— 同一个站逛三层会采三份，得分得开。
  const pageSlug = (() => {
    try {
      const segs = new URL(info.url).pathname.split('/').filter(Boolean);
      return segs.length ? slug(segs.slice(-2).join('-')) : '首页';
    } catch { return '页面'; }
  })();
  // `0818-2253`（月日-时分，+8 时区）。原来是 `.slice(5,16)` 直接把 ISO 的
  // `08-18T22:53` 去掉分隔符，读出来是 `08-182253` —— 文件名是给人看的
  const iso = new Date(Date.now() + 8 * 3600e3).toISOString();
  const stamp = `${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  const stem = slug(name || `${pageSlug}-${stamp}`);

  const files = [];
  const failed = [];

  /** 出处 sidecar 的键 = 文件名去掉最后一节扩展名（`listReferences` 用的是同一条规则） */
  const metaStemOf = (fileName) => fileName.replace(/\.[^.]+$/, '');

  /**
   * 写一份素材 + 它自己的出处。
   *
   * ⭐ **类别写在文件名里**（2026-08-18 用户拍板）：`.screenshot.webp` /
   * `.palette.json` / `.fonts.json` / `.skeleton.json` / `.css`。这跟站点产物是
   * 同一条规矩 —— 形态由文件名表明，不用打开文件才知道里面是什么。
   * 在这之前调色板/字体/结构/CSS **全挤在一个 `<名>.json` 里**，抽屉里看到的
   * 是一个什么都可能的 json，agent 下个会话想复用得先读一遍才知道有没有它要的。
   *
   * 出处**一份文件一份**，不是一次采集一份：每份素材要能单独被认出来
   * （三天后 `assets/references/web/` 里的东西是靠自己说明自己的）。
   */
  const write = async (suffix, body, kind) => {
    const fileName = `${stem}${suffix}`;
    const rel = path.posix.join(siteDir, fileName);
    await fs.writeFile(path.join(workspaceRoot, rel), body);
    files.push({ rel, kind, bytes: Buffer.byteLength(body) });
    await fs.writeFile(path.join(metaDir, `${metaStemOf(fileName)}.json`), `${JSON.stringify({
      kind,
      sourceUrl: info.url,
      pageTitle: info.title,
      capturedAt: new Date().toISOString(),
      viewportWidth: info.viewportWidth,
      lookingFor: lookingFor || null,
      selector: selector || null,
      sessionId: ids.sessionId ?? null,
      runId: ids.runId ?? null,
    }, null, 2)}\n`, 'utf8');
    return rel;
  };

  /** 一档一个 json，各自带齐来历 —— 拿单独一份出来看也知道它是什么 */
  const writeJson = (suffix, payload, kind) => write(suffix, `${JSON.stringify({
    source: info.url, title: info.title, kind, ...payload,
  }, null, 2)}\n`, kind);

  // ⚠️ **每一种单独 try**。第一版是一路顺着写下来的，真跑时 `selector: 'main'` 在
  // MDN 上等了 30 秒超时 → 整个函数抛错 → 调色板/字体/结构/CSS 明明都已经采到了
  // （evaluate 跑在最前面），连出处 sidecar 都没写下去，**一次白采**。
  // 部分失败不该丢掉已经成功的部分。
  if (kinds.includes('screenshot')) {
    try {
      let raw;
      if (selector) {
        const loc = page.locator(selector).first();
        // 短超时快速失败：一个选不中的选择器不该让整次采集卡 30 秒
        await loc.waitFor({ state: 'visible', timeout: 6000 });
        raw = await loc.screenshot({ type: 'png', timeout: 8000, scale: 'css' });
      } else {
        raw = await page.screenshot({ type: 'png', fullPage: false, scale: 'css' });
      }
      // 走跟感知层同一条归一化（webp、缩到 API 反正会缩的规格）—— 参考图不需要
      // 无损，而 76MB 的 references 目录已经是这个项目的既有账
      const shot = normalize ? await normalize(raw) : null;
      const buf = shot ? Buffer.from(shot.data, 'base64') : raw;
      await write(shot ? '.screenshot.webp' : '.screenshot.png', buf, 'screenshot');
    } catch (err) {
      failed.push(`screenshot: ${err.message.split('\n')[0]}`
        + (selector ? `（选择器 ${selector} 可能选不中或不可见 —— 先用 browser_read 看页面上有什么）` : ''));
    }
  }

  const bundle = {};
  if (kinds.includes('palette')) bundle.palette = info.palette;
  if (kinds.includes('fonts')) bundle.fonts = info.fonts;
  if (kinds.includes('skeleton')) bundle.skeleton = info.skeleton;
  if (kinds.includes('css') && selector) {
    // 复用 explain_style 那条 CDP 通路：拿这个元素**命中的全部规则**，
    // 而不是 computed 值 —— 前者能照抄，后者只是结果
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) {
        // 原来这里没有 else：选择器选不中就静默少一份产物，agent 看不到
        failed.push(`css: 选择器 ${selector} 在页面上选不中（先 browser_read 看页面上有什么）`);
      } else {
        const m = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
        bundle.css = (m.matchedCSSRules || []).map(r => ({
          selector: r.rule?.selectorList?.text,
          media: (r.rule?.media || []).map(x => x.text).filter(Boolean),
          declarations: (r.rule?.style?.cssProperties || [])
            .filter(d => !d.disabled && d.value != null && d.range)   // 有 range = 作者真写了这条
            .map(d => `${d.name}: ${d.value}${d.important ? ' !important' : ''}`),
        })).filter(r => r.declarations.length);
      }
    } catch (err) {
      // ⚠️ 原来只写进磁盘 JSON 的 cssError，返回给 agent 的文本里**一个字都没有**
      // （打印分支只在 `r.data.css` 存在时才跑）→ css 这一档完全静默失败
      bundle.cssError = err.message;
      failed.push(`css: ${err.message.split('\n')[0]}`);
    }
  }
  // motion 档（08-21）：引擎在 engine/motion/inventory.js（对页面无知，产物会话也能用）。
  // 排在截图之后 —— 它会真滚一遍页面（做完滚回顶），别把滚动痕迹截进 screenshot 档。
  if (kinds.includes('motion')) {
    try {
      const { collectMotionInventory } = await import('../motion/inventory.js');
      bundle.motion = await collectMotionInventory(page);
    } catch (err) {
      failed.push(`motion: ${err.message.split('\n')[0]}`);
    }
  }
  // 一档一文件。写盘也各自 try —— 一档写不下去不该把别的档带走
  // （跟上面「每一种单独 try」同一条理由，只是这次是磁盘不是页面）。
  for (const [key, suffix] of [['palette', '.palette.json'], ['fonts', '.fonts.json'], ['skeleton', '.skeleton.json'], ['motion', '.motion.json']]) {
    if (bundle[key] == null) continue;
    try { await writeJson(suffix, { [key]: bundle[key] }, key); }
    catch (err) { failed.push(`${key}: 写盘失败 ${err.message}`); }
  }
  if (bundle.css) {
    // ⭐ CSS 落成**真的 CSS**，不是包在 json 里的字符串数组：这一档的全部价值
    // 就是"能照抄"，而 json 里的它要先被解开一层才能用。扩展名本身就是类别。
    try { await write('.css', cssText(bundle.css, info, selector), 'css'); }
    catch (err) { failed.push(`css: 写盘失败 ${err.message}`); }
  }

  return { files, failed, data: { ...bundle, url: info.url, title: info.title } };
}
