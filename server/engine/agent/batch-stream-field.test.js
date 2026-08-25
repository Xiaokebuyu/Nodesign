import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 隔离（agent-shared 顶层 import 链会碰 store）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-batchstream-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { latestBatchField } = await import('./agent-shared.js');

/** 板书直播的批内嵌套抽取（08-25「流式名存实亡」案）：
 *  skill 教一章一次 board_batch，正文在 actions[].input.text —— 顶层抽取器抓不到 */
describe('latestBatchField', () => {
  it('取最新一条 write_on_board 的 text（半截 JSON 也照抽）', () => {
    const obj = { actions: [
      { name: 'write_on_board', input: { text: '第一章全文' } },
      { name: 'edit_board', input: { ops: [] } },
      { name: 'write_on_board', input: { text: '选项板正在流……' } },
    ] };
    expect(latestBatchField(obj, 'write_on_board', 'text')).toEqual({ idx: 2, text: '选项板正在流……' });
  });
  it('带 mcp 前缀的名字也认；没有命中返回 null', () => {
    expect(latestBatchField({ actions: [{ name: 'mcp__nodesign__write_on_board', input: { text: 'x' } }] }, 'write_on_board', 'text')).toEqual({ idx: 0, text: 'x' });
    expect(latestBatchField({ actions: [{ name: 'read_board', input: {} }] }, 'write_on_board', 'text')).toBeNull();
    expect(latestBatchField({}, 'write_on_board', 'text')).toBeNull();
  });
});
