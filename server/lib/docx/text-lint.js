/**
 * text-lint.js — 构建后的字符层/版式层体检（2026-08-19）。
 *
 * 闭合 schema 管格式键、渲染目视管版面，**文字符号这一层两边都管不着**：
 * 斜杠带不带空格不一致、`12ms` 缺空隙、中文后面跟半角逗号 —— 人眼查全文
 * 一致性不可靠，正则穷举才靠得住。检查跑在 **content 源**上（不解 docx），
 * 每条发现都能定位到具体块。
 *
 * 三条设计红线（放宽任何一条都会把这层变成噪音）：
 *   1. **只收高精度规则**。假警报会训练 agent 忽略警报 —— 拿不准的宁可不报。
 *   2. **一致性类规则全文聚合后才裁决**：两种写法并存才是问题，全文统一用
 *      哪种都不是（斜杠风格、中西文间距都是排版偏好，不是对错）。
 *   3. **只报不改**。文字内容是 agent/用户的，引擎不代笔。
 *
 * 两档措辞：`errors` = 按 GB/T 15834 / 排版常识基本可断定是错的；
 * `notes` = 建议（惯例/一致性），采不采纳由写的人定。都不挡构建。
 */

import { effectiveSizePt } from './build.js';

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf';

/** 一个段落块 → 拼好的纯文本（run 边界处的间距问题也要能查到，所以先拼再扫） */
function textOfPara(b) {
  if (typeof b?.text === 'string') return b.text;
  const parts = [];
  for (const r of b?.runs ?? []) {
    if (typeof r === 'string') { parts.push(r); continue; }
    if (r?.tab) parts.push('\t');   // <w:tab/> 排在这个 run 的文字前面（build.js buildRun）
    if (r && typeof r.text === 'string') parts.push(r.text);
    else if (r?.br) parts.push('\n');
    // fld（页码域）没有文字形态，跳过
  }
  return parts.join('');
}

/** content + 页眉页脚 + 表格单元格 → [{ where, text }]，where 能定位回源 */
export function collectTexts(content, opts = {}) {
  const out = [];
  const push = (where, b) => {
    const t = textOfPara(b);
    if (t.trim()) out.push({ where, text: t });
  };
  for (const [i, b] of (content ?? []).entries()) {
    if (!b || typeof b !== 'object') continue;
    if (b.t === 'p') push(`content[${i}]`, b);
    else if (b.t === 'table') {
      for (const [ri, row] of (b.rows ?? []).entries()) {
        for (const [ci, cell] of (row ?? []).entries()) {
          if (typeof cell === 'string') { if (cell.trim()) out.push({ where: `content[${i}].rows[${ri}][${ci}]`, text: cell }); }
          else if (cell && typeof cell === 'object') push(`content[${i}].rows[${ri}][${ci}]`, cell);
        }
      }
    }
  }
  for (const [name, blocks] of [['header', opts.header], ['footer', opts.footer]]) {
    for (const [i, b] of (blocks ?? []).entries()) {
      if (b?.t === 'p') push(`${name}[${i}]`, b);
    }
  }
  return out;
}

/** 命中清单 → 一行报文：最多点名 4 处，多的收成 ×N */
function fmtHits(hits, max = 4) {
  const shown = hits.slice(0, max).map(h => `${h.where}「${h.sample}」`).join('、');
  return hits.length > max ? `${shown} 等 ${hits.length} 处` : shown;
}

/** 在 text 里跑正则收命中（sample 带一点上下文，agent 才对得上号） */
function scan(texts, re) {
  const hits = [];
  for (const { where, text } of texts) {
    for (const m of text.matchAll(re)) {
      const s = Math.max(0, m.index - 4);
      hits.push({ where, sample: text.slice(s, m.index + m[0].length + 4).replace(/\n/g, ' ') });
    }
  }
  return hits;
}

export function lintDocxSource({ tokens, content, opts = {} }) {
  const errors = [];
  const notes = [];
  const texts = collectTexts(content, opts);

  /* ── 错误档（基本可断定是错的） ── */

  // 重复标点：「。。」「，，」几乎必是手误。！？的叠用是修辞，不管
  for (const [re, label] of [[new RegExp('([，。；、：])\\1+', 'g'), '重复标点']]) {
    const hits = scan(texts, re);
    if (hits.length) errors.push(`${label}：${fmtHits(hits)}`);
  }

  // 括号全半角不配对：「（x)」「(x）」
  {
    const hits = scan(texts, /（[^（）()\n]*\)|\([^()（）\n]*）/g);
    if (hits.length) errors.push(`括号全半角不配对：${fmtHits(hits)}`);
  }

  // 中文后紧跟半角标点（GB/T 15834：中文语境用全角）。只查后继是中文/空白/行尾
  // 的情形 —— 「12:30」「Node.js, Express」这类西文语境不碰
  {
    const hits = scan(texts, new RegExp(`[${CJK}][,;?!:](?=[${CJK}\\s]|$)`, 'gm'));
    if (hits.length) errors.push(`中文后面跟着半角标点（该用全角）：${fmtHits(hits)}`);
  }

  /* ── 建议档：单点惯例 ── */

  // 数值与单位符号之间留空隙（GB 3100 惯例）。单位表故意收窄：裸 s/m/g 歧义太大
  {
    const hits = scan(texts, /\d(?:ms|GB|MB|KB|TB|Hz|kHz|MHz|fps|mm|cm|km|kg|dpi)(?![A-Za-z])/g);
    if (hits.length) notes.push(`数字和单位之间通常留一个空格（如「150 ms」）：${fmtHits(hits)}`);
  }

  /* ── 建议档：一致性类（全文聚合，两种写法并存才报） ── */

  // 中西文之间的空格。数字不算（「第3个」加空格属于过度矫正），URL 整段跳过
  {
    let spaced = 0;
    const unspaced = [];
    for (const { where, text } of texts) {
      const t = text.replace(/\S*:\/\/\S*/g, ' ');
      for (const m of t.matchAll(new RegExp(`[${CJK}][A-Za-z]|[A-Za-z][${CJK}]`, 'g'))) {
        unspaced.push({ where, sample: t.slice(Math.max(0, m.index - 4), m.index + m[0].length + 4) });
      }
      spaced += (t.match(new RegExp(`[${CJK}] [A-Za-z]|[A-Za-z] [${CJK}]`, 'g')) ?? []).length;
    }
    if (unspaced.length && spaced > unspaced.length) {
      notes.push(`中西文之间的空格不一致：全文 ${spaced} 处有空格，这 ${unspaced.length} 处没有 —— ${fmtHits(unspaced)}`);
    }
    // 全文都不空 = 一种自洽的风格，不报
  }

  // 斜杠两侧空格的一致性。三类豁免：带协议的 URL、无协议的域名路径
  //（github.com/xxx —— 给它"统一"加空格反而是改错）、两侧都是数字的（日期 03/07）
  {
    const spaced = [];
    const tight = [];
    for (const { where, text } of texts) {
      const t = text.replace(/\S*:\/\/\S*/g, ' ');
      for (const m of t.matchAll(/([\w.\-一-鿿]+) ?\/ ?([\w.\-一-鿿])/g)) {
        if (/\.[a-z]{2,4}$/i.test(m[1])) continue;   // 左边以 .com/.cn/.js 这类结尾 = 域名或文件名
        if (/\d$/.test(m[1]) && /\d/.test(m[2])) continue;
        (m[0].includes(' ') ? spaced : tight).push({ where, sample: t.slice(Math.max(0, m.index - 3), m.index + m[0].length + 6) });
      }
    }
    if (spaced.length && tight.length) {
      const [minor, label] = spaced.length < tight.length ? [spaced, '带空格'] : [tight, '不带空格'];
      notes.push(`斜杠写法不一致（${spaced.length} 处「A / B」vs ${tight.length} 处「A/B」），少数派是${label}的：${fmtHits(minor)}`);
    }
  }

  // 日期范围连接号的一致性（字符本身不裁 —— 「-」「–」「至」都是有人在用的惯例，
  // 一份文档里混着用才是问题）
  {
    const styles = new Map();   // 连接串 → hits
    for (const { where, text } of texts) {
      for (const m of text.matchAll(/\d{4}[.．年/-]\d{1,2}[月]?( ?[-–—~～至] ?)(?=\d{4}|至今|今)/g)) {
        const key = m[1];
        if (!styles.has(key)) styles.set(key, []);
        styles.get(key).push({ where, sample: text.slice(Math.max(0, m.index), m.index + m[0].length + 7) });
      }
    }
    if (styles.size > 1) {
      const desc = [...styles.entries()].map(([k, v]) => `「${k.replace(/ /g, '␣')}」×${v.length}`).join('、');
      notes.push(`日期范围的连接号写法不统一：${desc}`);
    }
  }

  /* ── 版式断言（token 层，只收零误报的三条） ── */

  // 行距小于单倍 = 文字上下行叠压，多半是把磅值当倍数写了
  const checkSp = (whereName, sp) => {
    if (sp && (sp.lineRule ?? 'multiple') === 'multiple' && sp.line != null && sp.line < 1) {
      errors.push(`${whereName}.spacing.line = ${sp.line}（倍数小于 1，文字会叠压）`);
    }
  };
  checkSp('base', tokens?.base?.spacing);
  for (const [id, st] of Object.entries(tokens?.styles ?? {})) {
    checkSp(`styles.${id}.para`, st?.para?.spacing);

    // 标题（有 outlineLevel 的）不带 keepNext → 会孤零零留在页底
    if (st?.para?.outlineLevel != null && st.para.keepNext !== true) {
      notes.push(`styles.${id} 是标题（outlineLevel ${st.para.outlineLevel}）但没写 keepNext —— 分页时它可能孤零零留在页底`);
    }
  }

  // 标题层级字号倒挂：更深一级的某个标题比浅一级的某个标题还大。
  // 同层可以有多种字号（Title 和 Heading1 常同在层级 0），所以比的是
  // 浅层的**最小**对深层的**最大** —— 只要深层最大越过了浅层最小就是倒挂
  {
    const byLevel = new Map();   // level → { min: {id,pt}, max: {id,pt} }
    for (const [id, st] of Object.entries(tokens?.styles ?? {})) {
      const lv = st?.para?.outlineLevel;
      if (lv == null) continue;
      const pt = effectiveSizePt(tokens, id);
      const e = byLevel.get(lv) ?? { min: { id, pt }, max: { id, pt } };
      if (pt < e.min.pt) e.min = { id, pt };
      if (pt > e.max.pt) e.max = { id, pt };
      byLevel.set(lv, e);
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    for (let i = 1; i < levels.length; i++) {
      const hi = byLevel.get(levels[i - 1]).min;
      const lo = byLevel.get(levels[i]).max;
      if (lo.pt > hi.pt) {
        notes.push(`标题字号倒挂：${lo.id}（层级 ${levels[i]}，${lo.pt}pt）比 ${hi.id}（层级 ${levels[i - 1]}，${hi.pt}pt）还大`);
      }
    }
  }

  return { errors, notes };
}

/** 给 build_docx 的返回文案拼提醒段。空的返回 ''（一个字都不占） */
export function formatLint({ errors, notes }, max = 10) {
  const lines = [];
  for (const e of errors) lines.push(`⚠ ${e}`);
  for (const n of notes) lines.push(`· ${n}`);
  if (!lines.length) return '';
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return `\n\n排版/符号体检（${errors.length} 条较确定的问题，${notes.length} 条建议 —— 不挡构建，采不采纳你判断，改了记得重新 build）：\n`
    + shown.join('\n') + (more > 0 ? `\n（另有 ${more} 条略去）` : '');
}
