/**
 * flow 拆条器（2026-08-30 刀⑦）。
 *
 * 判据的重心：**拆分永远不毁内容** —— 围栏/表格整块走、句子不切半、
 * 拼回去逐字等于原文（空行数除外）。拆错比写不下更坏。
 */
import { describe, it, expect } from 'vitest';
import { splitBlocks, flowChunks } from './chalk-flow.js';
import { textBox } from './sketch-layout.js';
import { CARD_MAX_H } from './screen.js';

const P = (n, seed = '这一段讲一件事，句子是完整的。') => Array.from({ length: n }, () => seed).join('');

describe('splitBlocks', () => {
  it('按空行拆，各块 trim 过', () => {
    expect(splitBlocks('甲\n\n乙\n\n\n丙')).toEqual(['甲', '乙', '丙']);
  });

  it('⛔ 围栏里的空行不算边界 —— 代码块/nd:controls/触发器围栏切开比写不下更坏', () => {
    const body = '开头\n\n```nd:controls\n- [A] x -> y\n\n- [B] z -> w\n```\n\n结尾';
    const blocks = splitBlocks(body);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('[A]');
    expect(blocks[1]).toContain('[B]');
  });

  it('表格没有内部空行，天然整块走', () => {
    const blocks = splitBlocks('| 键 | 值 |\n| --- | --- |\n| a | 1 |\n\n正文');
    expect(blocks[0].split('\n')).toHaveLength(3);
  });
});

describe('flowChunks', () => {
  const opts = { wUnits: 18, size: 'md', maxH: CARD_MAX_H };

  it('短文不拆（一块），长文拆成多块且每块 ≤ 上限', () => {
    expect(flowChunks('一句话。', opts)).toHaveLength(1);
    const long = Array.from({ length: 12 }, (_, i) => `第 ${i} 段。${P(3)}`).join('\n\n');
    const chunks = flowChunks(long, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(textBox(c, 'md', { md: true, wUnits: 18 }).h).toBeLessThanOrEqual(CARD_MAX_H);
    }
  });

  it('⭐ 内容一字不丢：所有块拼回去 = 原文的非空行序列', () => {
    const long = Array.from({ length: 10 }, (_, i) => `段落${i}：${P(2)}`).join('\n\n');
    const chunks = flowChunks(long, opts);
    const flat = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    expect(flat(chunks.join('\n\n'))).toBe(flat(long));
  });

  it('单段超高 → 降级到句子边界，仍不切词', () => {
    const giant = P(30);   // 一整段无空行，远超一张卡
    const chunks = flowChunks(giant, opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.endsWith('。')).toBe(true);
  });

  it('贪心装填：小段落尽量并进一条，不是一段一条', () => {
    const many = Array.from({ length: 8 }, (_, i) => `短句 ${i}。`).join('\n\n');
    expect(flowChunks(many, opts)).toHaveLength(1);
  });
});
