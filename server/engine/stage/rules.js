/**
 * engine/stage/rules.js —— 成就与触发的机械层（2026-09-05 晚）
 *
 * 一张规则表（<故事>/规则.json），两列：
 *   achievements: [{ id, title, desc, when, hidden?, tier? }]   达成一次，弹奖杯，记进 成就.jsonl
 *   triggers:     [{ id, when, once?, note }]                   条件成立就把 note 当便条接在下一句话后面
 *
 * `when` 只许比较：`好感 >= 60 and 表白状态 == 1`、`拍数 > 30 or 时间 == 放学`。
 * 比较符 >= <= > < == !=；连接词 and / or / && / || / 且 / 或；and 比 or 优先；不支持括号。
 * 值是数字就按数字比，否则按字符串比；键不存在的项一律为假。**没有 eval**。
 *
 * 阈值是主 agent 从酒馆卡里翻出来、按用户选的难度定的；机械层只做比较，不做判断 ——
 * 这条跟"机器不做调度"不冲突：谁开口怎么开口还是模型写，机器只报"阈值到了"。
 */

const OP_RE = /^(.+?)\s*(>=|<=|==|!=|>|<|＝＝|≥|≤)\s*(.+)$/;
const OPS = { '≥': '>=', '≤': '<=', '＝＝': '==' };

function coerce(v) {
  const s = String(v ?? '').trim().replace(/^["'“”「」]|["'“”「」]$/g, '');
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s) ? n : s;
}

/** 单个比较项。键不存在 → false（不是 0 也不是空串：没量过的东西不参与判断） */
export function evalTerm(term, state) {
  const m = OP_RE.exec(String(term).trim());
  if (!m) return false;
  const key = m[1].trim();
  const op = OPS[m[2]] || m[2];
  if (!(key in (state || {}))) return false;
  const a = coerce(state[key]);
  const b = coerce(m[3]);
  const bothNum = typeof a === 'number' && typeof b === 'number';
  switch (op) {
    case '>=': return bothNum && a >= b;
    case '<=': return bothNum && a <= b;
    case '>': return bothNum && a > b;
    case '<': return bothNum && a < b;
    case '==': return bothNum ? a === b : String(a) === String(b);
    case '!=': return bothNum ? a !== b : String(a) !== String(b);
    default: return false;
  }
}

/** 整条条件：or 的每一支是若干 and 项 */
export function evalCondition(cond, state) {
  const text = String(cond || '').trim();
  if (!text) return false;
  const ors = text.split(/\s+(?:or|\|\||或)\s+/i);
  return ors.some(branch => branch.split(/\s+(?:and|&&|且)\s+/i).every(t => evalTerm(t, state)));
}

/** 条件写得对不对（给 open_stage 收规则时把手写错的当场退回） */
export function validateCondition(cond) {
  const text = String(cond || '').trim();
  if (!text) return '条件是空的';
  for (const term of text.split(/\s+(?:or|\|\||或|and|&&|且)\s+/i)) {
    if (!OP_RE.test(term.trim())) return `看不懂「${term.trim()}」：要写成 键 比较符 值，比如 好感 >= 60`;
  }
  return null;
}

/**
 * 跑一遍规则。
 * @param {{achievements:Array, triggers:Array}} rules
 * @param {object} state         当前状态（含机器补的 拍数）
 * @param {{ earned: Set<string>, fired: Set<string> }} seen   已达成的成就 id / 已触发过的一次性触发 id
 * @returns {{ trophies: Array, notes: Array<{id, note}> }}  新达成的成就、这次要递的纸条
 */
export function evaluateRules(rules, state, seen) {
  const trophies = [];
  const notes = [];
  for (const a of rules?.achievements || []) {
    if (!a?.id || seen.earned.has(a.id)) continue;
    if (evalCondition(a.when, state)) trophies.push({ id: a.id, title: a.title || a.id, desc: a.desc || '', tier: a.tier || 'bronze', hidden: !!a.hidden });
  }
  for (const t of rules?.triggers || []) {
    if (!t?.id || !t.note) continue;
    if (t.once !== false && seen.fired.has(t.id)) continue;
    if (evalCondition(t.when, state)) notes.push({ id: t.id, note: t.note });
  }
  return { trophies, notes };
}
