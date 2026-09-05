import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { loadWorldbook, matchEntries, loreNote } from './worldbook.js';

/** 世界书机械触发：两种 keys 写法都认、常驻不扫、命中多的在前、封顶、冷却跳过。 */
const tmps = [];
async function play(files) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-lore-'));
  tmps.push(d);
  for (const [rel, c] of Object.entries(files)) { const p = path.join(d, rel); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('世界书触发', () => {
  it('导出的 JSON 数组键和手写的 YAML 流键都认；常驻/ 与 constant:true 不扫；没 keys 的不算', async () => {
    const d = await play({
      '世界书/a.md': '---\nname: 河边台阶\nkeys: ["河边", "台阶"]\n---\n她放学后常坐的地方。',
      '世界书/b.md': '---\nname: 阶段2\nkeys: [好感度80, 使唤, 外号]\nwhen: 好感度 >= 80\n---\n熟稔期。',
      '世界书/常驻/w.md': '---\nname: 世界观\nkeys: [江南]\n---\n常驻的。',
      '世界书/c.md': '---\nname: 常量\nkeys: [x]\nconstant: true\n---\n也常驻。',
      '世界书/d.md': '---\nname: 无键\n---\n不触发。',
      '世界书/e.md': '---\nname: 正则\nkeys: ["/雨.*/i", 伞]\n---\n带伞。',
    });
    const es = await loadWorldbook(d);
    expect(es.map(e => e.name).sort()).toEqual(['正则', '河边台阶', '阶段2'].sort());
    expect(es.find(e => e.name === '正则').keys).toEqual(['伞']);
    const m = matchEntries(es, '放学她一个人去了河边，坐在台阶上给他起了个外号');
    expect(m.map(x => x.name)).toEqual(['河边台阶', '阶段2']);   // 两键命中的在前
    expect(loreNote(m)).toMatch(/^【世界书 · 河边台阶】\n她放学后常坐的地方。/);
    expect(matchEntries(es, '河边', { skip: new Set(['河边台阶']) })).toEqual([]);
    expect(matchEntries(es, '')).toEqual([]);
  });
  it('封顶：条数与字数', () => {
    const es = Array.from({ length: 6 }, (_, i) => ({ rel: `世界书/${i}.md`, name: `e${i}`, keys: ['桥'], text: 'x'.repeat(1000) }));
    expect(matchEntries(es, '过桥').length).toBe(3);   // 3000 字封顶先到
    expect(matchEntries(es, '过桥', { maxChars: 100000 }).length).toBe(4);
  });
});

import { sceneOf, normalizeScene, sceneKey } from './mechanics.js';
describe('换场判据（09-06 exp 真机：模型 12 段一次 scene 都没给）', () => {
  it('scene 字段优先；没有就从状态值的地点 + 时间推；没地点就 null', () => {
    expect(sceneOf({ scene: '河边 · 傍晚' }, { 地点: '教室' })).toBe('河边 · 傍晚');
    expect(sceneOf({}, { 地点: '教室', 时间: '08:00', 好感度: 3 })).toBe('教室 · 清晨');
    expect(sceneOf({}, { 地点: '河边台阶', 时间: '傍晚放学后' })).toBe('河边台阶 · 傍晚放学后');
    expect(sceneOf({}, { 好感度: 3 })).toBeNull();
  });
  it('键去掉日期钟点：同一个地方换钟点不算换场', () => {
    expect(normalizeScene('教室 · 2022年3月1日 08:00')).toBe('教室');
    expect(sceneKey('教室 · 08:05')).toBe(sceneKey('教室 · 2022年3月1日 08:00'));
    expect(sceneKey('教室 · 清晨')).not.toBe(sceneKey('河边 · 清晨'));
  });
});
