/**
 * 状态表（2026-08-30）—— 解析、改写、以及「读不懂」这件事的可见性。
 *
 * 这一族断言的重点不是"能不能解析对"，而是**坏掉的时候有没有出声**。
 * 状态表是三方可写的自由文本（set_vars / agent 的 set_text / 用户手改），
 * 写口只守得住一路 —— 所以每一种坏法都要有一个明确的 error，不许 fail-soft
 * 成空表。空表和"读不懂"混成一件事，就是那条最贵的教训的翻版。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseStateTable, applyVars, sanitizeValue, validateKey, renderRows,
  findStateTable, readStateVars, STATE_TABLE_TAG, VALUE_MAX,
} from './state-table.js';
import { renderChalk, CHALK_DIR } from './chalk.js';

const T = (...rows) => ['| 键 | 值 |', '| --- | --- |', ...rows].join('\n');

describe('parseStateTable', () => {
  it('认得出表，键值成对', () => {
    const r = parseStateTable(`## 状态\n\n${T('| 好感度_苏绵 | 3 |', '| 时间 | 戌时 |')}\n\n下面是正文。`);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ key: '好感度_苏绵', value: '3' }, { key: '时间', value: '戌时' }]);
  });

  it('⭐ 围栏里的表不算表 —— 判据落在行号上，不能按行的内容比对', () => {
    // 第一版就是拿 stripFences 之后的文本做 Set 比对，而围栏里那行跟真表头**逐字相同**，
    // 于是一张表被数成两张、当场拒绝写入。同样的坑：判据别建在"内容看起来一样"上。
    const body = `${T('| a | 1 |')}\n\n\`\`\`nd:controls\n| 键 | 值 |\n- [A] x -> y\n\`\`\``;
    const r = parseStateTable(body);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ key: 'a', value: '1' }]);
  });

  it('⛔ 没有表 / 两张表 / 重复键 / 缺分隔行 —— 四种坏法各有各的话，都不 fail-soft', () => {
    expect(parseStateTable('什么都没有').error).toBe('no-table');
    expect(parseStateTable(`${T('| a | 1 |')}\n\n${T('| b | 2 |')}`).error).toMatch(/有 2 张/);
    expect(parseStateTable(T('| a | 1 |', '| a | 2 |')).error).toMatch(/「a」出现了两次/);
    expect(parseStateTable('| 键 | 值 |\n| a | 1 |').error).toMatch(/缺分隔行/);
  });

  it('表后面的正文不被吃掉（表到第一个非 | 行为止）', () => {
    const r = parseStateTable(`${T('| a | 1 |')}\n后面这句不是表。\n| 这行也不算 |`);
    expect(r.rows).toEqual([{ key: 'a', value: '1' }]);
  });
});

describe('applyVars', () => {
  it('改一格只动那一格，别的字节不变', () => {
    const body = `# 状态板\n\n${T('| a | 1 |', '| b | 2 |')}\n\n一段说明文字。\n`;
    const r = applyVars(body, { a: 9 });
    expect(r.changed).toEqual([{ key: 'a', from: '1', to: '9' }]);
    expect(r.body).toContain('| a | 9 |');
    expect(r.body).toContain('| b | 2 |');
    expect(r.body).toContain('一段说明文字。');
    expect(r.body.startsWith('# 状态板')).toBe(true);
  });

  it('新键追加在表尾，不覆盖既有行', () => {
    const r = applyVars(T('| a | 1 |'), { b: '新的' });
    expect(r.added).toEqual([{ key: 'b', value: '新的' }]);
    expect(r.rows.map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('值一样时不记成 changed（免得每轮状态块虚报变化）', () => {
    expect(applyVars(T('| a | 1 |'), { a: '1' }).changed).toEqual([]);
  });

  it('⛔ 表坏了就抛，绝不"尽力写" —— 带 code 让调用方分辨两种坏法', () => {
    expect(() => applyVars('没有表', { a: 1 })).toThrow(/没有「\| 键 \| 值 \|」表/);
    try { applyVars('没有表', { a: 1 }); } catch (e) { expect(e.code).toBe('NO_TABLE'); }
    try { applyVars(T('| a | 1 |', '| a | 2 |'), { a: 3 }); } catch (e) { expect(e.code).toBe('BAD_TABLE'); }
  });

  it('⛔ 坏键当场拒绝，不静默改写成能用的样子', () => {
    expect(() => applyVars(T('| a | 1 |'), { '-坏开头': 1 })).toThrow(/不能用的字符/);
    expect(() => applyVars(T('| a | 1 |'), { ['x'.repeat(60)]: 1 })).toThrow(/超过/);
  });

  it('⭐ 坏键的 code 跟坏表分开 —— 归因说错方向会让人去改对的东西', () => {
    // 真工具探针抓到的：原来两种失败共用一句「表看不懂」，于是传了个坏键的调用
    // 被指去修一张根本没坏的表。set-vars.js 按 code 分两句话，这里钉住那个分岔。
    try { applyVars(T('| a | 1 |'), { '-坏': 1 }); } catch (e) { expect(e.code).toBe('BAD_KEY'); }
    try { applyVars('没有表', { a: 1 }); } catch (e) { expect(e.code).toBe('NO_TABLE'); }
  });
});

describe('值清洗：钳住但要说', () => {
  it('竖线换斜杠、换行压空格、超长截断，三种都标 clamped', () => {
    expect(sanitizeValue('a|b').value).toBe('a/b');
    expect(sanitizeValue('a|b').clamped).toBe(true);
    expect(sanitizeValue('一\n二').value).toBe('一 二');
    expect(sanitizeValue('x'.repeat(VALUE_MAX + 10)).clamped).toBe(true);
    expect(sanitizeValue('正常值').clamped).toBe(false);
  });

  it('⭐ 一格里塞多行不会把表拆散（这类静默降级要堵在写口）', () => {
    const r = applyVars(T('| a | 1 |'), { a: '第一行\n| 假的 | 行 |' });
    expect(parseStateTable(r.body).ok).toBe(true);
    expect(parseStateTable(r.body).rows).toHaveLength(1);
  });

  it('validateKey / renderRows', () => {
    expect(validateKey('好感度_苏绵')).toBeNull();
    expect(validateKey('')).toMatch(/空/);
    expect(renderRows([{ key: 'a', value: '1' }])[0]).toBe('| 键 | 值 |');
  });
});

async function mkws(...notes) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-vars-'));
  await fs.mkdir(path.join(ws, CHALK_DIR), { recursive: true });
  for (const [name, body, tag] of notes) {
    await fs.writeFile(path.join(ws, CHALK_DIR, name), renderChalk({ body, by: 'agent', tag }));
  }
  return ws;
}

describe('在工作区里定位（tag，不是文件名）', () => {
  it('按 tag 找到唯一那条', async () => {
    const ws = await mkws(
      ['20260830-100000-别的.md', '一段叙事', '章节'],
      ['20260830-100100-状态.md', T('| a | 1 |'), STATE_TABLE_TAG],
    );
    const f = await findStateTable(ws);
    expect(f.found).toBe(true);
    expect(f.rel).toMatch(/20260830-100100/);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('⛔ 两条挂同一个 tag → 大声报，不猜该改哪条', async () => {
    const ws = await mkws(
      ['20260830-100000-甲.md', T('| a | 1 |'), STATE_TABLE_TAG],
      ['20260830-100100-乙.md', T('| b | 2 |'), STATE_TABLE_TAG],
    );
    const f = await findStateTable(ws);
    expect(f.found).toBe(false);
    expect(f.reason).toBe('multiple');
    expect((await readStateVars(ws)).state).toBe('broken');
    await fs.rm(ws, { recursive: true, force: true });
  });
});

describe('⭐ 读侧报警：「没有」和「读不懂」是两回事', () => {
  it('没有表 → none（安静）；表被改坏 → broken（出声，并指出是哪个文件）', async () => {
    const empty = await mkws(['20260830-100000-叙事.md', '一段话', '章节']);
    expect((await readStateVars(empty)).state).toBe('none');
    await fs.rm(empty, { recursive: true, force: true });

    // 判据先验一遍：给它一个它**必须**报的东西 —— 手动把表改成重复键
    const broken = await mkws(['20260830-100100-状态.md', T('| a | 1 |', '| a | 2 |'), STATE_TABLE_TAG]);
    const st = await readStateVars(broken);
    expect(st.state).toBe('broken');
    expect(st.why).toMatch(/出现了两次/);
    expect(st.rel).toMatch(/20260830-100100/);
    await fs.rm(broken, { recursive: true, force: true });
  });

  it('挂着 tag 但正文里没表 → 也算 broken（tag 是承诺，没兑现就该说）', async () => {
    const ws = await mkws(['20260830-100000-状态.md', '我把表删了', STATE_TABLE_TAG]);
    const st = await readStateVars(ws);
    expect(st.state).toBe('broken');
    expect(st.why).toMatch(/找不到/);
    await fs.rm(ws, { recursive: true, force: true });
  });
});
