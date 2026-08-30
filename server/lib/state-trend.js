/**
 * server/lib/state-trend.js —— 状态表的历史序列（2026-08-30 画图能力线·活图第一块）
 *
 * 状态表住在一条板书文件里、板书文件进 git、工作区**每回合落一个 commit**
 * （session-loop turn commit）—— 所以「好感度随拍数怎么走」的序列是**现成的**，
 * 不用第二份存储不用记账，git 就是时间轴。这是别家没有的弹药。
 *
 * 读侧纪律与状态表同款：拿不到就大声说拿不到（没有表 / 历史不足 / 值不是数字），
 * 不画一根瞎编的线。git 操作全只读（log/show），不进写 mutex。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findStateTable, parseStateTable } from './state-table.js';
import { parseChalk } from './chalk.js';

const run = promisify(execFile);
const MAX_POINTS = 80;

/** 值里抠数字：`5`→5、`8/10`→8、`≈3.5`→3.5；抠不出返回 null */
export function numOf(value) {
  const m = /-?\d+(?:\.\d+)?/.exec(String(value ?? ''));
  return m ? Number(m[0]) : null;
}

/**
 * 某个键的历史序列（旧→新，末尾是**盘上现值**——本回合改了还没 commit 的也算数）。
 * @returns {{ ok:true, points:number[], rel:string } |
 *           { ok:false, why:string, rel?:string, points?:number[] }}
 */
export async function trendSeries(sharedRoot, key) {
  const f = await findStateTable(sharedRoot);
  if (!f.found) return { ok: false, why: f.reason === 'multiple' ? '有两条挂着状态表 tag 的板书，先合成一条' : '板上还没有状态表（tag: 状态表 的那条板书）' };
  const rel = f.rel;

  let hashes = [];
  try {
    const { stdout } = await run('git', ['log', '--format=%H', '--reverse', '--follow', '--', rel], { cwd: sharedRoot });
    hashes = stdout.trim().split('\n').filter(Boolean);
  } catch { /* 没有 git 历史就只有现值 */ }
  if (hashes.length > MAX_POINTS) hashes = hashes.slice(hashes.length - MAX_POINTS);

  const points = [];
  for (const h of hashes) {
    try {
      const { stdout } = await run('git', ['show', `${h}:${rel}`], { cwd: sharedRoot });
      const rows = parseStateTable(parseChalk(stdout).body || '');
      if (!rows.ok) continue;
      const row = rows.rows.find((r) => r.key === key);
      if (!row) continue;
      const v = numOf(row.value);
      if (v === null) continue;
      // 同值连点不压缩：横盘也是信息（十拍没动 = 一条平线）
      points.push(v);
    } catch { /* 某个版本读不出就跳过 */ }
  }

  // 盘上现值收尾（本回合 set_vars 改过、还没 commit）
  const { readStateVars } = await import('./state-table.js');
  const live = await readStateVars(sharedRoot);
  if (live.state === 'ok') {
    const row = live.rows.find((r) => r.key === key);
    const v = row ? numOf(row.value) : null;
    if (v !== null && (points.length === 0 || v !== points[points.length - 1])) points.push(v);
    if (row && v === null) return { ok: false, rel, why: `「${key}」的现值是「${row.value}」，抠不出数字 —— 趋势线只画得了数` };
    if (!row) return { ok: false, rel, why: `状态表里没有「${key}」这个键` };
  }
  if (points.length < 2) {
    return { ok: false, rel, points, why: `「${key}」目前只有 ${points.length} 个数据点（历史随每回合的 git commit 长出来）—— 至少两点才有线，过几拍再画` };
  }
  return { ok: true, points, rel };
}

/**
 * 序列 → 手绘折线的**几何**（局部像素；抖动由调用方加，跟全族同一支笔）。
 * @returns {{ w,h, lineD:string, baselineD:string, dotD:string, min:number, max:number }}
 */
export function trendGeometry(points, { w = 336, h = 120 } = {}) {
  const P = 8;
  const min = Math.min(...points); const max = Math.max(...points);
  const span = (max - min) || 1;
  const iw = w - P * 2; const ih = h - P * 2;
  const xy = points.map((v, i) => ({
    x: P + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw),
    y: P + ih - ((v - min) / span) * ih,
  }));
  const f = (n) => Math.round(n * 10) / 10;
  const lineD = xy.map((p, i) => `${i ? 'L' : 'M'} ${f(p.x)} ${f(p.y)}`).join(' ');
  const last = xy[xy.length - 1];
  // 端点小圈（现值在哪）
  const r = 3;
  const dotD = `M ${f(last.x - r)} ${f(last.y)} C ${f(last.x - r)} ${f(last.y - r * 1.4)} ${f(last.x + r)} ${f(last.y - r * 1.4)} ${f(last.x + r)} ${f(last.y)} C ${f(last.x + r)} ${f(last.y + r * 1.4)} ${f(last.x - r)} ${f(last.y + r * 1.4)} ${f(last.x - r)} ${f(last.y)}`;
  return { w, h, lineD, baselineD: `M ${P} ${h - P} L ${w - P} ${h - P}`, dotD, min, max };
}
