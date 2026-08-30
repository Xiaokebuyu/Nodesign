import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离（agent-shared 顶层 import 链会碰 store）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-batchstream-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { latestBatchField, pickSpot } = await import('./agent-shared.js');

/** 板书直播的批内嵌套抽取（08-25「流式名存实亡」案）：
 *  skill 教一章一次 board_batch，正文在 actions[].input.text —— 顶层抽取器抓不到 */
describe('latestBatchField', () => {
  it('取最新一条 write_on_board 的 text（半截 JSON 也照抽）', () => {
    const obj = { actions: [
      { name: 'write_on_board', input: { text: '第一章全文' } },
      { name: 'edit_board', input: { ops: [] } },
      { name: 'write_on_board', input: { text: '选项板正在流……' } },
    ] };
    // input 整份也带回来（08-29 刀 C：位置字段要从同一条动作的 input 里抽）
    expect(latestBatchField(obj, 'write_on_board', 'text'))
      .toEqual({ idx: 2, text: '选项板正在流……', input: { text: '选项板正在流……' } });
  });
  it('带 mcp 前缀的名字也认；没有命中返回 null', () => {
    expect(latestBatchField({ actions: [{ name: 'mcp__nodesign__write_on_board', input: { text: 'x' } }] }, 'write_on_board', 'text'))
      .toEqual({ idx: 0, text: 'x', input: { text: 'x' } });
    expect(latestBatchField({ actions: [{ name: 'read_board', input: {} }] }, 'write_on_board', 'text')).toBeNull();
    expect(latestBatchField({}, 'write_on_board', 'text')).toBeNull();
  });
});

/**
 * 位置字段抽取（2026-08-29 占位契约刀 C）。
 *
 * 最要命的一条在第二发：容错解析会把**没写完的数字**当成合法数字交出来 ——
 * 模型正在写 `{"x": 1234`，解析器给的是 `{x:12}`，类型对、值合法、看不出破绽，
 * 拿它当坐标就是把框立在错的地方。所以判据不是"at 在不在"，是**目标字段已经
 * 出现**（说明排在它前面的 at 已经闭合）+ x/y 都是有限数。
 */
describe('pickSpot', () => {
  const FIELDS = ['at', 'sheet', 'width', 'near', 'side'];

  it('⭐ at 两个坐标齐了才收', () => {
    expect(pickSpot({ at: { x: 100, y: 240 } }, FIELDS)).toEqual({ at: { x: 100, y: 240 } });
  });

  it('⭐ at 只写了一半 → 不收（宁可没有框，也不要错位置的框）', () => {
    expect(pickSpot({ at: { x: 100 } }, FIELDS)).toBeNull();
    expect(pickSpot({ at: {} }, FIELDS)).toBeNull();
    expect(pickSpot({ at: 'p1' }, FIELDS)).toBeNull();
  });

  it('纸名 / 宽度 / 锚点都带上（框的宽和落点都要它们）', () => {
    expect(pickSpot({ at: { x: 1, y: 2 }, sheet: 'p2', width: 18, near: 'deck:a.html', side: 'below' }, FIELDS))
      .toEqual({ at: { x: 1, y: 2 }, sheet: 'p2', width: 18, near: 'deck:a.html', side: 'below' });
  });

  it('一个位置字段都没有（agent 没指定位置，顺排）→ null', () => {
    expect(pickSpot({ text: '正文' }, FIELDS)).toBeNull();
    expect(pickSpot({}, FIELDS)).toBeNull();
    expect(pickSpot(null, FIELDS)).toBeNull();
  });

  it('null/undefined 的字段跳过，不写进框', () => {
    expect(pickSpot({ sheet: 'p1', near: null, side: undefined }, FIELDS)).toEqual({ sheet: 'p1' });
  });
});
