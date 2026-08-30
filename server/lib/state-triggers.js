/**
 * server/lib/state-triggers.js —— 状态表的条件触发器（2026-08-30）
 *
 * 「把会变的东西写在板上，设条件，需要的时候被动拿回来」的后半截。
 * 前半截（值住在一张 markdown 表里）见 state-table.js。
 *
 * ## 声明住在正文里，不住在第二个存储里
 *
 * 触发器写成一段 ```nd:triggers 围栏，就在状态表那条板书的正文里 ——
 * 跟 `nd:controls`（画布控件的声明）是同一个范式：**机器可读的声明住在用户看得见、
 * 编得动的散文里**。这样用户能看到「现在挂着哪些条件」，也能自己删掉一条。
 *
 * 语法（一行一条，故意窄）：
 *
 *   ```nd:triggers
 *   - [好感度_苏绵 >= 5] once -> 她开始主动找你说话了，这一拍给她一个开口的机会
 *   - [体力 <= 2 && 时间 == 夜] on_cross -> 体力见底又是夜里：这一拍必须有代价
 *   ```
 *
 * `&&` 是唯一的连接词（全都成立才算命中）。没有 `||`、没有括号 —— 那两样一进来
 * 就得写真正的表达式解析器，而**模型拼错一个变量名时静默求值成 false** 是这条线
 * 最怕的那种失效。窄语法换来的是：每一种写错都能当场指出来。
 *
 * ## 触发的是「穿越」，不是「为真」
 *
 * `好感度 >= 5` 一旦满足，之后每一拍都满足。按「为真就触发」写，它会每拍注一遍，
 * 上线当天就变成噪音源。所以只有两档：
 *   - `once`     命中一次就退休（一次性的剧情钩子）
 *   - `on_cross` 每次**从假变真**才触发（会来回摆的条件，比如昼夜、体力）
 *
 * ## 沿状态（上一次是真是假）放 `.nd/`，这次是对的
 *
 * `.nd/` 在 gitignore 里，所以**玩法真相不能放那儿**（那是 state-table.js 头注
 * 否掉 `.nd/vars.json` 的理由）。但沿状态是**派生记账**：丢了的代价只是一次
 * 「上膛不击发」，不是丢故事状态。语义写死：
 *   - 文件缺失 / 解析失败 → 按当前值重新上膛、**不击发**、log 一行
 *   - `revertWorkspace` 不回滚它（gitignore），后果是回滚后已触发过的不会重触发 —— 可接受
 *
 * ## 求值点 = 注入点
 *
 * 只在 UserPromptSubmit 里求值（读盘上的表 + 盘上的沿状态，命中就写进这一轮的
 * 状态块）。不在 set_vars 里求值攒到下一轮 —— 那样中间一次进程重启就静默吞掉一次
 * 触发，正是「哑掉的机制不报错」那族病。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fingerprint } from '../engine/agent/hooks/turn-state-memory.js';

const FENCE_RE = /^[ \t]*```[ \t]*nd:triggers[ \t]*$/;
const FENCE_END_RE = /^[ \t]*```[ \t]*$/;
/** - [<条件>] <mode> -> <话> */
const LINE_RE = /^\s*-\s*\[([^\]]+)\]\s*(once|on_cross)\s*->\s*(.+?)\s*$/;
const OPS = ['>=', '<=', '!=', '==', '>', '<'];

export const LATCH_REL = '.nd/vars-latch.json';
/** 一条触发器的话最多这么长：它是注给模型的一句提醒，不是一段剧本 */
export const MESSAGE_MAX = 200;
export const MAX_TRIGGERS = 24;

/** 把一条条件文本拆成若干个比较（`&&` 连接，全都成立才算命中） */
function parseCond(text) {
  const parts = String(text).split('&&').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: '条件是空的' };
  const cmps = [];
  for (const p of parts) {
    const op = OPS.find((o) => p.includes(o));
    if (!op) return { error: `「${p}」里没有比较符（用 >= <= > < == != 其中之一）` };
    const idx = p.indexOf(op);
    const key = p.slice(0, idx).trim();
    const value = p.slice(idx + op.length).trim();
    if (!key) return { error: `「${p}」缺左边的键名` };
    if (!value) return { error: `「${p}」缺右边的值` };
    cmps.push({ key, op, value });
  }
  return { cmps };
}

/**
 * 从正文里解析 ```nd:triggers 围栏。
 * @returns {{ triggers: Array<{id,cmps,mode,message,raw}>, errors: string[] }}
 *   errors 里每条都指得出是哪一行错在哪 —— 写错要能被看见，不能静默丢。
 */
export function parseTriggers(body) {
  const lines = String(body || '').split(/\r?\n/);
  const triggers = []; const errors = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!inFence) { if (FENCE_RE.test(l)) inFence = true; continue; }
    if (FENCE_END_RE.test(l)) { inFence = false; continue; }
    if (!l.trim()) continue;
    const m = LINE_RE.exec(l);
    if (!m) {
      errors.push(`第 ${i + 1} 行看不懂：${l.trim().slice(0, 60)}\n    （格式是 \`- [键 >= 值] once -> 要说的话\`，mode 只能是 once 或 on_cross）`);
      continue;
    }
    const [, condText, mode, messageRaw] = m;
    const { cmps, error } = parseCond(condText);
    if (error) { errors.push(`第 ${i + 1} 行条件写错了：${error}`); continue; }
    const message = messageRaw.slice(0, MESSAGE_MAX);
    // id 只由「条件 + 档」决定：改那句提醒的措辞不该把沿状态重置掉
    const id = fingerprint(`${cmps.map((c) => `${c.key}${c.op}${c.value}`).join('&&')}|${mode}`);
    triggers.push({ id, cmps, mode, message, raw: l.trim() });
    if (triggers.length >= MAX_TRIGGERS) {
      errors.push(`触发器超过 ${MAX_TRIGGERS} 条，后面的没读 —— 挂太多等于没挂。`);
      break;
    }
  }
  if (inFence) errors.push('```nd:triggers 围栏没闭合，后面的行都没读。');
  return { triggers, errors };
}

const NUM_RE = /^-?\d+(\.\d+)?$/;

/**
 * 求一个比较的值。
 * @returns {{ v:boolean } | { error:string }}
 *
 * ⛔ 跨类型的大小比较**大声拒绝**，不隐式转换：`时间 >= 戌时` 按字典序比出来的
 * 结果看着像那么回事，但它不是任何人想要的语义。钳住但要说 —— 这是 B+ 没有类型
 * 系统换来的代价，只能在求值时付。
 */
function compare(cmp, rows) {
  const row = rows.find((r) => r.key === cmp.key);
  if (!row) return { error: `表里没有「${cmp.key}」这个键` };
  const l = String(row.value).trim(); const r = String(cmp.value).trim();
  const bothNum = NUM_RE.test(l) && NUM_RE.test(r);
  if (cmp.op === '==') return { v: bothNum ? Number(l) === Number(r) : l === r };
  if (cmp.op === '!=') return { v: bothNum ? Number(l) !== Number(r) : l !== r };
  if (!bothNum) {
    return { error: `「${cmp.key} ${cmp.op} ${cmp.value}」比不了：${NUM_RE.test(l) ? '右边' : '左边'}不是数字（大小比较只对数字生效；想比文字用 == 或 !=）` };
  }
  const a = Number(l); const b = Number(r);
  if (cmp.op === '>=') return { v: a >= b };
  if (cmp.op === '<=') return { v: a <= b };
  if (cmp.op === '>') return { v: a > b };
  return { v: a < b };
}

/**
 * 求值一批触发器。**纯函数** —— 落盘由调用方做，好测。
 *
 * @param triggers parseTriggers 的产物
 * @param rows     状态表的现值
 * @param latch    上一次的沿状态 { [id]: { last:boolean, fired:number } }
 * @param opts.fresh  true = 这是本项目第一次求值（沿状态文件不存在/坏了）
 *                    → **上膛不击发**：按当前值记下来，一条都不触发
 * @returns {{ fired:Array<{id,message,raw}>, latch:object, errors:string[], armed:number, retired:number }}
 */
export function evalTriggers(triggers, rows, latch = {}, { fresh = false } = {}) {
  const next = {}; const fired = []; const errors = [];
  let armed = 0; let retired = 0;
  for (const t of triggers) {
    const prev = latch[t.id] || null;
    const firedCount = prev?.fired || 0;
    if (t.mode === 'once' && firedCount > 0) { next[t.id] = prev; retired += 1; continue; }

    let v = true; let bad = null;
    for (const c of t.cmps) {
      const r = compare(c, rows);
      if (r.error) { bad = r.error; break; }
      if (!r.v) { v = false; break; }
    }
    if (bad) {
      errors.push(`${t.raw}\n    → ${bad}`);
      next[t.id] = prev || { last: false, fired: firedCount };   // 求不出来不动沿状态
      armed += 1;
      continue;
    }

    const was = prev ? !!prev.last : false;
    // 上膛不击发：第一次见到这条触发器（或沿状态丢了）只记录，不触发 ——
    // 否则每次进程重启都会把所有当前为真的条件重放一遍
    const shouldFire = !fresh && !!prev && v && !was;
    if (shouldFire) fired.push({ id: t.id, message: t.message, raw: t.raw });
    next[t.id] = { last: v, fired: firedCount + (shouldFire ? 1 : 0) };
    if (t.mode === 'once' && next[t.id].fired > 0) retired += 1; else armed += 1;
  }
  return { fired, latch: next, errors, armed, retired };
}

export async function readLatch(sharedRoot) {
  try {
    const raw = await fs.readFile(path.join(sharedRoot, LATCH_REL), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { latch: {}, fresh: true };
    return { latch: j, fresh: false };
  } catch {
    // 缺失或坏了都走 fresh：按当前值重新上膛、不击发
    return { latch: {}, fresh: true };
  }
}

export async function writeLatch(sharedRoot, latch) {
  const abs = path.join(sharedRoot, LATCH_REL);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(latch, null, 2), 'utf8');
}
