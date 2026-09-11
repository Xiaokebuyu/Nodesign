/**
 * tokens.js — docx 形态的「真相源」：token JSON schema + 三个内置词典条目。
 *
 * 原则（已拍板）：
 *   - token JSON 是权威，styles.xml/docDefaults 是构建产物；
 *   - 风格名开放（agent 可以起新名字调 token），schema 闭合（字段全集在
 *     这里，build 层只认识这些字段，不接受任意 XML 注入——外来文档的
 *     未建模部分走 extraXml/rawStyles 透传，不走 token 字段扩张）。
 *
 * ── schema v1 ────────────────────────────────────────────────
 * {
 *   v: 1,
 *   provenance: 'nodesign' | 'imported',   // imported = 外来 docx dump 出来的
 *   page: {
 *     size: 'A4'|'Letter'|{wTwip,hTwip}, landscape?: bool,
 *     marginsTwip: {top,bottom,left,right,header,footer,gutter},
 *     docGrid?: {type:'lines'|'linesAndChars', linePitchTwip, charSpace?}|null,
 *   },
 *   lang: {latin:'en-US', eastAsia:'zh-CN'},
 *   fonts: {                            // 具名字体槽；style.run.font 用名字引用
 *     body:{eastAsia,ascii,hAnsi?,cs?}, heading:{...}, quote:{...}, mono:{...}, ...自定义槽
 *   },
 *   base: {                             // docDefaults
 *     sizePt: number|字号名, color:'RRGGBB',
 *     font:'body'|{...},                // 引用字体槽
 *     spacing?: {line,lineRule,beforePt,afterPt},
 *     cjk: {kinsoku,autoSpaceDE,autoSpaceDN,adjustRightInd,snapToGrid,overflowPunct,wordWrap},
 *   },
 *   styles: { [styleId]: Style },
 *   numbering?: { [numName]: {levels:[{fmt,text,indentTwip,hangingTwip,alignedAt?}]} },
 *   rawStyles?: [xmlString],            // dump 时装不进模型的整条 w:style 原文
 * }
 *
 * Style = {
 *   type:'paragraph'|'character'|'table',
 *   name: string,                       // Word UI 名（'heading 1' 等内置名有魔法含义）
 *   basedOn?, next?, link?, qFormat?: bool, uiPriority?: number,
 *   run?: {
 *     font?:'body'|{eastAsia?,ascii?,hAnsi?,cs?}, sizePt?: number|字号名,
 *     bold?, italic?, color?, underline?: true|'single'|'double'|...,
 *     strike?, caps?, smallCaps?, vertAlign?:'superscript'|'subscript',
 *     em?:'dot'|'comma'|'circle'|'underDot',   // 着重号
 *     kernPt?: number, spacingTwip?: number, highlight?: string,
 *   },
 *   para?: {
 *     align?:'left'|'center'|'right'|'both'|'distribute',
 *     outlineLevel?: 0-8,
 *     indent?: {firstLineChars?, firstLineTwip?, hangingChars?, hangingTwip?,
 *               leftChars?, leftTwip?, rightChars?, rightTwip?},
 *     spacing?: {beforePt?, afterPt?, beforeLines?, afterLines?,
 *                line?: number, lineRule?:'multiple'|'exact'|'atLeast'},
 *                // lineRule=multiple 时 line 是倍数(1.5)；exact/atLeast 时是磅
 *     keepNext?, keepLines?, pageBreakBefore?, widowControl?, contextualSpacing?,
 *     borders?: {top?,bottom?,left?,right?: {style,sizePt8?,color,spacePt?}},
 *     shading?: 'RRGGBB',
 *     tabs?: [{pos:twip, val:'left'|'center'|'right'|'decimal', leader?}],
 *     cjk?: 覆盖 base.cjk 的同名开关,
 *   },
 *   extraXml?: {pPr?: string, rPr?: string},  // dump 透传，build 时原样并入
 * }
 */

import { ZIHAO } from './units.js';
import { validateNumbering } from './numbering.js';

/** 词典条目一：办公标准（素颜 Word）——中文 Word 默认观感 */
export function presetOffice() {
  return {
    v: 1,
    provenance: 'nodesign',
    page: {
      size: 'A4',
      marginsTwip: { top: 1440, bottom: 1440, left: 1800, right: 1800, header: 851, footer: 992, gutter: 0 },
    },
    lang: { latin: 'en-US', eastAsia: 'zh-CN' },
    fonts: {
      body: { eastAsia: '宋体', ascii: 'Calibri' },
      heading: { eastAsia: '黑体', ascii: 'Arial' },
      quote: { eastAsia: '楷体', ascii: 'Calibri' },
      mono: { eastAsia: '宋体', ascii: 'Courier New' },
    },
    base: {
      font: 'body', sizePt: '小四', color: '000000',
      spacing: { line: 1.3, lineRule: 'multiple' },
      cjk: { kinsoku: true, autoSpaceDE: true, autoSpaceDN: true, adjustRightInd: true, snapToGrid: true },
    },
    styles: {
      Normal: { type: 'paragraph', name: 'Normal', qFormat: true, para: { indent: { firstLineChars: 200 } } },
      Title: {
        type: 'paragraph', name: 'Title', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '二号', bold: true },
        para: { align: 'center', indent: { firstLineChars: 0 }, spacing: { beforePt: 12, afterPt: 18 }, keepNext: true, outlineLevel: 0 },
      },
      Heading1: {
        type: 'paragraph', name: 'heading 1', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '三号', bold: true },
        para: { indent: { firstLineChars: 0 }, spacing: { beforePt: 13, afterPt: 13 }, keepNext: true, outlineLevel: 0 },
      },
      Heading2: {
        type: 'paragraph', name: 'heading 2', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '四号', bold: true },
        para: { indent: { firstLineChars: 0 }, spacing: { beforePt: 10, afterPt: 10 }, keepNext: true, outlineLevel: 1 },
      },
      Heading3: {
        type: 'paragraph', name: 'heading 3', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '小四', bold: true },
        para: { indent: { firstLineChars: 0 }, spacing: { beforePt: 8, afterPt: 8 }, keepNext: true, outlineLevel: 2 },
      },
      Quote: {
        type: 'paragraph', name: 'Quote', basedOn: 'Normal', qFormat: true,
        run: { font: 'quote', color: '404040' },
        para: { indent: { leftChars: 200, firstLineChars: 0 } },
      },
      Header: { type: 'paragraph', name: 'header', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { sizePt: '小五' } },
      Footer: { type: 'paragraph', name: 'footer', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { sizePt: '小五' } },
    },
  };
}

/** 词典条目二：公文体（GB/T 9704-2012 版式硬指标） */
export function presetGongwen() {
  return {
    v: 1,
    provenance: 'nodesign',
    page: {
      size: 'A4',
      // GB/T 9704: 上37 下35 左28 右26 (mm)
      marginsTwip: { top: 2098, bottom: 1984, left: 1588, right: 1474, header: 851, footer: 992, gutter: 0 },
      docGrid: { type: 'lines', linePitchTwip: 560 },   // 固定 28pt 行距的格
    },
    lang: { latin: 'zh-CN', eastAsia: 'zh-CN' },
    fonts: {
      body: { eastAsia: '仿宋_GB2312', ascii: 'Times New Roman' },
      biaosong: { eastAsia: '方正小标宋简体', ascii: 'Times New Roman' },
      hei: { eastAsia: '黑体', ascii: 'Times New Roman' },
      kai: { eastAsia: '楷体_GB2312', ascii: 'Times New Roman' },
      song: { eastAsia: '宋体', ascii: 'Times New Roman' },
    },
    base: {
      font: 'body', sizePt: '三号', color: '000000',
      spacing: { line: 28, lineRule: 'exact' },
      cjk: { kinsoku: true, autoSpaceDE: false, autoSpaceDN: false, adjustRightInd: true, snapToGrid: true },
    },
    styles: {
      Normal: { type: 'paragraph', name: 'Normal', qFormat: true, para: { indent: { firstLineChars: 200 } } },
      // 发文机关标志（红头）
      Hongtou: {
        type: 'paragraph', name: '红头', basedOn: 'Normal', next: 'Normal',
        run: { font: 'biaosong', sizePt: 32, color: 'FF0000', bold: false },
        para: { align: 'center', indent: { firstLineChars: 0 }, spacing: { line: 40, lineRule: 'exact' } },
      },
      Fawenzihao: {
        type: 'paragraph', name: '发文字号', basedOn: 'Normal', next: 'Normal',
        para: { align: 'center', indent: { firstLineChars: 0 } },
      },
      GwTitle: {
        type: 'paragraph', name: '公文标题', basedOn: 'Normal', next: 'Normal', qFormat: true,
        // 标题前后各空一行（28pt）。用 pt 不用 beforeLines：lab/02 已证 LO 对
        // 字符/行单位的兼容不可信，*Lines 同族，公文版式是硬指标不赌。
        run: { font: 'biaosong', sizePt: '二号' },
        para: { align: 'center', indent: { firstLineChars: 0 }, spacing: { beforePt: 28, afterPt: 28 }, keepNext: true, outlineLevel: 0 },
      },
      GwH1: {   // 一、 黑体
        type: 'paragraph', name: '公文一级', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'hei' }, para: { keepNext: true, outlineLevel: 0 },
      },
      GwH2: {   // （一） 楷体
        type: 'paragraph', name: '公文二级', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'kai' }, para: { keepNext: true, outlineLevel: 1 },
      },
      GwH3: {   // 1. 仿宋加粗
        type: 'paragraph', name: '公文三级', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { bold: true }, para: { keepNext: true, outlineLevel: 2 },
      },
      Chaosong: {
        type: 'paragraph', name: '抄送', basedOn: 'Normal',
        run: { sizePt: '四号', font: 'body' }, para: { indent: { firstLineChars: 0 } },
      },
      Footer: { type: 'paragraph', name: 'footer', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { font: 'song', sizePt: '四号' } },
      Header: { type: 'paragraph', name: 'header', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { font: 'song', sizePt: '小五' } },
    },
  };
}

/** 词典条目三：学术论文体（中文期刊/学位论文常规） */
export function presetAcademic() {
  return {
    v: 1,
    provenance: 'nodesign',
    page: {
      size: 'A4',
      marginsTwip: { top: 1700, bottom: 1700, left: 1800, right: 1800, header: 851, footer: 992, gutter: 0 },
    },
    lang: { latin: 'en-US', eastAsia: 'zh-CN' },
    fonts: {
      body: { eastAsia: '宋体', ascii: 'Times New Roman' },
      heading: { eastAsia: '黑体', ascii: 'Times New Roman' },
      quote: { eastAsia: '楷体', ascii: 'Times New Roman' },
      caption: { eastAsia: '宋体', ascii: 'Times New Roman' },
      mono: { eastAsia: '宋体', ascii: 'Courier New' },
    },
    base: {
      font: 'body', sizePt: '小四', color: '000000',
      spacing: { line: 1.5, lineRule: 'multiple' },
      cjk: { kinsoku: true, autoSpaceDE: true, autoSpaceDN: true, adjustRightInd: true, snapToGrid: true },
    },
    styles: {
      Normal: { type: 'paragraph', name: 'Normal', qFormat: true, para: { indent: { firstLineChars: 200 } } },
      Title: {
        type: 'paragraph', name: 'Title', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '三号', bold: true },
        para: { align: 'center', indent: { firstLineChars: 0 }, spacing: { beforePt: 17, afterPt: 17 }, keepNext: true, outlineLevel: 0 },
      },
      Abstract: {
        type: 'paragraph', name: '摘要', basedOn: 'Normal',
        run: { sizePt: '五号', font: 'quote' },
        para: { indent: { firstLineChars: 200 } },
      },
      Heading1: {
        type: 'paragraph', name: 'heading 1', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '四号', bold: true },
        para: { indent: { firstLineChars: 0 }, spacing: { beforePt: 13, afterPt: 13 }, keepNext: true, outlineLevel: 0 },
      },
      Heading2: {
        type: 'paragraph', name: 'heading 2', basedOn: 'Normal', next: 'Normal', qFormat: true,
        run: { font: 'heading', sizePt: '小四', bold: true },
        para: { indent: { firstLineChars: 0 }, spacing: { beforePt: 13, afterPt: 6 }, keepNext: true, outlineLevel: 1 },
      },
      Caption: {
        type: 'paragraph', name: 'caption', basedOn: 'Normal', qFormat: true,
        run: { font: 'caption', sizePt: '五号', bold: true },
        para: { align: 'center', indent: { firstLineChars: 0 }, spacing: { beforePt: 6, afterPt: 6 } },
      },
      Quote: {
        type: 'paragraph', name: 'Quote', basedOn: 'Normal', qFormat: true,
        run: { font: 'quote' },
        para: { indent: { leftChars: 200, firstLineChars: 0 } },
      },
      Header: { type: 'paragraph', name: 'header', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { sizePt: '小五' } },
      Footer: { type: 'paragraph', name: 'footer', basedOn: 'Normal', para: { indent: { firstLineChars: 0 }, align: 'center' }, run: { sizePt: '小五' } },
    },
  };
}

export const PRESETS = {
  办公标准: presetOffice,
  公文: presetGongwen,
  学术论文: presetAcademic,
};

/** token 校验：字段闭合 —— 未知字段直接报错，防 schema 野蛮生长 */
export const STYLE_KEYS = new Set(['type', 'name', 'basedOn', 'next', 'link', 'qFormat', 'uiPriority', 'run', 'para', 'extraXml']);
export const RUN_KEYS = new Set(['font', 'sizePt', 'bold', 'italic', 'color', 'underline', 'strike', 'caps',
  'smallCaps', 'vertAlign', 'em', 'kernPt', 'spacingTwip', 'highlight']);
export const PARA_KEYS = new Set(['align', 'outlineLevel', 'indent', 'spacing', 'keepNext', 'keepLines',
  'pageBreakBefore', 'widowControl', 'contextualSpacing', 'borders', 'shading', 'tabs', 'cjk', 'list']);

/**
 * 行距规则的合法值。
 *
 * ⚠️ 单独校验它是因为**写错这个字段不会静默失效，会静默生效成荒谬值**：
 * `lineRule` 只有 'multiple' 时 `line` 才是倍数，其余按磅算。写 `'auto'`
 * （CSS/OOXML 里都存在这个词，很容易顺手打出来）会落进磅值分支，
 * `line: 360` 本意「1.5 倍」就变成每行 360 磅 = 5 英寸，正文整个被挤出页面。
 * 只查键名的闭合 schema 挡不住这种，得查值。
 */
const LINE_RULES = new Set(['multiple', 'exact', 'atLeast']);

/** 字号：数字直接用，字符串必须是字号名 */
function badSize(v) {
  return typeof v === 'string' && !(v in ZIHAO);
}

/**
 * indent 里 firstLine* 和 hanging* 互斥。OOXML 的 w:ind 里它们是**同一个属性的
 * 正负两面**（悬挂 = 负的首行缩进），同时给的话哪个生效随渲染器不同——LO 实测
 * firstLine 覆盖 hanging，ECMA-376 又说 hanging 优先。写 `firstLineChars: 0` +
 * `hangingChars` 的人是想"清掉继承的首行缩进再悬挂"，但悬挂本身就含这层意思，
 * 多写那个 0 反而把悬挂静默打掉（agent 实踩：两轮 build 白跑，2026-08-19 上报）。
 * 跟 lineRule:'auto' 同族：写了不报错但生效成别的东西，必须在校验层拦。
 */
export function indentConflict(ind) {
  if (!ind || typeof ind !== 'object') return null;
  const fl = ind.firstLineChars ?? ind.firstLineTwip;
  const hg = ind.hangingChars ?? ind.hangingTwip;
  if (fl == null || hg == null) return null;
  return 'indent 的 firstLine* 和 hanging* 互斥（同一个属性的正负两面，同时给会静默覆盖悬挂）。'
    + '要悬挂缩进只写 hanging*——悬挂天然含「首行回到左缘」，不用再补 firstLineChars: 0';
}

export function validateTokens(tok) {
  const errs = [];
  if (tok.v !== 1) errs.push(`tokens.v 只能是 1（现在是 ${JSON.stringify(tok.v)}）。tokens.v 可以不写，版本号以源文件顶层的 v 为准`);
  const checkSpacing = (where, sp) => {
    if (!sp) return;
    if (sp.lineRule != null && !LINE_RULES.has(sp.lineRule)) {
      errs.push(`${where}.spacing.lineRule: '${sp.lineRule}' 不是合法值，只有 ${[...LINE_RULES].join(' / ')}`
        + "（multiple 时 line 是倍数如 1.5；exact/atLeast 时 line 是磅）");
    }
    if (sp.line != null && sp.lineRule === 'multiple' && sp.line > 10) {
      errs.push(`${where}.spacing: lineRule=multiple 时 line 是**倍数**，${sp.line} 倍行距几乎肯定是把磅值写这儿了`);
    }
  };
  for (const [id, st] of Object.entries(tok.styles ?? {})) {
    for (const k of Object.keys(st)) if (!STYLE_KEYS.has(k)) errs.push(`styles.${id}: unknown key ${k}`);
    for (const k of Object.keys(st.run ?? {})) if (!RUN_KEYS.has(k)) errs.push(`styles.${id}.run: unknown key ${k}`);
    for (const k of Object.keys(st.para ?? {})) if (!PARA_KEYS.has(k)) errs.push(`styles.${id}.para: unknown key ${k}`);
    if (st.run?.font && typeof st.run.font === 'string' && !tok.fonts?.[st.run.font]) {
      errs.push(`styles.${id}.run.font: no such font slot '${st.run.font}'`);
    }
    if (badSize(st.run?.sizePt)) errs.push(`styles.${id}.run.sizePt: unknown 字号 ${st.run.sizePt}`);
    if (st.basedOn && !tok.styles[st.basedOn]) errs.push(`styles.${id}.basedOn: no such style '${st.basedOn}'`);
    checkSpacing(`styles.${id}.para`, st.para?.spacing);
    const indErr = indentConflict(st.para?.indent);
    if (indErr) errs.push(`styles.${id}.para.indent: ${indErr}`);
  }
  if (badSize(tok.base?.sizePt)) errs.push(`base.sizePt: unknown 字号 ${tok.base.sizePt}`);
  checkSpacing('base', tok.base?.spacing);
  // 自动编号（2026-08-18）：定义本身的校验在 numbering.js，这里再钉一条**引用完整性**
  // —— 引用一个不存在的编号名以前会产出悬空 numId（Word 打开可能直接报文档损坏），
  // 这正是"闭合 schema 只查键名不查值"那类漏的延续。
  errs.push(...validateNumbering(tok.numbering));
  const numNames = new Set(Object.keys(tok.numbering ?? {}));
  const checkList = (where, list) => {
    if (!list) return;
    const name = typeof list === 'string' ? list : list.name;
    if (!name) errs.push(`${where}.list: 要写 { name: '编号名', ilvl?: N } 或直接写编号名`);
    else if (!numNames.has(name)) {
      errs.push(`${where}.list: 没有名为 '${name}' 的编号定义`
        + (numNames.size ? `，现有：${[...numNames].join(' / ')}` : '（tokens.numbering 是空的）'));
    }
  };
  for (const [id, st] of Object.entries(tok.styles ?? {})) checkList(`styles.${id}.para`, st.para?.list);
  return errs;
}
