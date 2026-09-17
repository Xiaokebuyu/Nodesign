/**
 * server/engine/browse/refs.js — 元素引用（ref_N）登记 + 词法找元（2026-08-21）
 *
 * 给 `browser_find` / `browser_computer` 用。形状照 Anthropic 的 browser use
 * toolset（browser_toolset_20260801）：`find` 返回带 `[ref_N]` 的元素清单，后面的
 * 点击/悬停/滚到 可以拿 ref 当靶子，不必再从截图上读坐标。
 *
 * ## ref 的生命周期（照规格，不自作聪明）
 *
 * - ref 挂在**页面的 window** 上（`window.__nd_refs`）：导航 = 新 document =
 *   自动清空。这正是规格要的"ref scoped to the tab, valid until it navigates"。
 * - 同一页内编号**只增不回卷**：agent 手里的 ref_3 在它重新 find 之后还是那个元素
 *   （规格原话：don't renumber references you've already handed out）。
 * - 元素被页面重渲染拆掉 = `isConnected` 为假 = stale。按规格回一条可执行的错误
 *   文本，agent 重新 find 一次就好。
 *
 * ## find 是**词法**匹配，不是语义
 *
 * Claude in Chrome 的 find 背后有个小模型；我们这台 1 vCPU 的机器不为每次找元
 * 多付一次模型调用。这里用的是：query 分词（英文按词、中文按字+双字）对元素的
 * 可见文字 / aria-label / placeholder / alt / 角色 / href 打分。工具描述里**明说**
 * 这一点 —— agent 用元素上真出现的词去找，比用它脑补的意图词命中得多。
 */

/**
 * 在页面里跑：收集候选元素、登记 ref、按 query 打分。
 * ⚠️ 整段在浏览器上下文执行，不能引用外面的东西。
 *
 * @param {import('playwright').Page} page
 * @param {{query: string, limit?: number}} opts
 * @returns {Promise<{matches: object[], candidates: number, url: string}>}
 */
export function findInPage(page, { query, limit = 20 }) {
  return page.evaluate(({ q, limit }) => {
    const W = window;
    if (!W.__nd_refs || W.__nd_refs.url !== location.href) {
      W.__nd_refs = { n: 0, els: new Map(), byEl: new WeakMap(), url: location.href };
    }
    const reg = W.__nd_refs;
    const refOf = (el) => {
      const had = reg.byEl.get(el);
      if (had) return had;
      const id = `ref_${++reg.n}`;
      reg.els.set(id, el);
      reg.byEl.set(el, id);
      return id;
    };

    const SEL = 'a[href], button, input, select, textarea, summary, label, [role], [onclick], '
      + '[contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), '
      + 'h1, h2, h3, img[alt], [aria-label]';
    const vw = W.innerWidth;
    const vh = W.innerHeight;
    const visible = (el) => {
      if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
      if (typeof el.checkVisibility === 'function'
        && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const roleOf = (el) => {
      const r = el.getAttribute('role');
      if (r) return r;
      const t = el.tagName.toLowerCase();
      if (t === 'a') return 'link';
      if (t === 'button' || t === 'summary') return 'button';
      if (t === 'input') {
        const ty = (el.type || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
        if (ty === 'checkbox') return 'checkbox';
        if (ty === 'radio') return 'radio';
        if (ty === 'range') return 'slider';
        if (ty === 'file') return 'file';
        return 'textbox';
      }
      if (t === 'textarea') return 'textbox';
      if (t === 'select') return 'combobox';
      if (/^h[1-6]$/.test(t)) return 'heading';
      if (t === 'img') return 'image';
      if (t === 'label') return 'label';
      if (el.isContentEditable) return 'textbox';
      return 'generic';
    };
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const nameOf = (el) => {
      const aria = clean(el.getAttribute('aria-label'));
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = clean(by.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
        if (t) return t;
      }
      const t = el.tagName.toLowerCase();
      if (t === 'input' || t === 'textarea' || t === 'select') {
        if (el.labels && el.labels.length) { const l = clean(el.labels[0].textContent); if (l) return l; }
        const ph = clean(el.getAttribute('placeholder'));
        if (ph) return ph;
        if (t === 'input' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return clean(el.value);
      }
      if (t === 'img') return clean(el.getAttribute('alt'));
      return clean(el.innerText || el.textContent).slice(0, 80) || clean(el.getAttribute('title'));
    };

    // ── query 分词：英文按词；中文按单字 + 双字（"搜索框" 能命中 "搜索"）──
    const qlow = clean(q).toLowerCase();
    const toks = new Set();
    for (const m of qlow.match(/[a-z0-9_-]+/g) || []) toks.add(m);
    for (const run of qlow.match(/[㐀-鿿]+/g) || []) {
      for (let i = 0; i < run.length; i += 1) {
        toks.add(run[i]);
        if (i + 1 < run.length) toks.add(run.slice(i, i + 2));
      }
    }
    const ROLE_WORDS = {
      button: ['button', 'btn', '按钮', '按键'],
      link: ['link', 'anchor', '链接'],
      textbox: ['input', 'field', 'textbox', 'search', 'box', 'textarea', 'editor', '输入框', '搜索框', '文本框', '输入', '搜索'],
      checkbox: ['checkbox', 'check', '复选框', '勾选'],
      radio: ['radio', '单选'],
      combobox: ['select', 'dropdown', 'combobox', '下拉', '选择'],
      heading: ['heading', 'title', 'header', '标题'],
      image: ['image', 'img', 'picture', 'photo', 'logo', 'icon', '图', '图片', '图标'],
      tab: ['tab', '标签页', '页签'],
      menuitem: ['menu', 'menuitem', '菜单'],
      slider: ['slider', 'range', '滑块'],
      file: ['file', 'upload', '上传', '文件'],
    };

    const els = [...document.querySelectorAll(SEL)].filter(visible);
    const scored = [];
    els.forEach((el, order) => {
      const name = nameOf(el);
      const role = roleOf(el);
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      const hint = [el.id, el.className && String(el.className), el.getAttribute('placeholder'),
        el.getAttribute('title'), el.getAttribute('name'), href].filter(Boolean).join(' ').toLowerCase();
      const nlow = name.toLowerCase();
      const rwords = ROLE_WORDS[role] || [role];
      let score = 0;
      if (qlow && nlow === qlow) score += 6;
      else if (qlow && nlow.includes(qlow)) score += 4;
      for (const tk of toks) {
        if (tk.length >= 2 && nlow.includes(tk)) score += 3;
        else if (tk.length === 1 && /[㐀-鿿]/.test(tk) && nlow.includes(tk)) score += 1;
        if (rwords.includes(tk)) score += 2;
        if (hint.includes(tk)) score += 1;
      }
      if (score <= 0) return;
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      if (inView) score += 0.5;
      scored.push({
        el, order, score, role, name, href,
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height), inView,
      });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    const matches = scored.slice(0, limit).map(({ el, order, ...rest }) => ({ ref: refOf(el), ...rest }));
    return { matches, candidates: els.length, url: location.href };
  }, { q: query, limit });
}

/** 把一个 ref 解析成 ElementHandle；stale/未知 → null。 */
export async function handleForRef(page, ref) {
  const h = await page.evaluateHandle((id) => {
    const r = window.__nd_refs;
    const el = r && r.els.get(id);
    return el && el.isConnected ? el : null;
  }, ref);
  const el = h.asElement();
  if (!el) { await h.dispose().catch(() => {}); return null; }
  return el;
}

/**
 * 规格里那句可执行的 stale 错误文本（agent 读了知道下一步是什么）。
 * findTool 按调用方给（09-17）：artifact_computer 也走这句，写死 browser_find 会把 agent 指到
 * 另一个浏览器（浏览通道）上去找，那边根本没有这一页。
 */
export const staleRefText = (ref, findTool = 'browser_find') =>
  `Error: ${ref} is stale or not found on the current page. Call ${findTool} again to get fresh references.`;

/** find 结果 → 给 agent 的行 */
export function formatMatches(r, query) {
  if (!r.matches.length) {
    return [
      `「${query}」没找到匹配的元素（这一页有 ${r.candidates} 个可交互/可读元素）。`,
      '匹配是词法的：换成元素上**真出现**的词（按钮文字、占位符、链接文案），或者写角色词（button/link/input/图片）。',
      '还是没有就 browser_read 看看页面上到底有什么字，或 browser_computer screenshot 直接看。',
    ];
  }
  const lines = [`找到 ${r.matches.length} 个（候选 ${r.candidates}）—— ref 可直接给 browser_computer，坐标是视口像素：`];
  for (const m of r.matches) {
    const where = m.inView ? `@(${m.x},${m.y})` : `@(${m.x},${m.y}) [视口外${m.y < 0 ? '↑' : '↓'}，点之前先 scroll_to]`;
    const href = m.href && m.role === 'link' ? `  → ${m.href.slice(0, 70)}` : '';
    lines.push(`  ${m.ref}  ${m.role}  「${m.name || '(无文字)'}」 ${m.w}×${m.h} ${where}${href}`);
  }
  return lines;
}
