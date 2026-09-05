import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { composeStagePrompt, frozenHash } from './prompt.js';
import { parseCardOptions, renderCard } from './card.js';
import { linesOf, currentLine, sceneFileOf, MAIN_LINE } from './play.js';

/**
 * 系统提示词的拼法（09-06 加了写法一节和卡上的可选条目）+ 卡的可选条目解析 + 线路表。
 * 钉的是三件容易断的：可选条目的勾选真进了提示词；写法改了指纹要变（manager 靠它决定重开）；
 * 老配置没有 lines 也得当成只有主线。
 */
const tmps = [];
async function ws(files = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-prompt-'));
  tmps.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

const CARD = `---
name: 晴可
note: 同桌
---
# 晴可
她说话短。

## 可选
- [ ] 有个弟弟 — 家里还有个初中的弟弟，周末要接他
- [x] 会抽烟 — 默认开
- 讨厌下雨天：没有勾选框也算一条

## 别的
不是可选
`;

describe('卡的可选条目', () => {
  it('## 可选 一节下每行一条；勾选框决定默认；破折号 / 冒号后面是说明', () => {
    const opts = parseCardOptions(CARD.replace(/^---[\s\S]*?---\n/, ''));
    expect(opts.map(o => o.label)).toEqual(['有个弟弟', '会抽烟', '讨厌下雨天']);
    expect(opts.map(o => o.default)).toEqual([false, true, false]);
    expect(opts[0].desc).toBe('家里还有个初中的弟弟，周末要接他');
    expect(opts[2].desc).toBe('没有勾选框也算一条');
    expect(opts[0].id).toBe('opt1');
  });
  it('没有那一节就没有条目', () => {
    expect(parseCardOptions('# 某人\n- [ ] 这不算')).toEqual([]);
  });
  it('renderCard：persona 自带大标题就不再叠一个', () => {
    const a = renderCard({ name: '晴可', persona: '# 晴可\n\n她。' });
    expect(a.match(/^# 晴可$/gm).length).toBe(1);
    const b = renderCard({ name: '晴可', persona: '她。' });
    expect(b.match(/^# 晴可$/gm).length).toBe(1);
  });
});

describe('拼系统提示词', () => {
  it('设定 + 卡 + 玩家的可选勾选 + 写法一节 + 工具规矩；指纹随写法 / 勾选变', async () => {
    const d = await ws({ '故事/台面.md': '## 世界\n江南。\n\n## 规矩\n写实。', '故事/角色/晴可/角色卡.md': CARD });
    const cfg = { cast: [{ name: '晴可', card: '故事/角色/晴可/角色卡.md' }], style: { preset: 'literary' }, cardOptions: { '晴可/opt1': true, '晴可/opt2': false } };
    const r = await composeStagePrompt(d, '故事', cfg);
    expect(r.text).toContain('## 世界');
    expect(r.text).toContain('### 晴可（卡在 故事/角色/晴可/角色卡.md）');
    expect(r.text).toMatch(/启用 有个弟弟（家里还有个初中的弟弟，周末要接他）/);
    expect(r.text).toMatch(/不启用 会抽烟（默认开）/);
    expect(r.text).toContain('## 写法');
    expect(r.text).toContain('literary_logic');
    expect(r.text).toContain('write_scene 返回之后这一轮就结束了');
    expect(r.cast[0].options.length).toBe(3);
    expect(r.styleNames).toContain('涌现式叙事');
    const h1 = frozenHash(cfg);
    expect(frozenHash({ ...cfg, style: { preset: 'izumi' } })).not.toBe(h1);
    expect(frozenHash({ ...cfg, cardOptions: { '晴可/opt1': false } })).not.toBe(h1);
    expect(frozenHash({ ...cfg })).toBe(h1);
    expect(r.hash).toBe(h1);
  });
  it('没有台面也没有旧 systemPrompt → 409', async () => {
    const d = await ws({ '故事/戏.json': '{}' });
    await expect(composeStagePrompt(d, '故事', {})).rejects.toMatchObject({ status: 409 });
  });
});

describe('线路表', () => {
  it('老配置没有 lines → 只有主线；currentLine 不认识就回主线；文件名按线路', () => {
    const cfg = { title: 'x', startedAt: 't0' };
    expect(linesOf(cfg)).toEqual([{ id: MAIN_LINE, name: '主线', sdkSid: null, createdAt: 't0' }]);
    expect(currentLine({ ...cfg, currentLine: 'nope' }).id).toBe(MAIN_LINE);
    expect(sceneFileOf(MAIN_LINE)).toBe('场景/scenes.jsonl');
    expect(sceneFileOf('l1abc')).toBe('场景/线-l1abc.jsonl');
    expect(sceneFileOf('../x')).toBe('场景/线-x.jsonl');
    const two = { lines: [{ id: 'main', name: '主线' }, { id: 'lb', name: '分支' }], currentLine: 'lb' };
    expect(currentLine(two).id).toBe('lb');
  });
});
