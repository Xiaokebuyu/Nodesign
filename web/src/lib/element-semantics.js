/**
 * Element semantics — 元素语义翻译层
 *
 * 这是 Design Principle §8（Inspector 级元素选择 + 人话/AI 双视图）的实现：
 *   - getElementRole(el)           推断"这是什么"（标题/正文/图片/列表项/...）
 *   - describePage(el)             推断"在哪页"（基于 ancestor `<section data-page>`）
 *   - describeStyles(el)           computed style → 人话（"字号 14px 字重 中粗"）
 *   - describeAdjustables(el)      列出可调维度（仅显示对该元素有意义的）
 *   - serializeForAI(el, anchor)   AI 上下文视图（path / outerHTML / computed / siblings）
 *
 * 设计：所有函数对 el === null 返回 null / [] / ''，调用方放心传 nullable。
 */

import { serializeAnchor } from './html-utils.js';

// ─── Role 词典（标签 → 人话角色）─────────────────────────────

const ROLE_BY_TAG = {
  H1: '一级标题',
  H2: '二级标题',
  H3: '三级标题',
  H4: '四级标题',
  H5: '五级标题',
  H6: '六级标题',
  P: '段落',
  SPAN: '文本片段',
  LI: '列表项',
  UL: '无序列表',
  OL: '有序列表',
  IMG: '图片',
  SVG: '图形',
  A: '链接',
  BUTTON: '按钮',
  STRONG: '强调',
  EM: '斜体强调',
  SMALL: '小字',
  BLOCKQUOTE: '引用块',
  HR: '分隔线',
  TABLE: '表格',
  TR: '表格行',
  TD: '单元格',
  TH: '表头',
  SECTION: '区块',
  ARTICLE: '文章块',
  HEADER: '页眉',
  FOOTER: '页脚',
  MAIN: '主体',
  NAV: '导航',
  ASIDE: '侧栏',
  DIV: '容器',
  FIGURE: '图片块',
  FIGCAPTION: '图说',
  CODE: '代码',
  PRE: '代码块',
};

/** 推断元素的人话角色 */
export function getElementRole(el) {
  if (!el || el.nodeType !== 1) return '未知元素';
  const role = ROLE_BY_TAG[el.tagName] || el.tagName.toLowerCase();
  // 进一步细化：DIV 的角色按 className 猜测
  if (el.tagName === 'DIV') {
    const cls = (el.className || '').toString().toLowerCase();
    if (/\b(card|item)\b/.test(cls)) return '卡片';
    if (/\b(col|column)\b/.test(cls)) return '列';
    if (/\b(row)\b/.test(cls)) return '行';
    if (/\b(grid)\b/.test(cls)) return '网格';
    if (/\b(hero|banner)\b/.test(cls)) return '主视觉区';
    if (/\b(toolbar)\b/.test(cls)) return '工具栏';
  }
  return role;
}

// ─── 页码定位（基于 v0.7.5 的 <section data-page="N"> 约定）──

/** 找到元素所在的 page 信息（无则返回 null）*/
export function describePage(el) {
  if (!el || el.nodeType !== 1) return null;
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (cur.tagName === 'SECTION' && cur.hasAttribute('data-page')) {
      const idx = parseInt(cur.getAttribute('data-page'), 10);
      const layout = cur.getAttribute('data-layout') || null;
      return { index: isNaN(idx) ? null : idx, layout };
    }
    cur = cur.parentElement;
  }
  return null;
}

/** 找到元素在父中的 column / position 提示（同类的第几个）*/
export function describePosition(el) {
  if (!el || !el.parentElement) return null;
  const parent = el.parentElement;
  const same = Array.from(parent.children).filter(c => c.tagName === el.tagName);
  const idx = same.indexOf(el);
  if (same.length <= 1) return null;
  return { index: idx + 1, total: same.length, sameTagName: el.tagName.toLowerCase() };
}

// ─── computed style → 人话 ─────────────────────────────────

/**
 * 输出按"设计师关心的维度"分组的样式人话清单。
 * 每条：{ key, label, value, raw, swatch?: '#hex' }
 *   - key: 'color' / 'fontSize' / ...
 *   - label: 中文标签
 *   - value: 人话值（"深棕 #3a2a18" / "32px" / "中粗"）
 *   - raw: 原始 computed value（给 AI 用）
 *   - swatch: 颜色类有色块时给 hex
 */
export function describeStyles(el) {
  if (!el || el.nodeType !== 1) return [];
  const view = el.ownerDocument?.defaultView;
  if (!view) return [];
  const cs = view.getComputedStyle(el);

  const out = [];
  // 颜色
  const color = cs.color;
  if (color && color !== 'rgba(0, 0, 0, 0)') {
    out.push({ key: 'color', label: '颜色', value: rgbToHumanColor(color), raw: color, swatch: rgbToHex(color) });
  }
  const bg = cs.backgroundColor;
  if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
    out.push({ key: 'background', label: '背景', value: rgbToHumanColor(bg), raw: bg, swatch: rgbToHex(bg) });
  }
  // 字体
  if (cs.fontSize) {
    out.push({ key: 'fontSize', label: '字号', value: cs.fontSize, raw: cs.fontSize });
  }
  if (cs.fontFamily) {
    out.push({ key: 'fontFamily', label: '字体', value: simplifyFontFamily(cs.fontFamily), raw: cs.fontFamily });
  }
  if (cs.fontWeight) {
    out.push({ key: 'fontWeight', label: '字重', value: weightToHuman(cs.fontWeight), raw: cs.fontWeight });
  }
  if (cs.lineHeight && cs.lineHeight !== 'normal') {
    out.push({ key: 'lineHeight', label: '行高', value: cs.lineHeight, raw: cs.lineHeight });
  }
  if (cs.letterSpacing && cs.letterSpacing !== 'normal') {
    out.push({ key: 'letterSpacing', label: '字距', value: cs.letterSpacing, raw: cs.letterSpacing });
  }
  if (cs.textAlign && cs.textAlign !== 'start') {
    out.push({ key: 'textAlign', label: '对齐', value: alignToHuman(cs.textAlign), raw: cs.textAlign });
  }
  if (cs.textTransform && cs.textTransform !== 'none') {
    out.push({ key: 'textTransform', label: '大小写', value: transformToHuman(cs.textTransform), raw: cs.textTransform });
  }
  // 边距
  const m = `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`;
  if (cs.marginTop !== '0px' || cs.marginBottom !== '0px') {
    out.push({ key: 'margin', label: '外边距', value: m.replace(/0px/g, '0').trim(), raw: m });
  }
  const p = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
  if (cs.paddingTop !== '0px' || cs.paddingBottom !== '0px') {
    out.push({ key: 'padding', label: '内边距', value: p.replace(/0px/g, '0').trim(), raw: p });
  }
  if (cs.borderRadius && cs.borderRadius !== '0px') {
    out.push({ key: 'borderRadius', label: '圆角', value: cs.borderRadius, raw: cs.borderRadius });
  }

  return out;
}

// ─── 可调维度（按元素角色过滤）─────────────────────────────

const ALL_ADJUSTABLES = [
  { key: 'color',         label: '颜色' },
  { key: 'fontSize',      label: '字号' },
  { key: 'fontFamily',    label: '字体' },
  { key: 'fontWeight',    label: '字重' },
  { key: 'lineHeight',    label: '行高' },
  { key: 'letterSpacing', label: '字距' },
  { key: 'textAlign',     label: '对齐' },
  { key: 'textTransform', label: '大小写' },
  { key: 'background',    label: '背景' },
  { key: 'padding',       label: '内边距' },
  { key: 'margin',        label: '外边距' },
  { key: 'borderRadius',  label: '圆角' },
];

/** 列出对该元素有意义的可调维度 */
export function describeAdjustables(el) {
  if (!el || el.nodeType !== 1) return [];
  const tag = el.tagName;
  // 文本类元素：所有文字相关 + 间距 + 颜色
  if (['H1','H2','H3','H4','H5','H6','P','SPAN','LI','A','STRONG','EM','SMALL','LABEL','BLOCKQUOTE','BUTTON'].includes(tag)) {
    return ALL_ADJUSTABLES;
  }
  // 容器类：背景 / 边距 / 圆角 / 对齐
  if (['DIV','SECTION','ARTICLE','HEADER','FOOTER','MAIN','NAV','ASIDE','FIGURE'].includes(tag)) {
    return ALL_ADJUSTABLES.filter(a => ['background', 'padding', 'margin', 'borderRadius', 'textAlign', 'color'].includes(a.key));
  }
  // 图片：边距 / 圆角
  if (['IMG','SVG'].includes(tag)) {
    return ALL_ADJUSTABLES.filter(a => ['padding', 'margin', 'borderRadius'].includes(a.key));
  }
  return ALL_ADJUSTABLES;
}

// ─── AI 上下文视图（给 LLM 工具调用的 input）──────────────

/**
 * 序列化元素给 AI：完整 path / computed / outerHTML / siblings
 * 这是不做翻译的"机器视图"
 */
export function serializeForAI(el) {
  if (!el || el.nodeType !== 1) return null;
  const anchor = serializeAnchor(el);
  const view = el.ownerDocument?.defaultView;
  const cs = view ? view.getComputedStyle(el) : null;
  const computed = cs ? Object.fromEntries(
    ['color','backgroundColor','fontSize','fontFamily','fontWeight','lineHeight','letterSpacing',
     'textAlign','textTransform','margin','padding','borderRadius','width','height','display']
      .map(k => [k, cs[k]])
  ) : null;
  const siblings = el.parentElement
    ? Array.from(el.parentElement.children).map((c, i) => ({
        index: i,
        tag: c.tagName.toLowerCase(),
        isSelf: c === el,
        textBrief: (c.textContent || '').trim().slice(0, 40),
      }))
    : [];
  return {
    tag: el.tagName.toLowerCase(),
    anchor,
    pageInfo: describePage(el),
    outerHtml: (el.outerHTML || '').slice(0, 2000),
    computed,
    siblings,
  };
}

// ─── helper：rgb/hex/family/weight 翻译 ───────────────────

const COLOR_NAMES = [
  // DeskSkill palette 已知色 → 中文名
  ['#3a2a18', '深棕'],
  ['#4a4540', '正文棕'],
  ['#5a5550', '中棕灰'],
  ['#7a6a55', '浅棕灰'],
  ['#8a7a62', '辅助色'],
  ['#a09888', '次要灰'],
  ['#c4bfb5', '禁用灰'],
  ['#f9f8f6', '页面底'],
  ['#fdfcfa', '弹窗底'],
  ['#f6f1ea', '卡片底'],
  ['#2d2418', '亮黑'],
  ['#3d3428', '亮黑悬停'],
  ['#f5f0e8', '反白文字'],
  ['#b83a2a', '错误红'],
  ['#4a8a4a', '成功绿'],
  ['#b85c1a', '警告橙'],
  ['#5a7a9a', '蓝灰'],
  ['#8a6a3a', '金棕'],
];

function rgbToHex(rgb) {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

function rgbToHumanColor(rgb) {
  const hex = rgbToHex(rgb).toLowerCase();
  const named = COLOR_NAMES.find(([h]) => h.toLowerCase() === hex);
  if (named) return `${named[1]} ${hex}`;
  return hex;
}

function simplifyFontFamily(family) {
  // 取第一个家族（去引号）
  const first = family.split(',')[0].trim().replace(/['"]/g, '');
  return first;
}

function weightToHuman(weight) {
  const w = parseInt(weight, 10);
  if (isNaN(w)) return weight;
  if (w <= 200) return '极细 ' + w;
  if (w <= 300) return '细 ' + w;
  if (w <= 400) return '常规 ' + w;
  if (w <= 500) return '中粗 ' + w;
  if (w <= 600) return '半粗 ' + w;
  if (w <= 700) return '粗 ' + w;
  if (w <= 800) return '特粗 ' + w;
  return '极粗 ' + w;
}

function alignToHuman(align) {
  return ({ left: '左', right: '右', center: '居中', justify: '两端' })[align] || align;
}

function transformToHuman(t) {
  return ({ uppercase: '全大写', lowercase: '全小写', capitalize: '首字母大写' })[t] || t;
}
