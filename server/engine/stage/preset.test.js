import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import {
  loadPreset, resolvePreset, listPresets, defaultSelection, normalizeSelection, renderStyle,
  expandMacros, importTavernPreset, saveImportedPreset, BUILTIN_DIR, BUILTIN_IDS,
} from './preset.js';

/**
 * 写法预设：内置两套要齐、勾选要合法、拼出来的「写法」一节要对、酒馆 JSON 要拆得动。
 * 模块正文是数据不是代码，这里只钉形状（文件都在、非空、互斥组每组默认最多一个）。
 */
const tmps = [];
async function play(files = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-preset-'));
  tmps.push(d);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(d, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('内置预设', () => {
  it('两套都在，模块文件齐且非空，互斥组默认最多一个', async () => {
    for (const id of BUILTIN_IDS) {
      const p = await loadPreset(path.join(BUILTIN_DIR, id), { id, builtin: true });
      expect(p, id).toBeTruthy();
      expect(p.modules.length).toBeGreaterThan(3);
      for (const m of p.modules) expect(m.text.length, `${id}/${m.file}`).toBeGreaterThan(10);
      const groups = new Map(p.groups.map(g => [g.id, g]));
      for (const m of p.modules) expect(groups.has(m.group), `${id}/${m.id} 的组 ${m.group}`).toBe(true);
      const perGroup = {};
      for (const m of p.modules) if (m.default && groups.get(m.group)?.exclusive) perGroup[m.group] = (perGroup[m.group] || 0) + 1;
      for (const [g, n] of Object.entries(perGroup)) expect(n, `${id} 组 ${g} 默认开了 ${n} 个`).toBe(1);
    }
  });
  it('Izumi 拆解：文风只默认开顺眼舒服，人称默认第三人称，篇幅默认中；不带作者人设与酒馆宏', async () => {
    const p = await loadPreset(path.join(BUILTIN_DIR, 'izumi'));
    const sel = defaultSelection(p);
    expect(sel['voice-smooth']).toBe(true);
    expect(sel['person-3']).toBe(true);
    expect(sel['len-mid']).toBe(true);
    expect(p.modules.filter(m => m.group === 'voice').length).toBeGreaterThanOrEqual(20);
    for (const m of p.modules) {
      expect(m.text, m.file).not.toMatch(/\{\{|泉此方|小此|Konata|Master/);
    }
  });
});

describe('勾选', () => {
  it('always 组关不掉，互斥组多勾只留一个，没提到的按默认', async () => {
    const p = await loadPreset(path.join(BUILTIN_DIR, 'izumi'));
    const sel = normalizeSelection(p, { 'core-writing': false, 'voice-smooth': true, 'voice-wuxia': true, 'len-mid': false, 'len-long': true });
    expect(sel['core-writing']).toBe(true);
    expect(sel['voice-smooth']).toBe(true);
    expect(sel['voice-wuxia']).toBe(false);
    expect(sel['len-long']).toBe(true);
    expect(sel['len-mid']).toBe(false);
    expect(sel['plot-surprise']).toBe(true);   // 默认开的没提就还是开
  });
});

describe('拼「写法」一节', () => {
  it('默认 Izumi：有标题、有顺眼舒服、没有没选的文风；none 是空', async () => {
    const d = await play();
    const r = await renderStyle(d, { preset: 'izumi' });
    expect(r.text).toMatch(/^## 写法/);
    expect(r.text).toContain('干掉生硬');
    expect(r.text).not.toContain('武侠风味');
    expect(r.picked).toContain('顺眼舒服');
    const r2 = await renderStyle(d, { preset: 'izumi', modules: { 'voice-smooth': false, 'voice-wuxia': true } });
    expect(r2.text).toContain('武侠风味');
    expect(r2.hash).not.toBe(r.hash);
    expect((await renderStyle(d, { preset: 'none' })).text).toBe('');
    expect((await renderStyle(d, undefined)).preset.id).toBe('izumi');   // 没选 = 默认 Izumi
  });
});

describe('酒馆预设导入', () => {
  const ST = {
    prompts: [
      { identifier: 'a', name: '📋说明', content: '{{//作者注}}说明文字说明文字说明文字', system_prompt: false },
      { identifier: 'v1', name: '⚡️推剧情', content: '{{setvar::tjq::- 允许不写无聊剧情：直接跳过时间}}' },
      { identifier: 'v2', name: '⚡️慢推剧情', content: '{{setvar::tjq::- 剧情可以很慢}}' },
      { identifier: 'main', name: '💾主提示', content: '你是作家，与{{user}}协作。叙事要求：{{getvar::tjq}}', system_prompt: true },
      { identifier: 'charDescription', name: '角色描述', content: '', marker: true, system_prompt: true },
      { identifier: 's1', name: '🚢文风-顺眼', content: '<writing_style>生活化直白</writing_style>' },
      { identifier: 's2', name: '🚢文风-武侠', content: '<writing_style>刀光剑影</writing_style>' },
      { identifier: 'end', name: '🌅文风结束', content: '</Tone>' },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 'a', enabled: true }, { identifier: 'v1', enabled: true }, { identifier: 'v2', enabled: false }, { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true }, { identifier: 's1', enabled: true }, { identifier: 's2', enabled: false }, { identifier: 'end', enabled: true },
    ] }],
  };
  it('宏展开：注释删、setvar 留载荷、getvar 换成启用条目的值、{{user}} 换说法', () => {
    expect(expandMacros('{{//x}}a{{setvar::k::载荷}}b{{roll 1d6}}', {})).toBe('a载荷b');
    expect(expandMacros('叙事：{{getvar::tjq}} / {{user}}', { tjq: '跳过' })).toBe('叙事：跳过 / 玩家的角色');
  });
  it('条目 → 模块：marker 与结构条目跳过、启用状态照搬、文风归互斥组、getvar 用的是启用那条的值', () => {
    const r = importTavernPreset(ST, { name: '我的预设' });
    const names = r.meta.modules.map(m => m.name);
    expect(names).not.toContain('角色描述');
    expect(names).not.toContain('🌅文风结束');
    expect(names).not.toContain('📋说明');
    const main = r.meta.modules.find(m => m.name === '💾主提示');
    expect(r.files[main.file]).toContain('直接跳过时间');   // v1 启用、v2 没启用
    expect(r.files[main.file]).toContain('玩家的角色');
    const wuxia = r.meta.modules.find(m => m.name === '🚢文风-武侠');
    expect(wuxia.default).toBe(false);
    expect(wuxia.group).toBe('voice');
    expect(r.meta.groups.find(g => g.id === 'voice').exclusive).toBe(true);
  });
  it('落盘后能 resolve；丢一份原始 JSON 进 预设/ 会被 listPresets 自动拆', async () => {
    const d = await play({ '预设/丢进来的.json': JSON.stringify(ST) });
    const list = await listPresets(d);
    expect(list.map(p => p.id)).toEqual(expect.arrayContaining(['izumi', 'literary', 'user:丢进来的']));
    const p = await resolvePreset(d, 'user:丢进来的');
    expect(p.modules.length).toBe(5);
    await saveImportedPreset(d, '第二份', importTavernPreset(ST, { name: '第二份' }));
    expect((await resolvePreset(d, 'user:第二份')).name).toBe('第二份');
    const r = await renderStyle(d, { preset: 'user:丢进来的' });
    expect(r.text).toContain('生活化直白');
    expect(r.text).not.toContain('刀光剑影');
  });
});
