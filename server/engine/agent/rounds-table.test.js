/**
 * rounds 桌（2026-08-27 四模式版式）：order 成列、发言下行的落位提示。
 * 钉四件：自己的列续尾、首次开口在前一列右边、第一个开口者 null、非 rounds/不在
 * order 的一律 null（机器只管桌上的人）。
 */
import { describe, it, expect } from 'vitest';
import { roundsTableHint } from './rounds-table.js';

const chalk = (by) => ({ x: 100, y: 100, by });
const board = {
  objects: {
    'notes/板书/20260827-100000-a1.md': chalk('rp-a'),
    'notes/板书/20260827-100200-a2.md': chalk('rp-a'),
    'notes/板书/20260827-100100-b1.md': chalk('rp-b'),
    'assets/x.png': { x: 0, y: 0 },
  },
};
const scene = { mode: 'rounds', order: ['rp-a', 'rp-b', 'rp-c'] };

describe('roundsTableHint', () => {
  it('⭐ 自己的列已有话：续在最后一条下面（路径序=时间序）', () => {
    expect(roundsTableHint(scene, board, 'rp-a')).toEqual({ stack: 'notes/板书/20260827-100200-a2.md' });
    expect(roundsTableHint(scene, board, 'rp-b')).toEqual({ stack: 'notes/板书/20260827-100100-b1.md' });
  });

  it('⭐ 首次开口：列开在 order 里前一个有列的成员右边（指列头=最早那条）', () => {
    expect(roundsTableHint(scene, board, 'rp-c')).toEqual({ newColumnRightOf: 'notes/板书/20260827-100100-b1.md' });
    // 前一个成员还没开口就再往前找
    const b2 = { objects: { 'notes/板书/20260827-100000-a1.md': chalk('rp-a') } };
    expect(roundsTableHint(scene, b2, 'rp-c')).toEqual({ newColumnRightOf: 'notes/板书/20260827-100000-a1.md' });
  });

  it('全场第一个开口 / 没座位的板书不算列', () => {
    expect(roundsTableHint(scene, { objects: {} }, 'rp-a')).toBeNull();
    const unseated = { objects: { 'notes/板书/20260827-100000-a1.md': { by: 'rp-a' } } };
    expect(roundsTableHint(scene, unseated, 'rp-b')).toBeNull();
  });

  it('非 rounds、不在 order、场为空：机器不管', () => {
    expect(roundsTableHint({ mode: 'free', order: ['rp-a'] }, board, 'rp-a')).toBeNull();
    expect(roundsTableHint(scene, board, 'rp-z')).toBeNull();
    expect(roundsTableHint(scene, board, 'agent')).toBeNull();
    expect(roundsTableHint(null, board, 'rp-a')).toBeNull();
  });
});
