import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * stage-setup/presets.md 是主循环预选写法模块时查的表（09-06）。表和 preset.json 是两份拷贝，
 * 这条闸钉着：每个模块 id 都在表里 —— 加了模块忘了更新表，agent 就会传一个不存在的 id 进 on/off，机器静默忽略。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.join(HERE, '../plugins/nodesign/skills/stage-setup/presets.md'), 'utf8');

describe('presets.md 跟 preset.json 对得上', () => {
  for (const id of ['izumi', 'literary']) {
    it(`${id} 的每个模块 id 都在表里`, () => {
      const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'presets', id, 'preset.json'), 'utf8'));
      const missing = meta.modules.map(m => m.id).filter(mid => !DOC.includes(`\`${mid}\``));
      expect(missing).toEqual([]);
    });
  }
});
