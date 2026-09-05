/**
 * server/lib/state-table.js —— 状态表：板上那张 `| 键 | 值 |` 的解析与改写
 * （2026-08-30）
 *
 * ## 为什么真相是一张 markdown 表，不是一份 JSON
 *
 * 演出里"会变、要记得"的东西（好感度 / 时间 / 线索 / 体力）此前住在状态板的正文里，
 * 是一段自由文本，每拍靠 agent 整卡重写。想让程序参与（下一轮提醒它、将来按条件
 * 触发）就得有结构。
 *
 * 结构可以另起一份存储（`.nd/vars.json` 之类），但那条路被两件事否掉：
 *   - `.nd/` 在 gitignore 里（workspace-templates.js）。存那儿 = 用户在画布上看不见、
 *     git 里没历史、`revertWorkspace` 回滚正文却不回滚它 →「旧故事配新数值」，
 *     而且没有任何东西会报这个错。
 *   - 另起一份 = 同一件事两份真相。状态板的字**已经**在 `notes/板书/` 里、已经进 git、
 *     已经每轮 commit。再存一份就是这条线上翻过最多次车的那种账。
 *
 * 所以：**真相仍是那条板书文件，只是约定它正文里有一张固定格式的表。**
 * 服务端只读解析出派生值喂每轮状态块；`set_vars` 做的是"精确改表里那一格"，
 * 不是重写整张卡。文件内容 = 显示内容 = agent Read 到的内容，三者逐字相同。
 *
 * ## 定位判据：tag，不是文件名、不是隐形标记
 *
 * ⛔ **不能用藏在 frontmatter 里的自造键**：`renderChalk` 只回写白名单键，
 *    一次 `edit_board set_text` 就把它整行丢掉，而且不报错。
 * ⛔ **不能用固定文件名**（`状态表.md` 那种）：chalk 目录的文件名是时间戳，
 *    `recentChalk` 和首页摘句都拿"文件名倒序"当"最近"判据 —— 一个 CJK 开头的
 *    固定名在字典序里排在所有数字时间戳之后，倒序后永远第一，
 *    结果是**首页每个演出项目的卡常年显示「| 键 | 值 |」**。
 * ✅ 用 `tag: 状态表`（专用 tag，跟状态板那个**组** tag 分开）。tag 是少数能双向
 *    往返的字段（parseChalk 读、renderChalk 写、set_text 保留），改名搬位都不影响。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CHALK_DIR, parseChalk } from './chalk.js';

/** 状态表专用 tag。⚠️ 跟旧黑板 RP 的「状态板」组 tag 是两个东西（那套版面协议 09-06 已退役）：
 *  那个是一**组**卡的组名，这个专指承载键值表的那一条。 */
export const STATE_TABLE_TAG = '状态表';

/** 值的上限：一格里塞长文是把表当笔记本用，那是板书正文的活 */
export const VALUE_MAX = 120;
/** 键的上限与字符集：键要能当标识符用（将来触发器按它寻址），别收任意文本 */
export const KEY_MAX = 40;
const KEY_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_·-]{0,39}$/u;

/**
 * 剥掉围栏块再找表。
 * 板书里最常见的围栏是 ```nd:controls（控件声明），里面完全可能出现竖线。
 * 判据抄 board-excerpt.js 的 excerptOf —— 那儿已经为同一个理由剥过一次。
 */
export function stripFences(body) {
  return String(body || '')
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$|^[ \t]*```[\s\S]*$/gm, '');
}

const SEP_RE = /^\s*\|?[\s:-]*-[-\s:|]*\|?\s*$/;      // | --- | --- |
const HEAD_RE = /^\s*\|\s*键\s*\|\s*值\s*\|\s*$/;
const FENCE_RE = /^[ \t]*```/;

/**
 * 逐行标出「这一行在围栏里吗」。
 *
 * ⚠️ 不能用 stripFences 之后的**文本**去比对（第一版就是这么写的，当场翻车）：
 * 围栏里那行 `| 键 | 值 |` 和真表头**逐字相同**，按内容判membership 两行都算"活着"，
 * 于是一张表被数成两张。判据必须落在**行号**上，不是行的内容。
 * 未闭合的围栏一路吃到末尾（跟 board-excerpt 的取舍一致：宁可少认，不能把源码当数据）。
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) { mask[i] = true; open = !open; continue; }
    mask[i] = open;
  }
  return mask;
}

function cells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/**
 * 从正文里解析状态表。
 *
 * @returns {{ ok:true, start:number, end:number, rows:Array<{key,value}> }
 *         | { ok:false, error:string }}
 *   start/end 是表在**原始行数组**里的下标区间（含表头与分隔行），改写时按它回填。
 *   ok:false 的两种：没有表、或者有歧义（多张表 / 重复键）—— 一律**大声**，
 *   不 fail-soft 成空表。空表和"读不懂"是两件事，混在一起就是那条最贵的教训。
 */
export function parseStateTable(body) {
  const raw = String(body || '').split(/\r?\n/);
  const inFence = fenceMask(raw);
  const heads = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (!HEAD_RE.test(raw[i])) continue;
    if (inFence[i]) continue;                     // 表头在围栏里 → 不算表
    heads.push(i);
  }
  if (!heads.length) return { ok: false, error: 'no-table' };
  if (heads.length > 1) {
    return { ok: false, error: `这条板书里有 ${heads.length} 张「| 键 | 值 |」表 —— 状态表只能有一张，另一张挪到别的板书上去（明骰表用别的表头）。` };
  }
  const start = heads[0];
  if (!SEP_RE.test(raw[start + 1] || '')) {
    return { ok: false, error: '「| 键 | 值 |」下面缺分隔行（`|---|---|`），这不是一张合法的 markdown 表。' };
  }
  const rows = []; const seen = new Map();
  let end = start + 1;
  for (let i = start + 2; i < raw.length; i += 1) {
    const line = raw[i];
    if (!/^\s*\|/.test(line)) break;              // 表到此为止
    const c = cells(line);
    if (c.length < 2) break;
    const key = c[0]; const value = c[1];
    if (!key) { end = i; continue; }               // 空键行：留着但不算数据
    if (seen.has(key)) {
      return { ok: false, error: `表里「${key}」出现了两次（第 ${seen.get(key) + 1} 行和第 ${i + 1} 行）—— 键必须唯一，先把重复的那行删掉。` };
    }
    seen.set(key, i);
    rows.push({ key, value });
    end = i;
  }
  return { ok: true, start, end, rows };
}

/** 值清洗：压一行、去掉会把表撑破的字符。钳了要说（返回 clamped 让调用方如实报） */
export function sanitizeValue(v) {
  const src = String(v ?? '');
  const s = src
    // 控制字符（含换行、制表、行分隔符）先抹平：一格里塞多行会把表拆散，
    // 而且拆散之后解析器只会少读几行，不会报错 —— 这类静默降级要堵在写口。
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\|/g, '/')                       // 竖线会当场炸表
    .replace(/\s+/g, ' ')
    .trim();
  return { value: s.slice(0, VALUE_MAX), clamped: s.length > VALUE_MAX || src.includes('|') };
}

export function validateKey(k) {
  const s = String(k ?? '').trim();
  if (!s) return '键是空的';
  if (s.length > KEY_MAX) return `键「${s.slice(0, 12)}…」超过 ${KEY_MAX} 字`;
  if (!KEY_RE.test(s)) return `键「${s}」含不能用的字符（只收字母数字、中文、下划线、连字符、间隔号，且不能以连字符开头）`;
  return null;
}

/** 把一张表渲染回 markdown 行（列宽不对齐 —— 对齐了 diff 会整片变） */
export function renderRows(rows) {
  return ['| 键 | 值 |', '| --- | --- |', ...rows.map((r) => `| ${r.key} | ${r.value} |`)];
}

/**
 * 在正文里改/加若干个键，返回新正文与实际发生的变化。
 * 表不存在或看不懂时**抛** —— 调用方负责把话说清楚。
 */
export function applyVars(body, vars) {
  const parsed = parseStateTable(body);
  if (!parsed.ok) {
    const err = new Error(parsed.error === 'no-table'
      ? '这条板书里没有「| 键 | 值 |」表。'
      : parsed.error);
    err.code = parsed.error === 'no-table' ? 'NO_TABLE' : 'BAD_TABLE';
    throw err;
  }
  const rows = parsed.rows.map((r) => ({ ...r }));
  const changed = []; const added = []; const clamped = [];
  for (const [rawKey, rawVal] of Object.entries(vars)) {
    const key = String(rawKey).trim();
    const bad = validateKey(key);
    if (bad) { const e = new Error(bad); e.code = 'BAD_KEY'; throw e; }
    const { value, clamped: cl } = sanitizeValue(rawVal);
    if (cl) clamped.push(key);
    const hit = rows.find((r) => r.key === key);
    if (hit) { if (hit.value !== value) changed.push({ key, from: hit.value, to: value }); hit.value = value; }
    else { rows.push({ key, value }); added.push({ key, value }); }
  }
  const lines = String(body).split(/\r?\n/);
  const next = [...lines.slice(0, parsed.start), ...renderRows(rows), ...lines.slice(parsed.end + 1)];
  return { body: next.join('\n'), rows, changed, added, clamped };
}

/**
 * 在工作区里找那条状态表板书。
 * @returns {{ found:true, rel, abs, raw, body, chalk }
 *         | { found:false, reason:'none' }
 *         | { found:false, reason:'multiple', rels:string[] }}
 */
export async function findStateTable(sharedRoot) {
  const dir = path.join(sharedRoot, CHALK_DIR);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch { return { found: false, reason: 'none' }; }
  const hits = [];
  for (const n of names) {
    let raw;
    try { raw = await fs.readFile(path.join(dir, n), 'utf8'); } catch { continue; }
    const { body, chalk } = parseChalk(raw);
    if (chalk?.tag === STATE_TABLE_TAG) {
      hits.push({ rel: `${CHALK_DIR}/${n}`, abs: path.join(dir, n), raw, body, chalk });
    }
  }
  if (!hits.length) return { found: false, reason: 'none' };
  if (hits.length > 1) return { found: false, reason: 'multiple', rels: hits.map((h) => h.rel) };
  return { found: true, ...hits[0] };
}

/**
 * 给每轮状态块用的读侧。**永远返回一个可渲染的结果**，但「读不懂」和「没有」
 * 是两种不同的返回 —— 上一轮还解析得出、这一轮解析不出，调用方要能报警。
 * @returns {{ state:'none' } | { state:'ok', rel, rows, body } | { state:'broken', rel?, why }}
 */
export async function readStateVars(sharedRoot) {
  const f = await findStateTable(sharedRoot);
  if (!f.found) {
    if (f.reason === 'multiple') {
      return { state: 'broken', why: `板上有 ${f.rels.length} 条 tag 是「${STATE_TABLE_TAG}」的板书（${f.rels.join('、')}）—— 只能有一条。` };
    }
    return { state: 'none' };
  }
  const parsed = parseStateTable(f.body);
  if (!parsed.ok) {
    return {
      state: 'broken',
      rel: f.rel,
      why: parsed.error === 'no-table'
        ? `${f.rel} 挂着「${STATE_TABLE_TAG}」的 tag，但正文里找不到「| 键 | 值 |」表。`
        : parsed.error,
    };
  }
  // body 一起带回：触发器的声明（```nd:triggers 围栏）就住在这条板书的正文里，
  // 调用方拿它去解析，省一次读盘也省一次"两边读的是不是同一份"的疑虑。
  return { state: 'ok', rel: f.rel, rows: parsed.rows, body: f.body };
}
