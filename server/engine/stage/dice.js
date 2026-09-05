/**
 * engine/stage/dice.js —— 判定骰（2026-09-06，站主：「掷骰应该有用吧？在合适的时候触发判定」）
 *
 * 一次判定 = 骰面 × 颗数 + 修正，跟难度（dc）比。三处共用同一个函数：
 *   - 演出进程的 `roll` 工具（写正文前自己掷）；
 *   - 玩家点了带 check 的选项（write_scene.choices[].check），机器代掷，结果作便条随那句话进进程；
 *   - 显示器只画 row，不算。
 * 服务端 crypto 真随机，⛔ 模型永远不许自己编点数。
 *
 * row 形状（落进 场景/ 记录，by:'dice'）：
 *   { id, at, by:'dice', reason, sides, count, rolls, kept, modifier, advantage, dc, total, outcome }
 *   outcome：'crit' 大成功 / 'success' / 'fail' / 'fumble' 大失败 / null（没给 dc 只是掷个数）
 */

import crypto from 'node:crypto';

/** 把任何来源（工具入参 / 玩家点的选项）的检定描述整理成合法的一份；不合法的字段落回默认 */
export function normalizeCheck(c = {}) {
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const advantage = ['adv', 'dis'].includes(c.advantage) ? c.advantage : 'none';
  return {
    reason: String(c.reason || c.label || '判定').slice(0, 60),
    sides: int(c.sides, 2, 1000, 20),
    count: advantage === 'none' ? int(c.count, 1, 10, 1) : 1,
    modifier: int(c.modifier, -100, 100, 0),
    advantage,
    dc: c.dc === undefined || c.dc === null || c.dc === '' ? null : int(c.dc, 1, 1000, 10),
  };
}

/**
 * 掷一次。rng(lo, hi) 半开区间，默认 crypto.randomInt；测试注入。
 * 优势 / 劣势：掷两颗取高 / 取低（只对单颗有意义，normalizeCheck 已把 count 收成 1）。
 * 大成功 / 大失败只看单颗 ≥ d20 的天然点数（max / 1），跟修正无关。
 */
export function rollCheck(check, rng = crypto.randomInt) {
  const c = normalizeCheck(check);
  const times = c.advantage === 'none' ? c.count : 2;
  const rolls = Array.from({ length: times }, () => rng(1, c.sides + 1));
  let kept = rolls;
  if (c.advantage === 'adv') kept = [Math.max(...rolls)];
  if (c.advantage === 'dis') kept = [Math.min(...rolls)];
  const natural = kept.reduce((a, b) => a + b, 0);
  const total = natural + c.modifier;
  let outcome = null;
  if (c.dc !== null) {
    outcome = total >= c.dc ? 'success' : 'fail';
    if (kept.length === 1 && c.sides >= 20) {
      if (kept[0] === c.sides) outcome = 'crit';
      else if (kept[0] === 1) outcome = 'fumble';
    }
  }
  return { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'dice', ...c, rolls, kept, total, outcome };
}

export const OUTCOME_TEXT = { crit: '大成功', success: '成功', fail: '失败', fumble: '大失败' };

/** 一行人话：给工具返回、给进程的便条、给显示器的兜底 */
export function diceText(row) {
  const dice = `d${row.sides}${row.count > 1 ? `×${row.count}` : ''}`;
  const mod = row.modifier ? (row.modifier > 0 ? ` +${row.modifier}` : ` ${row.modifier}`) : '';
  const adv = row.advantage === 'adv' ? '（优势）' : row.advantage === 'dis' ? '（劣势）' : '';
  const faces = row.rolls.length > 1 ? `[${row.rolls.join(', ')}]` : String(row.rolls[0]);
  const vs = row.dc !== null && row.dc !== undefined ? ` vs 难度 ${row.dc} → ${OUTCOME_TEXT[row.outcome] || ''}` : '';
  return `${row.reason}：${dice}${mod}${adv} = ${faces}${mod ? ` ${mod.trim()}` : ''}${row.rolls.length > 1 || mod ? ` = ${row.total}` : ''}${vs}`;
}
