/**
 * server/engine/browse/page-digest.js — 「这一页上有什么」的唯一一份采集器（2026-08-18）
 *
 * 两个消费者：`browser_read`（全量：正文 + 标题层级 + 链接清单）和
 * `browser_navigate`（**打开就顺手带回一份摘要**）。
 *
 * ## 为什么 navigate 要带摘要
 *
 * 量过一轮（2026-08-18，这台机器）：冷启动 738ms、导航 1.0~4.5s、读页
 * 29~183ms、视口截图 0.2~4.2s。**浏览器本体不慢**。慢的是回合数 ——
 * `navigate` → `read` → `screenshot` 是三次模型往返，每一次的模型延迟都比
 * 上面任何一个数字大。而 navigate 之后紧跟一次 read 几乎是必然的（不看看
 * 页面上有什么，下一步无从决定）。
 *
 * 所以把 read 的采集器抽出来给 navigate 复用：一次导航直接回答"打开了，
 * 上面有这些东西，站内可以往这几个地方去"。**省掉的是一整个回合**，
 * 这是这条通道唯一真能砍掉的时间。
 *
 * 抽出来还有第二个收益：`browser_read` 报的东西和 `browser_navigate` 报的
 * 东西**只有一个来源**。抄两份的下场是"同一页，两个工具说的结构数不一样"。
 */

/**
 * 页面里跑的采集器。⚠️ 整段在浏览器上下文执行，不能引用外面的东西。
 *
 * @param {import('playwright').Page} page
 * @param {{selector?: string|null, links?: boolean}} opts
 */
export async function collectPage(page, { selector = null, links = true } = {}) {
  const data = await page.evaluate(({ sel, want }) => {
    const root = sel ? document.querySelector(sel) : (document.querySelector('main') || document.body);
    if (!root) return { missing: true };
    const headings = [...root.querySelectorAll('h1,h2,h3')]
      .map(h => `${'#'.repeat(Number(h.tagName[1]))} ${(h.textContent || '').trim().slice(0, 90)}`)
      .filter(t => t.length > 2).slice(0, 40);
    // ⛔ 链接**不能**跟正文共用 root。没传 selector 时正文 root 是 `main`
    // （对：导航文字是噪音），但链接跟着 main 一收，站名、整条导航、页脚法务
    // 链接就全没了 —— 实测 6 个链接只报出 1 个。而链接清单正是"下一步去哪"
    // 的唯一依据，browser_click 的全部意义也是跟这些链接。
    // 所以：正文按 root 收，链接按**整页**收，再标出它在哪个区。
    const linkRoot = sel ? root : document;
    const regionOf = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const tag = n.tagName ? n.tagName.toLowerCase() : '';
        if (tag === 'nav') return 'nav';
        if (tag === 'header') return 'header';
        if (tag === 'footer') return 'footer';
        if (tag === 'aside') return 'aside';
        const role = n.getAttribute && n.getAttribute('role');
        if (role === 'navigation') return 'nav';
        if (role === 'contentinfo') return 'footer';
      }
      return 'content';
    };
    const seen = new Set();
    const RANK = { content: 0, header: 1, nav: 1, aside: 2, footer: 3 };
    // ⚠️ **排序必须在截断之前**，而且得在页面里做：按文档顺序取前 80 条，
    // 侧边导航就把配额吃干了（MDN 实测 79 条站内链接里前 30 条有 29 条是 nav，
    // 正文那几条一条都没进来）。要跟的多半是正文里那几条。
    const all = want ? [...linkRoot.querySelectorAll('a[href]')].map((a) => {
      const href = a.href;
      if (!href || !/^https?:/.test(href) || seen.has(href)) return null;
      seen.add(href);
      const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return { href, label, internal: a.hostname === location.hostname, region: regionOf(a) };
    }).filter(Boolean) : [];
    const linkList = all
      .map((l, i) => ({ l, i }))
      .sort((x, y) => (RANK[x.l.region] ?? 0) - (RANK[y.l.region] ?? 0) || x.i - y.i)
      .map(x => x.l)
      .slice(0, 80);
    return {
      text: (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim(),
      headings, linkList,
      textScope: sel || (document.querySelector('main') ? 'main' : 'body'),
      counts: {   // ⚠️ 这几个数是**整页**的，别跟着正文 root 缩（原来标着"页面结构"其实是 main 里的）
        sections: document.querySelectorAll('section, article').length,
        images: document.querySelectorAll('img').length,
        forms: document.querySelectorAll('form').length,
      },
    };
  }, { sel: selector, want: links });
  // 选择器没命中：顺手带回页面上实有的地标，agent 下一次能直接挑一个用（09-17）
  if (data?.missing) data.landmarks = await page.evaluate(pageLandmarks).catch(() => []);
  return data;
}

/**
 * 页面上实有的地标元素（最多 8 个，带数量）。⚠️ 会被 page.evaluate 序列化进浏览器执行，
 * 不能引用模块里的任何东西；参数只给单测传假 document 用。
 * @returns {{sel: string, count: number}[]}
 */
export function pageLandmarks(doc = document) {
  const out = [];
  for (const sel of ['main', '[role="main"]', 'article', 'section', 'header', 'nav', 'aside', 'footer']) {
    const n = doc.querySelectorAll(sel).length;
    if (n) out.push({ sel, count: n });
  }
  // 带 id 的容器（#app / #pricing 这类最常被猜错的）；id 只收能直接写进 selector 的
  const BLOCK = /^(DIV|SECTION|MAIN|ARTICLE|ASIDE|NAV|HEADER|FOOTER|UL|OL|FORM|TABLE)$/;
  for (const el of doc.querySelectorAll('body [id]')) {
    if (out.length >= 8) break;
    if (BLOCK.test(el.tagName) && /^[A-Za-z][\w-]*$/.test(el.id)) out.push({ sel: `#${el.id}`, count: 1 });
  }
  return out.slice(0, 8);
}

/** 选择器没命中时给 agent 的几行：说没命中 + 实有地标 + 另一条路（读全页） */
export function formatMissing(selector, data) {
  const lm = data?.landmarks || [];
  return [
    `选择器没匹配到元素：${selector}`,
    lm.length
      ? `这一页实有的地标元素（括号里是数量，可直接当 selector）：${lm.map((l) => `${l.sel}（${l.count}）`).join('、')}`
      : '这一页没有 main / article / section 这类地标元素，也没有带 id 的容器。',
    '或者去掉 selector 读全页。',
  ];
}

/** 区标只在非 content 时打 —— 正文链接是默认情况，标了全是噪音 */
const fmtLink = (l) => `  ${l.label || '(无文字)'}${l.region && l.region !== 'content' ? ` [${l.region}]` : ''} → ${l.href}`;

/**
 * 采集结果 → 给 agent 的文本行。
 *
 * @param {object} data  collectPage 的返回
 * @param {{compact?: boolean, cap?: number}} opts
 *   compact = navigate 用的摘要档：短正文 + 少量标题 + 站内链接，够决定下一步就行
 * @returns {string[]} 行（调用方自己在前面拼"现在在哪"）
 */
export function formatPage(data, { compact = false, cap } = {}) {
  const textCap = cap ?? (compact ? 700 : 4000);
  const maxHeadings = compact ? 12 : 40;
  const maxInner = compact ? 14 : 30;
  const body = data.text.length > textCap
    ? `${data.text.slice(0, textCap)}\n… （还有 ${data.text.length - textCap} 个字符${compact ? '，要全文用 browser_read' : '，要全文就加大 maxChars 或用 selector 缩范围'}）`
    : data.text;
  // linkList 已经在页面里按区排过序（正文优先），这里只分站内/站外
  const inner = data.linkList.filter(l => l.internal);
  const outer = data.linkList.filter(l => !l.internal);
  const headings = data.headings.slice(0, maxHeadings);

  return [
    `结构（整页）：${data.counts.sections} 个 section/article · ${data.counts.images} 张图 · ${data.counts.forms} 个表单`,
    compact ? null
      : `正文读的是 <${data.textScope}>${data.textScope === 'main' ? '（导航/页脚的文字不在里面，但它们的链接在下面）' : ''}`,
    headings.length ? `\n标题层级：\n${headings.join('\n')}` : null,
    `\n正文：\n${body || '(读不到文字 —— 可能整页是图或靠 JS 渲染，试 browser_navigate 带 waitUntil:"networkidle"，或直接截图看)'}`,
    inner.length
      ? `\n站内链接（${inner.length}${inner.length > maxInner ? `，列前 ${maxInner}` : ''}）—— 往里翻就跟这些：\n${inner.slice(0, maxInner).map(fmtLink).join('\n')}`
      : null,
    outer.length && !compact ? `\n站外链接（${outer.length}，只列前 8）：\n${outer.slice(0, 8).map(fmtLink).join('\n')}` : null,
  ].filter(Boolean);
}
