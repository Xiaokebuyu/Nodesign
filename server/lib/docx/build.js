/**
 * build.js — token JSON + 内容块 → 完整 docx（Buffer）。
 *
 * 所有属性容器（pPr/rPr/sectPr/style/…）都过 order.sortChildren()，
 * 出厂前可用 order.checkOrder() 体检；对外证据是 OpenXmlValidator 0 错。
 *
 * 内容块模型（generation 路线的雏形，编辑路线不走这里）：
 *   {t:'p', style?, blocks 见 buildPara}       段落
 *   {t:'table', widthsTwip:[..], rows:[[cell]]} 表格；cell = string | {text, style?}
 *   {t:'pageBreak'}
 * 段落 runs：string | {text, bold?, italic?, color?, font?, sizePt?, em?, underline?}
 *            | {fld:'PAGE'|'NUMPAGES'}
 */

import { elem, textNode, serializeNode } from './xml.js';
import { sortChildren } from './order.js';
import { ptToHalf, ptToTwip, sizePt as toPt, PAGE_SIZES } from './units.js';
import { buildNumberingXml, numIdsFor } from './numbering.js';

const W = 'xmlns:w';
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/* ── 低层小件 ─────────────────────────────────── */

function val(name, v) { return elem(name, [['w:val', v]]); }
function flag(name, on) { return on === false ? elem(name, [['w:val', '0']]) : elem(name); }

function resolveFont(tokens, ref) {
  if (ref == null) return null;
  const f = typeof ref === 'string' ? tokens.fonts?.[ref] : ref;
  if (!f) throw new Error(`unknown font slot: ${ref}`);
  return f;
}

function rFontsEl(f) {
  const attrs = [];
  if (f.ascii) attrs.push(['w:ascii', f.ascii]);
  if (f.eastAsia) attrs.push(['w:eastAsia', f.eastAsia]);
  attrs.push(['w:hAnsi', f.hAnsi ?? f.ascii ?? f.eastAsia]);
  if (f.cs ?? f.ascii) attrs.push(['w:cs', f.cs ?? f.ascii]);
  return elem('w:rFonts', attrs);
}

/** run token → w:rPr（无内容时返回 null） */
export function buildRPr(tokens, run, { forStyle = false } = {}) {
  if (!run) return null;
  const kids = [];
  const f = resolveFont(tokens, run.font);
  if (f) kids.push(rFontsEl(f));
  if (run.bold != null) kids.push(flag('w:b', run.bold));
  if (run.italic != null) kids.push(flag('w:i', run.italic));
  if (run.caps) kids.push(elem('w:caps'));
  if (run.smallCaps) kids.push(elem('w:smallCaps'));
  if (run.strike) kids.push(elem('w:strike'));
  if (run.color) kids.push(val('w:color', run.color));
  if (run.spacingTwip != null) kids.push(val('w:spacing', run.spacingTwip));
  if (run.kernPt != null) kids.push(val('w:kern', ptToHalf(run.kernPt)));
  if (run.sizePt != null) {
    kids.push(val('w:sz', ptToHalf(toPt(run.sizePt))));
    kids.push(val('w:szCs', ptToHalf(toPt(run.sizePt))));
  }
  if (run.highlight) kids.push(val('w:highlight', run.highlight));
  if (run.underline) kids.push(val('w:u', run.underline === true ? 'single' : run.underline));
  if (run.vertAlign) kids.push(val('w:vertAlign', run.vertAlign));
  if (run.em) kids.push(val('w:em', run.em));
  if (!kids.length) return null;
  return sortChildren(elem('w:rPr', [], kids));
}

const CJK_FLAGS = [
  ['kinsoku', 'w:kinsoku'], ['wordWrap', 'w:wordWrap'], ['overflowPunct', 'w:overflowPunct'],
  ['autoSpaceDE', 'w:autoSpaceDE'], ['autoSpaceDN', 'w:autoSpaceDN'],
  ['adjustRightInd', 'w:adjustRightInd'], ['snapToGrid', 'w:snapToGrid'],
];

/**
 * 沿 basedOn 链算风格的有效字号（磅）。块级 run 覆盖 > 风格链 > base。
 */
export function effectiveSizePt(tokens, styleId, runSizePt) {
  if (runSizePt != null) return toPt(runSizePt);
  let id = styleId;
  const seen = new Set();
  while (id && tokens.styles?.[id] && !seen.has(id)) {
    seen.add(id);
    const st = tokens.styles[id];
    if (st.run?.sizePt != null) return toPt(st.run.sizePt);
    id = st.basedOn;
  }
  return toPt(tokens.base?.sizePt ?? 12);
}

/**
 * 【实测军规】LO 25.2 无视单独的 w:firstLineChars/leftChars（lab/02 A/B：
 * chars-only 缩进 0pt，chars+twip 精确 32pt）。Word 里 chars 优先于 twip。
 * 所以字符单位缩进一律双发：chars（Word 真语义，随字号缩放）+ 按有效字号
 * 算好的 twip 兜底（LO/QC 与旧阅读器用）。
 */
function indentAttrs(i, sizePt) {
  const attrs = [];
  const chars2twip = (chars) => Math.round((chars / 100) * sizePt * 20);
  if (i.leftChars != null) {
    attrs.push(['w:left', i.leftTwip ?? chars2twip(i.leftChars)]);
    attrs.push(['w:leftChars', i.leftChars]);
  } else if (i.leftTwip != null) attrs.push(['w:left', i.leftTwip]);
  if (i.rightChars != null) {
    attrs.push(['w:right', i.rightTwip ?? chars2twip(i.rightChars)]);
    attrs.push(['w:rightChars', i.rightChars]);
  } else if (i.rightTwip != null) attrs.push(['w:right', i.rightTwip]);
  if (i.hangingChars != null) {
    attrs.push(['w:hanging', i.hangingTwip ?? chars2twip(i.hangingChars)]);
    attrs.push(['w:hangingChars', i.hangingChars]);
  } else if (i.hangingTwip != null) attrs.push(['w:hanging', i.hangingTwip]);
  if (i.firstLineChars != null) {
    attrs.push(['w:firstLine', i.firstLineTwip ?? chars2twip(i.firstLineChars)]);
    attrs.push(['w:firstLineChars', i.firstLineChars]);
  } else if (i.firstLineTwip != null) attrs.push(['w:firstLine', i.firstLineTwip]);
  return attrs;
}

/** para token → w:pPr 子元素数组（不含 pStyle/rPr，调用方拼）
 *  ctx.sizePt = 本段有效字号，字符单位缩进换算 twip 兜底用 */
function paraProps(para, ctx = { sizePt: 12 }) {
  const kids = [];
  if (!para) return kids;
  if (para.keepNext) kids.push(elem('w:keepNext'));
  if (para.keepLines) kids.push(elem('w:keepLines'));
  if (para.pageBreakBefore) kids.push(elem('w:pageBreakBefore'));
  if (para.widowControl != null) kids.push(flag('w:widowControl', para.widowControl));
  if (para.list) {
    // agent 按**名字**引用编号（`list: {name:'条款', ilvl:1}` 或简写 `list:'条款'`），
    // numId 是 OOXML 的实现细节，这里现算。名字对不上是 token 校验的活，
    // 到这儿只可能是内部不一致，宁可产一个显式错误也别产一个悬空 numId。
    const spec = typeof para.list === 'string' ? { name: para.list } : para.list;
    const numId = ctx.numIds?.get(spec.name);
    if (numId == null) throw new Error(`para.list: 没有名为 '${spec.name}' 的编号定义`);
    kids.push(elem('w:numPr', [], [val('w:ilvl', spec.ilvl ?? 0), val('w:numId', numId)]));
  }
  if (para.borders) {
    const sides = [];
    for (const side of ['top', 'left', 'bottom', 'right']) {
      const b = para.borders[side];
      if (!b) continue;
      sides.push(elem(`w:${side}`, [
        ['w:val', b.style ?? 'single'], ['w:sz', b.sizePt8 ?? 4],
        ['w:space', b.spacePt ?? 0], ['w:color', b.color ?? '000000'],
      ]));
    }
    if (sides.length) kids.push(sortChildren(elem('w:pBdr', [], sides)));
  }
  if (para.shading) {
    kids.push(elem('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', para.shading]]));
  }
  if (para.tabs?.length) {
    kids.push(elem('w:tabs', [], para.tabs.map((t) => elem('w:tab', [
      ['w:val', t.val ?? 'left'], ...(t.leader ? [['w:leader', t.leader]] : []), ['w:pos', t.pos],
    ]))));
  }
  for (const [key, name] of CJK_FLAGS) {
    if (para.cjk && para.cjk[key] != null) kids.push(flag(name, para.cjk[key]));
  }
  if (para.spacing) {
    const s = para.spacing;
    const attrs = [];
    if (s.beforePt != null) attrs.push(['w:before', ptToTwip(s.beforePt)]);
    if (s.beforeLines != null) attrs.push(['w:beforeLines', s.beforeLines]);
    if (s.afterPt != null) attrs.push(['w:after', ptToTwip(s.afterPt)]);
    if (s.afterLines != null) attrs.push(['w:afterLines', s.afterLines]);
    if (s.line != null) {
      const rule = s.lineRule ?? 'multiple';
      attrs.push(['w:line', rule === 'multiple' ? Math.round(s.line * 240) : ptToTwip(s.line)]);
      attrs.push(['w:lineRule', rule === 'multiple' ? 'auto' : rule]);
    }
    if (attrs.length) kids.push(elem('w:spacing', attrs));
  }
  if (para.indent) {
    const attrs = indentAttrs(para.indent, ctx.sizePt);
    if (attrs.length) kids.push(elem('w:ind', attrs));
  }
  if (para.contextualSpacing) kids.push(elem('w:contextualSpacing'));
  if (para.align) kids.push(val('w:jc', para.align));
  if (para.outlineLevel != null) kids.push(val('w:outlineLvl', para.outlineLevel));
  return kids;
}

/* ── styles.xml ───────────────────────────────── */

export function buildStylesXml(tokens) {
  const base = tokens.base ?? {};
  const rDef = [];
  const bf = resolveFont(tokens, base.font ?? 'body');
  if (bf) rDef.push(rFontsEl(bf));
  if (base.kernPt != null) rDef.push(val('w:kern', ptToHalf(base.kernPt)));
  if (base.sizePt != null) {
    rDef.push(val('w:sz', ptToHalf(toPt(base.sizePt))));
    rDef.push(val('w:szCs', ptToHalf(toPt(base.sizePt))));
  }
  if (base.color && base.color !== '000000') rDef.push(val('w:color', base.color));
  if (tokens.lang) {
    rDef.push(elem('w:lang', [
      ['w:val', tokens.lang.latin ?? 'en-US'],
      ['w:eastAsia', tokens.lang.eastAsia ?? 'zh-CN'],
      ['w:bidi', 'ar-SA'],
    ]));
  }
  const pDefKids = [];
  for (const [key, name] of CJK_FLAGS) {
    if (base.cjk && base.cjk[key] != null) pDefKids.push(flag(name, base.cjk[key]));
  }
  if (base.spacing) pDefKids.push(...paraProps({ spacing: base.spacing }));

  const styleEls = [];
  for (const [id, st] of Object.entries(tokens.styles ?? {})) {
    const kids = [val('w:name', st.name ?? id)];
    if (st.basedOn) kids.push(val('w:basedOn', st.basedOn));
    if (st.next) kids.push(val('w:next', st.next));
    if (st.link) kids.push(val('w:link', st.link));
    if (st.uiPriority != null) kids.push(val('w:uiPriority', st.uiPriority));
    if (st.qFormat) kids.push(elem('w:qFormat'));
    const pKids = paraProps(st.para, { sizePt: effectiveSizePt(tokens, id), numIds: numIdsFor(tokens) });
    if (pKids.length) kids.push(sortChildren(elem('w:pPr', [], pKids)));
    const rPr = buildRPr(tokens, st.run, { forStyle: true });
    if (rPr) kids.push(rPr);
    const el = sortChildren(elem('w:style', [['w:type', st.type ?? 'paragraph'], ['w:styleId', id]], kids));
    styleEls.push(el);
  }

  const root = elem('w:styles', [[W, NS_W]], [
    elem('w:docDefaults', [], [
      elem('w:rPrDefault', [], rDef.length ? [sortChildren(elem('w:rPr', [], rDef))] : []),
      elem('w:pPrDefault', [], pDefKids.length ? [sortChildren(elem('w:pPr', [], pDefKids))] : []),
    ]),
    ...styleEls,
  ]);
  return DECL + serializeNode(root);
}

/* ── document.xml ─────────────────────────────── */

function buildRun(tokens, r, links) {
  if (typeof r === 'string') r = { text: r };
  const kids = [];
  const rPr = buildRPr(tokens, r);
  if (rPr) kids.push(rPr);
  if (r.fld) {
    return elem('w:fldSimple', [['w:instr', ` ${r.fld} `]], [
      elem('w:r', [], rPr ? [rPr, elem('w:t', [], [textNode('1')])] : [elem('w:t', [], [textNode('1')])]),
    ]);
  }
  if (r.br) kids.push(elem('w:br', r.br === true ? [] : [['w:type', r.br]]));
  if (r.text != null) {
    const t = String(r.text);
    const attrs = /^\s|\s$/.test(t) ? [['xml:space', 'preserve']] : [];
    kids.push(elem('w:t', attrs, [textNode(t)]));
  }
  const runEl = elem('w:r', [], kids);
  // 超链接：run 包进 w:hyperlink，目标在关系表里（TargetMode="External"）。
  // 视觉刻意不动 —— 中文简历那种「可点但不染色」不该被迫对抗默认蓝下划线；
  // 要经典观感就照常写 color/underline
  if (r.link) {
    const id = links?.get(r.link);
    // 到这儿查不到只可能是收集和构建不一致 —— 宁可炸也不产悬空 r:id（Word 报文档损坏）
    if (id == null) throw new Error(`run.link 没登记进关系表：${r.link}`);
    return elem('w:hyperlink', [['r:id', id], ['w:history', '1']], [runEl]);
  }
  return runEl;
}

export function buildPara(tokens, block, links) {
  const pKids = [];
  const propKids = [];
  if (block.style) propKids.push(val('w:pStyle', block.style));
  const firstRun = (block.runs ?? []).find((r) => typeof r === 'object' && r.sizePt != null);
  const ctx = { sizePt: effectiveSizePt(tokens, block.style, block.sizePt ?? firstRun?.sizePt), numIds: numIdsFor(tokens) };
  propKids.push(...paraProps(block, ctx));   // 直接格式（block 上的 align/indent/... 覆盖）
  if (propKids.length) pKids.push(sortChildren(elem('w:pPr', [], propKids)));
  const runs = block.runs ?? (block.text != null ? [block.text] : []);
  // 块级 color = 各 run 的缺省色，run 自己写了就听 run 的
  const inherit = (r) => (block.color == null ? r
    : typeof r === 'string' ? { text: r, color: block.color }
      : (r && typeof r === 'object' && r.color == null ? { ...r, color: block.color } : r));
  for (const r of runs) pKids.push(buildRun(tokens, inherit(r), links));
  return elem('w:p', [], pKids);
}

/**
 * 表格边框（2026-09-11 雾岭手册：以前只有满格黑网格一种，编辑型文档只好把规格表改写成段落 + 制表位）。
 * 不写 = 'grid'，跟以前逐字节一样；对象写法里没写的边 = 没有线（写 nil，不留给默认表样式猜）。
 */
export const TABLE_BORDER_SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
export const TABLE_BORDER_STYLES = ['single', 'double', 'dotted', 'dashed', 'dotDash', 'thick', 'triple'];
const line = (sizePt8) => ({ style: 'single', sizePt8, color: '000000' });
export const TABLE_BORDER_PRESETS = {
  grid: Object.fromEntries(TABLE_BORDER_SIDES.map((s) => [s, line(4)])),
  horizontal: { top: line(8), bottom: line(8), insideH: line(4) },   // 只有横线：上下沿 1 磅、行间半磅、没有竖线
  none: {},
};

function tableBorders(spec = 'grid') {
  const sides = typeof spec === 'string' ? TABLE_BORDER_PRESETS[spec] : spec;
  return elem('w:tblBorders', [], TABLE_BORDER_SIDES.map((s) => {
    const b = sides[s];
    return b
      ? elem(`w:${s}`, [['w:val', b.style ?? 'single'], ['w:sz', b.sizePt8 ?? 4], ['w:space', 0], ['w:color', b.color ?? '000000']])
      : elem(`w:${s}`, [['w:val', 'nil']]);
  }));
}

function buildTable(tokens, block, links) {
  const widths = block.widthsTwip;
  const kids = [
    sortChildren(elem('w:tblPr', [], [
      elem('w:tblW', [['w:w', widths.reduce((a, b) => a + b, 0)], ['w:type', 'dxa']]),
      tableBorders(block.borders),
      elem('w:tblLayout', [['w:type', 'fixed']]),
    ])),
    elem('w:tblGrid', [], widths.map((w) => elem('w:gridCol', [['w:w', w]]))),
  ];
  for (const row of block.rows) {
    const tcs = row.map((cell, i) => {
      const c = typeof cell === 'string' ? { text: cell } : cell;
      return elem('w:tc', [], [
        sortChildren(elem('w:tcPr', [], [
          elem('w:tcW', [['w:w', widths[i]], ['w:type', 'dxa']]),
          ...(c.shading ? [elem('w:shd', [['w:val', 'clear'], ['w:color', 'auto'], ['w:fill', c.shading]])] : []),
          val('w:vAlign', 'center'),
        ])),
        buildPara(tokens, { ...c, indent: c.indent ?? {} }, links),
      ]);
    });
    kids.push(elem('w:tr', [], tcs));
  }
  return elem('w:tbl', [], kids);
}

export function buildBody(tokens, content, rels, links) {
  const kids = [];
  for (const block of content) {
    if (block.t === 'p') kids.push(buildPara(tokens, block, links));
    else if (block.t === 'table') kids.push(buildTable(tokens, block, links));
    else if (block.t === 'pageBreak') {
      kids.push(elem('w:p', [], [elem('w:r', [], [elem('w:br', [['w:type', 'page']])])]));
    } else throw new Error(`unknown block: ${block.t}`);
  }
  // sectPr 最后
  const page = tokens.page ?? {};
  const size = typeof page.size === 'string' ? PAGE_SIZES[page.size] : page.size ?? PAGE_SIZES.A4;
  const m = page.marginsTwip ?? { top: 1440, bottom: 1440, left: 1800, right: 1800, header: 851, footer: 992, gutter: 0 };
  const sect = [];
  if (rels.header) sect.push(elem('w:headerReference', [['w:type', 'default'], ['r:id', rels.header]]));
  if (rels.footer) sect.push(elem('w:footerReference', [['w:type', 'default'], ['r:id', rels.footer]]));
  sect.push(elem('w:pgSz', [
    ['w:w', page.landscape ? size.hTwip : size.wTwip],
    ['w:h', page.landscape ? size.wTwip : size.hTwip],
    ...(page.landscape ? [['w:orient', 'landscape']] : []),
  ]));
  sect.push(elem('w:pgMar', [
    ['w:top', m.top], ['w:right', m.right], ['w:bottom', m.bottom], ['w:left', m.left],
    ['w:header', m.header ?? 851], ['w:footer', m.footer ?? 992], ['w:gutter', m.gutter ?? 0],
  ]));
  if (page.docGrid) {
    sect.push(elem('w:docGrid', [
      ['w:type', page.docGrid.type ?? 'lines'],
      ['w:linePitch', page.docGrid.linePitchTwip],
      ...(page.docGrid.charSpace != null ? [['w:charSpace', page.docGrid.charSpace]] : []),
    ]));
  }
  kids.push(sortChildren(elem('w:sectPr', [], sect)));
  return elem('w:body', [], kids);
}

export function buildDocumentXml(tokens, content, rels = {}, links = null) {
  const root = elem('w:document', [[W, NS_W], ['xmlns:r', NS_R]], [buildBody(tokens, content, rels, links)]);
  return DECL + serializeNode(root);
}

/** 正文（含表格单元格）里出现过的超链接目标，按出现顺序去重。
 *  只扫 content —— 页眉页脚的 link 在校验层就被拒了（要单独关系表，没做） */
export function collectLinks(content) {
  const urls = [];
  const seen = new Set();
  const fromRuns = (runs) => {
    for (const r of runs ?? []) {
      if (r && typeof r === 'object' && typeof r.link === 'string' && r.link && !seen.has(r.link)) {
        seen.add(r.link);
        urls.push(r.link);
      }
    }
  };
  for (const b of content ?? []) {
    if (!b || typeof b !== 'object') continue;
    if (b.t === 'p') fromRuns(b.runs);
    else if (b.t === 'table') {
      for (const row of b.rows ?? []) {
        for (const cell of row ?? []) {
          if (cell && typeof cell === 'object') fromRuns(cell.runs);
        }
      }
    }
  }
  return urls;
}

function buildHdrFtr(tokens, name, blocks) {
  const root = elem(name, [[W, NS_W], ['xmlns:r', NS_R]],
    blocks.map((b) => buildPara(tokens, b)));
  return DECL + serializeNode(root);
}

/* ── 容器组装 ─────────────────────────────────── */

const CT = (over) => `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + over.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')
  + '</Types>';

/** 关系表是字符串拼的，超链接 Target 是外来 URL —— & 这类字符不转义就是坏 XML */
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const REL = (rels) => `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + rels.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type}" Target="${escAttr(target)}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')
  + '</Relationships>';

const T_DOC = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const T_STY = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const T_SET = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
const T_HDR = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const T_FTR = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
const T_NUM = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const R_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function buildSettingsXml(tokens) {
  const kids = [
    elem('w:defaultTabStop', [['w:val', 420]]),
    elem('w:characterSpacingControl', [['w:val', 'compressPunctuation']]),
    elem('w:compat', [], [
      elem('w:compatSetting', [['w:name', 'compatibilityMode'],
        ['w:uri', 'http://schemas.microsoft.com/office/word'], ['w:val', '15']]),
      elem('w:compatSetting', [['w:name', 'useWord2013TrackBottomHyphenation'],
        ['w:uri', 'http://schemas.microsoft.com/office/word'], ['w:val', '0']]),
    ]),
    elem('w:themeFontLang', [['w:val', tokens.lang?.latin ?? 'en-US'], ['w:eastAsia', tokens.lang?.eastAsia ?? 'zh-CN']]),
  ];
  const root = elem('w:settings', [[W, NS_W]], kids);
  return DECL + serializeNode(root);
}

/**
 * @param {object} tokens  token JSON
 * @param {Array}  content 内容块
 * @param {object} opts    {header?: blocks, footer?: blocks, coreProps?: {title, creator}}
 * @returns {Buffer} docx
 */
export async function buildDocx(tokens, content, opts = {}) {
  const { addEntry, writeZip } = await import('./rawzip.js');
  const zip = { entries: new Map(), order: [] };

  const overrides = [
    ['/word/document.xml', T_DOC],
    ['/word/styles.xml', T_STY],
    ['/word/settings.xml', T_SET],
  ];
  const docRels = [
    ['rId1', `${R_BASE}/styles`, 'styles.xml'],
    ['rId2', `${R_BASE}/settings`, 'settings.xml'],
  ];
  const rels = {};
  let nextId = 3;
  // 自动编号（2026-08-18）：有定义才产这个 part。空的 numbering.xml 是合法的但
  // 毫无意义，而 Word 对"声明了 rel 却没有 part"是硬报错，所以三处登记要么全有
  // 要么全没有 —— 这就是为什么它们挤在一个 if 里而不是散在三处。
  const numberingXml = buildNumberingXml(tokens.numbering);
  if (numberingXml) {
    docRels.push([`rId${nextId}`, `${R_BASE}/numbering`, 'numbering.xml']);
    overrides.push(['/word/numbering.xml', T_NUM]);
    nextId += 1;
  }
  if (opts.header) {
    rels.header = `rId${nextId}`;
    docRels.push([`rId${nextId}`, `${R_BASE}/header`, 'header1.xml']);
    overrides.push(['/word/header1.xml', T_HDR]);
    nextId += 1;
  }
  if (opts.footer) {
    rels.footer = `rId${nextId}`;
    docRels.push([`rId${nextId}`, `${R_BASE}/footer`, 'footer1.xml']);
    overrides.push(['/word/footer1.xml', T_FTR]);
    nextId += 1;
  }
  // 超链接（2026-08-19）：rId 从同一个计数器发 —— 撞上 styles/settings/numbering/
  // header/footer 已占的号段，Word 打开直接报「文档已损坏」（agent 手写后处理时
  // 实踩过）。同一 URL 复用同一个 rId
  const links = new Map();
  for (const url of collectLinks(content)) {
    const id = `rId${nextId}`;
    nextId += 1;
    links.set(url, id);
    docRels.push([id, `${R_BASE}/hyperlink`, url, 'External']);
  }

  addEntry(zip, '[Content_Types].xml', CT(overrides));
  addEntry(zip, '_rels/.rels', REL([
    ['rId1', `${R_BASE}/officeDocument`, 'word/document.xml'],
  ]));
  addEntry(zip, 'word/_rels/document.xml.rels', REL(docRels));
  if (numberingXml) addEntry(zip, 'word/numbering.xml', numberingXml);
  addEntry(zip, 'word/styles.xml', buildStylesXml(tokens));
  addEntry(zip, 'word/settings.xml', buildSettingsXml(tokens));
  if (opts.header) addEntry(zip, 'word/header1.xml', buildHdrFtr(tokens, 'w:hdr', opts.header));
  if (opts.footer) addEntry(zip, 'word/footer1.xml', buildHdrFtr(tokens, 'w:ftr', opts.footer));
  addEntry(zip, 'word/document.xml', buildDocumentXml(tokens, content, rels, links));
  return writeZip(zip);
}
