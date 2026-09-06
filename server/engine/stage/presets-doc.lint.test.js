import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { renderPresetsDoc, currentSkillSection, SKILL_FILE, PRESETS_DIR } from '../../scripts/gen-presets-doc.mjs';
import path from 'node:path';

/**
 * stage-setup/SKILL.md 文末那张「写法预设的模块表」是主循环预选 style.on / off 时查的表（09-06）。
 * 它由 gen-presets-doc.mjs 从 preset.json 生成 —— 这条闸钉着两件事：
 *   1. SKILL.md 里嵌的那段 == 生成器此刻的输出（改了 preset.json 没跑生成器 → 红）；
 *   2. 每个模块都有 hint（agent 只看得到这一句，没有它就只剩一个 id，文学派两个模块曾经就是这样）。
 */
describe('SKILL.md 里的写法预设表是从 preset.json 生成的', () => {
  it('嵌进 SKILL.md 的那段等于生成器输出', () => {
    const skill = fs.readFileSync(SKILL_FILE, 'utf8');
    expect(currentSkillSection(skill)).toBe(renderPresetsDoc());
  });
  for (const id of ['izumi', 'literary']) {
    it(`${id} 每个模块都有 hint，每个 cue 都能落成一行`, () => {
      const meta = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, id, 'preset.json'), 'utf8'));
      expect(meta.modules.filter(m => !m.hint).map(m => m.id)).toEqual([]);
      const doc = renderPresetsDoc();
      for (const m of meta.modules) {
        expect(doc, `${m.id} 不在表里`).toContain(`\`${m.id}\``);
        if (m.cue) expect(doc).toContain(`| ${m.cue.replace(/^（关）|^（默认）/, '')} |`);
      }
    });
  }
});
