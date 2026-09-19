import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {
  loadPreset, resolvePreset, listPresets, defaultSelection, normalizeSelection, renderStyle,
  expandMacros, importTavernPreset, saveImportedPreset, resolveAgentStyle, BUILTIN_DIR, BUILTIN_IDS, DEFAULT_PRESET,
} from './preset.js';

/**
 * 写法预设：内置的要齐、勾选要合法、拼出来的「写法」一节要对、酒馆 JSON 要拆得动。
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
  it('内置的都在，模块文件齐且非空，互斥组默认最多一个', async () => {
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
  it('内置只收有授权的：只剩文学派，默认不用预设；撤下的 id 解析不到', async () => {
    expect(BUILTIN_IDS).toEqual(['literary']);
    expect(DEFAULT_PRESET).toBe('none');
    const d = await play();
    expect(await resolvePreset(d, 'izumi')).toBeNull();
    expect(fsSync.existsSync(path.join(BUILTIN_DIR, 'izumi'))).toBe(false);
    const sel = defaultSelection(await loadPreset(path.join(BUILTIN_DIR, 'literary')));
    expect(sel).toEqual({ logic: true, sentence: true, emergent: true, exhaustive: false, lively: false, 'live-world': true });
  });
});

describe('勾选', () => {
  it('always 组关不掉，互斥组多勾只留一个，没提到的按默认', async () => {
    const p = await loadPreset(path.join(BUILTIN_DIR, 'literary'));
    const sel = normalizeSelection(p, { logic: false, emergent: true, lively: true });
    expect(sel.logic).toBe(true);
    expect(sel.emergent).toBe(true);
    expect(sel.lively).toBe(false);
    const sel2 = normalizeSelection(p, { emergent: false, exhaustive: true });
    expect(sel2.exhaustive).toBe(true);
    expect(sel2.emergent).toBe(false);
    expect(sel2['live-world']).toBe(true);   // 默认开的没提就还是开
  });
});

describe('拼「写法」一节', () => {
  it('文学派：有标题、有默认的写法、没有没选的写法；none 与没选都是空', async () => {
    const d = await play();
    const r = await renderStyle(d, { preset: 'literary' });
    expect(r.text).toMatch(/^## 写法/);
    expect(r.text).toContain('文风名：涌现式叙事');
    expect(r.text).not.toContain('文风名：活泼通俗');
    expect(r.picked).toContain('涌现式叙事');
    const r2 = await renderStyle(d, { preset: 'literary', modules: { emergent: false, lively: true } });
    expect(r2.text).toContain('文风名：活泼通俗');
    expect(r2.hash).not.toBe(r.hash);
    expect((await renderStyle(d, { preset: 'none' })).text).toBe('');
    const dflt = await renderStyle(d, undefined);   // 没选 = 不用预设
    expect(dflt.text).toBe(''); expect(dflt.preset).toBeNull();
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
    expect(list.map(p => p.id)).toEqual(expect.arrayContaining(['literary', 'user:丢进来的']));
    expect(list.map(p => p.id)).not.toContain('izumi');
    const p = await resolvePreset(d, 'user:丢进来的');
    expect(p.modules.length).toBe(5);
    await saveImportedPreset(d, '第二份', importTavernPreset(ST, { name: '第二份' }));
    expect((await resolvePreset(d, 'user:第二份')).name).toBe('第二份');
    const r = await renderStyle(d, { preset: 'user:丢进来的' });
    expect(r.text).toContain('生活化直白');
    expect(r.text).not.toContain('刀光剑影');
  });
});

describe('agent 的预选（open_stage.style → 戏.json）', () => {
  it('on / off 差量另存 style.agent，by 只在真动过时是 agent；不存在的 id 丢掉', async () => {
    const d = await play();
    const plain = await resolveAgentStyle(d, { preset: 'literary' });
    expect(plain.by).toBe('default'); expect(plain.agent).toBeUndefined();
    expect(plain.modules.emergent).toBe(true);
    const r = await resolveAgentStyle(d, { preset: 'literary', on: ['lively', 'no-such-module'], off: ['live-world', 'logic'] });
    expect(r.by).toBe('agent');
    expect(r.agent).toEqual({ on: ['lively'], off: ['live-world', 'logic'] });
    expect(r.modules.lively).toBe(true); expect(r.modules.emergent).toBe(false);   // 互斥组：开一个关掉默认那个
    expect(r.modules['live-world']).toBe(false);
    expect(r.modules.logic).toBe(true);   // always 组关不掉
    const bogus = await resolveAgentStyle(d, { preset: 'literary', on: ['no-such-module'] });
    expect(bogus.by).toBe('default');   // 全是假 id = 什么都没动
    // 09-07：点了名对不上要抛（D2：此前静默落 none，open_stage 还报「写法预设 nope」成功）
    await expect(resolveAgentStyle(d, { preset: 'nope' })).rejects.toMatchObject({ status: 409 });
    await expect(resolveAgentStyle(d, { preset: 'izumi' })).rejects.toMatchObject({ status: 409 });   // 撤下的内置 id 同样对不上
    expect((await resolveAgentStyle(d, { preset: 'none' })).preset).toBe('none');
  });
  it('agent 刚拷进 预设/<名>.json 就直接指 user:<名>：resolvePreset 自己补拆，不静默落回 none', async () => {
    const tavern = { prompts: [{ identifier: 'a', name: '文风-甲', content: '甲的规矩'.repeat(4) }, { identifier: 'b', name: '规则乙', content: '乙的规矩'.repeat(4) }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }] };
    const d = await play({ '预设/我的.json': JSON.stringify(tavern) });
    const r = await resolveAgentStyle(d, { preset: 'user:我的' });
    expect(r.preset).toBe('user:我的'); expect(r.by).toBe('default');
    expect(Object.keys(r.modules).length).toBe(2);
    expect(r.modules.m0).toBe(true); expect(r.modules.m1).toBe(false);   // 启用状态照搬
  });
});
