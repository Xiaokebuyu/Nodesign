/**
 * build-from-source.js — 「token 源文件 → .docx」这一步。
 *
 * ⭐**token JSON 是真相源，.docx 是构建产物。** 所以 agent 改的永远是那份
 * JSON，不是 docx —— 直接改产物等于让源和产物各说各话，下一次构建就把手改
 * 的东西抹掉了（这条是 [[nodesign-truth-sources]] 那笔债的预防）。
 *
 * 源文件形状：
 * {
 *   "preset":  "公文",             // 词典条目名。风格**名字层开放**：这是起点不是牢笼
 *   "tokens":  { ... },            // 在 preset 之上覆写；不给 preset 时它就是全部
 *   "content": [ {t:'p', ...} ],   // 正文块
 *   "header":  "页眉文字",          // 可选
 *   "footer":  "页脚文字"           // 可选
 * }
 *
 * schema 是**闭合**的：`validateTokens` 见到没登记过的键直接报错。闭合的是
 * 「哪些问题必须回答」，不是「答案是什么」—— 这跟「不预设范式」不打架。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PRESETS, validateTokens, indentConflict, PARA_KEYS, RUN_KEYS } from './tokens.js';
import { buildDocx } from './build.js';
import { lintDocxSource } from './text-lint.js';

/** 深合并：对象递归，其余（含数组）整体替换 —— 数组是有序整体，逐项合并只会得到怪东西 */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}

export class DocxSourceError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

/**
 * 递归剥掉 `_` 开头的键 —— 源文件里的行内注释约定。
 *
 * 为什么要有：JSON 没有注释语法，而 token 表最需要注释的地方恰恰是**字段旁边**
 * （`firstLineChars: 200` 边上写一句「= 两字符，随字号缩放」比写在文档里管用
 * 得多）。闭合 schema 会把这些键当"未登记字段"拒掉，所以在校验前剥干净。
 *
 * 顺带：agent 自己写源文件时也能用这个约定给自己留话，下次回来还看得懂。
 */
function stripNotes(v) {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, stripNotes(x)]),
    );
  }
  return v;
}

/**
 * content 块的闭合校验（2026-08-18）。
 *
 * 以前只有 `styles` 那三层查键名，**块级完全不查** —— 于是块上写错的键会被
 * 静默忽略。最贵的一次是起手模板自己教错：页脚写 `{"para": {align, indent}}`，
 * 而 buildPara 只读平铺在块上的键，那份页脚的居中**从来没生效过**，而且不报错。
 *
 * 「写了没生效」比「写了报错」坏得多：报错你会改，不报错你会以为已经做到了。
 */
const P_BLOCK_KEYS = new Set(['t', 'style', 'text', 'runs', 'sizePt', 'list', ...PARA_KEYS]);
const RUN_OBJ_KEYS = new Set(['text', 'br', 'fld', 'link', ...RUN_KEYS]);
const TABLE_BLOCK_KEYS = new Set(['t', 'widthsTwip', 'rows']);

/** 超链接目标必须带协议 —— w:hyperlink 走的是 TargetMode="External" 的关系，
 *  相对路径和 #书签是另外两种机制（后者要 w:anchor），这个引擎不做 */
const LINK_SCHEME = /^(https?:\/\/|mailto:|tel:)/i;

function validateContent(content, numbering, { noLinks = false } = {}) {
  const errs = [];
  const numNames = new Set(Object.keys(numbering ?? {}));
  const checkList = (list, where) => {
    if (!list) return;
    const name = typeof list === 'string' ? list : list.name;
    if (!name || !numNames.has(name)) {
      errs.push(`${where}.list: 没有名为 '${name ?? '(未写 name)'}' 的编号定义`
        + (numNames.size ? `，现有：${[...numNames].join(' / ')}` : '（tokens.numbering 是空的，先定义再引用）'));
    }
  };
  const hint = (k) => (k === 'para'
    ? '：块级直接格式是**平铺**在块上的，没有 para 包层 —— 写 {"t":"p","align":"center"}，不是 {"para":{"align":"center"}}'
    : (k === 'border' ? '：键名是复数 borders' : ''));

  const checkPara = (b, where) => {
    for (const k of Object.keys(b)) {
      if (!P_BLOCK_KEYS.has(k)) errs.push(`${where}: unknown key ${k}${hint(k)}`);
    }
    checkList(b.list, where);
    const indErr = indentConflict(b.indent);
    if (indErr) errs.push(`${where}.indent: ${indErr}`);
    for (const [i, r] of (b.runs ?? []).entries()) {
      if (typeof r === 'string') continue;
      if (!r || typeof r !== 'object') { errs.push(`${where}.runs[${i}]: 只能是字符串或对象`); continue; }
      for (const k of Object.keys(r)) {
        if (!RUN_OBJ_KEYS.has(k)) errs.push(`${where}.runs[${i}]: unknown key ${k}`);
      }
      if (r.link != null) {
        if (noLinks) {
          errs.push(`${where}.runs[${i}].link: 页眉页脚里暂不支持超链接（要单独的关系表，还没做）`);
        } else if (typeof r.link !== 'string' || !LINK_SCHEME.test(r.link)) {
          errs.push(`${where}.runs[${i}].link: 要带协议的完整地址（https:// / mailto: / tel:），拿到的是 ${JSON.stringify(r.link)}`);
        } else if (r.text == null) {
          errs.push(`${where}.runs[${i}].link: 链接要有可点的字 —— link 只能配着 text 用`);
        }
      }
    }
  };

  for (const [i, b] of content.entries()) {
    if (!b || typeof b !== 'object') continue;   // t 认不出那条由调用方报，别重复
    if (b.t === 'p') checkPara(b, `content[${i}]`);
    else if (b.t === 'table') {
      for (const k of Object.keys(b)) {
        if (!TABLE_BLOCK_KEYS.has(k)) errs.push(`content[${i}]: unknown key ${k}${hint(k)}`);
      }
      for (const [ri, row] of (b.rows ?? []).entries()) {
        for (const [ci, cell] of (row ?? []).entries()) {
          if (cell && typeof cell === 'object') checkPara(cell, `content[${i}].rows[${ri}][${ci}]`);
        }
      }
    }
  }
  return errs;
}

/**
 * 解析源对象 → { tokens, content, opts }。不碰文件系统，方便单测。
 */
export function resolveSource(rawSrc) {
  if (!rawSrc || typeof rawSrc !== 'object') {
    throw new DocxSourceError('源文件不是一个 JSON 对象');
  }
  const src = stripNotes(rawSrc);

  // 顶层也要闭合（2026-08-18）。以前这里只读认识的几个键，**别的一律静默忽略**
  // —— 这就是"写了没生效"那个病在最外面一层的版本。写这段注释时我自己刚踩到：
  // 把 numbering 放在源文件顶层（它其实住在 tokens 里），如果没有这道闸，
  // 那份编号定义会被安静地丢掉，然后 agent 对着一份没有编号的文档发愁。
  const SRC_KEYS = new Set(['v', 'preset', 'tokens', 'content', 'header', 'footer']);
  const strayTop = Object.keys(src).filter(k => !SRC_KEYS.has(k));
  if (strayTop.length) {
    throw new DocxSourceError(
      `源文件顶层有认不出的键：${strayTop.join(', ')}`,
      `顶层只有这几个：${[...SRC_KEYS].join(' / ')}。`
      + '排版相关的字段（fonts / base / styles / numbering / page / lang）都住在 tokens 里面，'
      + '不在顶层。字段全集见 references/token-schema.md。',
    );
  }

  // 版本号以顶层 v 为准（token-schema.md 教的就是写在顶层）。以前顶层 v 根本没人查，查的是 tokens.v：
  // 带 preset 时预设自带 v 不出事；不带 preset、照文档把 v 写在顶层的 agent 必撞「v must be 1」，
  // 以为校验器误报、二分排查白跑多轮 build（09-11 雾岭手册那轮）。现在 tokens.v 可以不写，缺了继承顶层。
  if (src.v != null && src.v !== 1) {
    throw new DocxSourceError(`顶层 v 只能是 1（现在是 ${JSON.stringify(src.v)}）`, '这是源文件格式的版本号，目前只有 1 这一版。');
  }

  let tokens;
  if (src.preset) {
    const make = PRESETS[src.preset];
    if (!make) {
      throw new DocxSourceError(
        `没有叫「${src.preset}」的词典条目`,
        `现有：${Object.keys(PRESETS).join(' / ')}。要别的风格就不写 preset，直接给完整 tokens。`,
      );
    }
    tokens = merge(make(), src.tokens);
  } else {
    tokens = src.tokens;
    if (!tokens) throw new DocxSourceError('既没给 preset 也没给 tokens，不知道按什么排版');
  }

  if (tokens && typeof tokens === 'object' && tokens.v == null) tokens = { ...tokens, v: 1 };
  const errs = validateTokens(tokens);
  if (errs.length) {
    throw new DocxSourceError('token 没过校验', errs.slice(0, 12).join('\n'));
  }

  const content = src.content;
  if (!Array.isArray(content) || !content.length) {
    throw new DocxSourceError('content 是空的，构建出来会是一份白纸');
  }
  // 早点把块类型的错说清楚 —— 让它掉进 buildBody 里报 `unknown block: undefined`
  // 对 agent 是没有信息量的
  const blockErrs = validateContent(content, tokens.numbering);
  if (blockErrs.length) {
    throw new DocxSourceError('content 里有认不出的字段', blockErrs.join('\n'));
  }
  const bad = content.findIndex(b => !b || !['p', 'table', 'pageBreak'].includes(b.t));
  if (bad >= 0) {
    throw new DocxSourceError(
      `content[${bad}] 的 t 认不出：${JSON.stringify(content[bad]?.t)}`,
      "块类型只有三种：{t:'p'} 段落、{t:'table'} 表格、{t:'pageBreak'} 分页。",
    );
  }

  // ⚠️ 页眉/页脚以前**完全不过校验** —— 而它恰好是这套校验为之而写的那个 bug 的
  // 案发现场（起手模板教的 `{"para":{align:'center'}}` 页脚居中从来没生效过）。
  // content 修好了、页脚照旧静默丢：`{"para":{align:'center'}}` 不报错，生成的
  // `<w:ftr>` 里根本没有 `<w:pPr>/<w:jc>`。同一份判据必须盖到这两处。
  const header = hdrFtr(src.header);
  const footer = hdrFtr(src.footer);
  for (const [name, blocks] of [['header', header], ['footer', footer]]) {
    if (!Array.isArray(blocks) || !blocks.length) continue;
    const errs = validateContent(blocks, tokens.numbering, { noLinks: true });
    if (errs.length) {
      throw new DocxSourceError(`${name}（页${name === 'header' ? '眉' : '脚'}）里有认不出的字段`,
        `${errs.join('\n')}\n（页眉页脚跟 content 里的块是同一套写法：对齐/缩进这些键**平铺在块上**，`
        + '不要包一层 para。）');
    }
  }

  return { tokens, content, opts: { header, footer } };
}

/**
 * 页眉页脚两种写法都收：
 *   "第一页"                     → 一行纯文字（最常见，别逼人写块数组）
 *   [{t:'p', runs:[..., {fld:'PAGE'}]}]  → 完整块，页码域这类要靠它
 *
 * ⚠️ 页码是**域**（`{fld:'PAGE'}`），不是你手写的那个数字 —— 写死 "1" 的页脚
 * 在第二页还是 1。要真页码就得用块写法。
 */
function hdrFtr(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v;
  return [{ t: 'p', style: 'Normal', text: String(v) }];
}

/**
 * 读源文件、构建、写产物。
 * @returns {Promise<{outPath:string, bytes:number, blocks:number, styles:number, preset:string|null}>}
 */
export async function buildFromSource(sourceAbsPath, outAbsPath) {
  let raw;
  try {
    raw = await fs.readFile(sourceAbsPath, 'utf8');
  } catch {
    throw new DocxSourceError(`读不到源文件：${path.basename(sourceAbsPath)}`);
  }
  let src;
  try {
    src = JSON.parse(raw);
  } catch (err) {
    throw new DocxSourceError('源文件不是合法 JSON', err.message);
  }

  const { tokens, content, opts } = resolveSource(src);
  const buf = await buildDocx(tokens, content, opts);
  await fs.writeFile(outAbsPath, buf);
  // 构建成功后跑字符/版式体检（text-lint.js）—— 报不挡建：这些是符号惯例与
  // 一致性问题，闭合 schema 和渲染目视都照不到的那一层
  let lint = { errors: [], notes: [] };
  try { lint = lintDocxSource({ tokens, content, opts }); } catch { /* 体检自己不许成为故障源 */ }
  return {
    outPath: outAbsPath,
    bytes: buf.length,
    blocks: content.length,
    styles: Object.keys(tokens.styles ?? {}).length,
    preset: src.preset ?? null,
    lint,
  };
}
