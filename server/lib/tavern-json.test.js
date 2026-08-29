// 酒馆导出 JSON 的解析（2026-08-15）：认形态、摘结构、按需取正文
import { describe, it, expect } from 'vitest';
import { detectKind, digest, fetchEntries } from './tavern-json.js';

const 预设 = {
  temperature: 1, top_p: 1, openai_max_tokens: 30000, reasoning_effort: 'min',
  prompts: [
    { identifier: 'a', name: '主提示', role: 'system', content: '你在演一个摊主。' },
    { identifier: 'b', name: '🚢文风-顺眼舒服', role: 'system', content: '短句，少形容词。' },
    { identifier: 'c', name: '🎆文风-华丽', role: 'system', content: '堆意象。' },
    { identifier: 'd', name: '角色描述', role: 'system', content: '', marker: true },
    { identifier: 'e', name: '💡可选功能开始', role: 'system', content: '' },
    { identifier: 'f', name: '深度注入的小纸条', role: 'system', content: '记得留钩子。', injection_position: 1, injection_depth: 4 },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'a', enabled: true },
    { identifier: 'e', enabled: true },
    { identifier: 'b', enabled: true },
    { identifier: 'c', enabled: false },
    { identifier: 'd', enabled: true },
    { identifier: 'f', enabled: true },
  ] }],
};

const 角色卡 = {
  spec: 'chara_card_v2',
  data: {
    name: '沈砚', description: '旧书铺老板。', personality: '克制。', scenario: '民国末年。',
    first_mes: '「进来看看？」', mes_example: '<START>\n{{user}}: 你好', alternate_greetings: ['雨天版开场', '雪天版开场'],
    character_book: { entries: [
      { uid: 1, comment: '铺子布局', key: [], constant: true, content: '三面书架顶到梁。' },
      { uid: 2, comment: '暗巷', key: ['暗巷', '后门'], content: '巷子尽头有扇小门。' },
      { uid: 3, comment: '停用条', key: ['x'], enabled: false, content: '不该出现。' },
    ] },
  },
};

const 世界书 = { entries: { 0: { uid: 0, comment: '夜市', key: ['夜市'], content: '摊子沿河排开。' } } };

describe('认形态', () => {
  it('预设 / 角色卡 / 世界书 各认各的；普通 JSON 返回 null', () => {
    expect(detectKind(预设)).toBe('preset');
    expect(detectKind(角色卡)).toBe('card');
    expect(detectKind(世界书)).toBe('lorebook');
    expect(detectKind({ 随便: 1 })).toBeNull();
    expect(detectKind(null)).toBeNull();
  });
});

describe('预设摘要', () => {
  const d = digest(预设);
  it('只排 order 里的，启用停用分开', () => {
    expect(d.启用.map(e => e.名字)).toEqual(['主提示', '💡可选功能开始', '🚢文风-顺眼舒服', '角色描述', '深度注入的小纸条']);
    expect(d.停用.map(e => e.名字)).toEqual(['🎆文风-华丽']);
  });
  it('⚠️ marker 与分节标题分开标：都要丢，但不是一回事', () => {
    expect(d.占位条目).toEqual(['角色描述']);
    expect(d.分隔条目).toEqual(['💡可选功能开始']);
  });
  it('合计字数只算有正文的启用条；深度注入位记下来', () => {
    expect(d.合计字数).toBe('你在演一个摊主。'.length + '短句，少形容词。'.length + '记得留钩子。'.length);
    expect(d.启用.find(e => e.名字 === '深度注入的小纸条').深度).toBe(4);
  });
  it('参数带出来（我们没有对应旋钮，但要能照实告诉用户）', () => {
    expect(d.参数.最大输出).toBe(30000);
    expect(d.参数.reasoning_effort).toBe('min');
  });
});

describe('角色卡摘要', () => {
  const d = digest(角色卡);
  it('字段表 + 备选开场白 + 内嵌世界书', () => {
    expect(d.名字).toBe('沈砚');
    expect(d.字段.map(f => f.字段)).toContain('first_mes');
    expect(d.开场白备选).toBe(2);
    expect(d.世界书.find(e => e.名字 === '铺子布局').常驻).toBe(true);
    expect(d.世界书.find(e => e.名字 === '暗巷').触发).toEqual(['暗巷', '后门']);
    expect(d.世界书.find(e => e.名字 === '停用条').停用).toBe(true);
  });
});

describe('按需取正文', () => {
  it('预设按名字部分匹配（条目名带 emoji，别逼 agent 抄全名）', () => {
    const 出 = fetchEntries(预设, ['文风-顺眼', '主提示']);
    expect(出.map(e => e.名字)).toEqual(['🚢文风-顺眼舒服', '主提示']);
    expect(出[0].正文).toBe('短句，少形容词。');
  });
  it('角色卡取字段与备选开场白；世界书按条目名', () => {
    expect(fetchEntries(角色卡, ['first_mes'])[0].正文).toBe('「进来看看？」');
    expect(fetchEntries(角色卡, ['alternate_greetings[1]'])[0].正文).toBe('雪天版开场');
    expect(fetchEntries(角色卡, ['暗巷'])[0].正文).toContain('小门');
    expect(fetchEntries(世界书, ['夜市'])[0].正文).toContain('摊子');
  });
  it('取不到就是空数组，不抛', () => {
    expect(fetchEntries(预设, ['没有这条'])).toEqual([]);
    expect(fetchEntries(预设, [])).toEqual([]);
  });
});

/** PNG 卡（08-25 四方世界卡案）：tEXt 块里的 ccv3/chara base64 */
describe('extractCardFromPng', () => {
  const pngWith = (key, obj) => {
    const payload = Buffer.from(`${key}\0${Buffer.from(JSON.stringify(obj)).toString('base64')}`, 'latin1');
    const chunk = (type, data) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1');
      data.copy(b, 8); b.writeUInt32BE(0, 8 + data.length);   // CRC 不校验
      return b;
    };
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('tEXt', payload), chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  it('ccv3 解出 V3 卡；chara 解出 V2；普通 PNG 返回 null', async () => {
    const { extractCardFromPng } = await import('./tavern-json.js');
    const v3 = { spec: 'chara_card_v3', data: { name: '试', first_mes: '嗨' } };
    expect(extractCardFromPng(pngWith('ccv3', v3))?.spec).toBe('chara_card_v3');
    const v2 = { spec: 'chara_card_v2', data: { name: '旧', first_mes: '好' } };
    expect(extractCardFromPng(pngWith('chara', v2))?.spec).toBe('chara_card_v2');
    const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    expect(extractCardFromPng(plain)).toBeNull();
    expect(extractCardFromPng(Buffer.from('not a png'))).toBeNull();
  });

  it('listBookEntries：带正文、常驻/停用/触发词齐', async () => {
    const { listBookEntries } = await import('./tavern-json.js');
    const doc = { spec: 'chara_card_v3', data: { first_mes: 'x', character_book: { entries: [
      { comment: '夏季', keys: ['夏季', '夏至祭'], constant: false, enabled: true, content: '夏天的事' },
      { comment: '主规则', keys: [], constant: true, enabled: true, content: '规则' },
      { comment: '停用的', keys: ['x'], enabled: false, content: '别搬' },
    ] } } };
    const list = listBookEntries(doc);
    expect(list.length).toBe(3);
    expect(list[0]).toMatchObject({ 名字: '夏季', 触发: ['夏季', '夏至祭'], 常驻: false, 停用: false, 正文: '夏天的事' });
    expect(list[1].常驻).toBe(true);
    expect(list[2].停用).toBe(true);
  });
});

/** export_book：机械搬运档（判断归 agent，搬运归机器） */
describe('read_tavern_json export_book', () => {
  it('触发条目一条一文件带 keys，常驻进 常驻/，停用跳过', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-exportbook-'));
    await fs.writeFile(path.join(tmp, 'book.json'), JSON.stringify({ entries: [
      { comment: '夏季', keys: ['夏季', '夏至祭'], constant: false, enabled: true, content: '夏天的事' },
      { comment: '世界总纲', keys: [], constant: true, enabled: true, content: '总纲正文' },
      { comment: '停用的', keys: ['x'], enabled: false, content: '别搬' },
    ] }), 'utf8');
    const { makeReadTavernJsonTool } = await import('../engine/mcp/tools/read-tavern-json.js');
    const t = makeReadTavernJsonTool({ workspaceRoot: tmp, sharedRoot: tmp });
    const r = await t.handler({ path: 'book.json', mode: 'export_book' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('触发 1 条');
    const trig = await fs.readFile(path.join(tmp, '世界书/夏季.md'), 'utf8');
    expect(trig).toContain('keys: ["夏季","夏至祭"]');
    expect(trig).toContain('夏天的事');
    const cst = await fs.readFile(path.join(tmp, '世界书/常驻/世界总纲.md'), 'utf8');
    expect(cst).toContain('constant: true');
    const all = await fs.readdir(path.join(tmp, '世界书'));
    expect(all.some(n => n.includes('停用'))).toBe(false);
  });

  it('out 目录不许越界', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-exportbook2-'));
    await fs.writeFile(path.join(tmp, 'b.json'), JSON.stringify({ entries: [{ comment: 'a', keys: ['a'], enabled: true, content: 'x' }] }), 'utf8');
    const { makeReadTavernJsonTool } = await import('../engine/mcp/tools/read-tavern-json.js');
    const t = makeReadTavernJsonTool({ workspaceRoot: tmp, sharedRoot: tmp });
    const r = await t.handler({ path: 'b.json', mode: 'export_book', out: '../逃逸' });
    expect(r.isError).toBe(true);
  });
});
