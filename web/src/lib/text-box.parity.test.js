/**
 * 文字身位估算的 parity 钉子（2026-08-29 纸范式刀 3）。
 *
 * 服务端 sketch-layout.textBox（agent 落板估身位）与前端 text-fonts.estimateTextBox
 * （用户建字的乐观尺寸）此前是两套独立公式（系数 1.06 vs 1.05、按字符数 vs 按 em），
 * 同一段字两边算出两个身位 —— 关系线端点与避让就会因写入方不同而不同。刀 3 统一成
 * 同一公式，这里逐样张对账：改一边忘另一边直接红（board-kind-sizes parity 同款纪律）。
 */
import { describe, it, expect } from 'vitest';
import { textBox } from '../../../server/lib/sketch-layout.js';
import { estimateTextBox } from './text-fonts.js';

describe('textBox ↔ estimateTextBox parity（plain 手写字）', () => {
  const samples = [
    '短句',
    '十二个汉字十二个汉字十二',
    'mixed 中英 mixed line',
    '第一行\n第二行长一些的内容在这里\n三',
    'a'.repeat(80),
  ];
  for (const t of samples) {
    it(`同一段字同一个身位：「${t.slice(0, 12)}…」`, () => {
      for (const size of ['sm', 'md', 'lg']) {
        expect(textBox(t, size, { md: false })).toEqual(estimateTextBox(t, size));
      }
    });
  }
});
