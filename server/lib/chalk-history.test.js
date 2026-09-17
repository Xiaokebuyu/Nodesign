/**
 * 板书树刀二：改写即存档（2026-09-17）。
 *
 * 钉三件：旧正文进伴生文件且最新在上（`head` 就是最近几版）、主文件大小不受影响
 * （agent 顺手 Read 一张卡零膨胀）、状态表不进历史（它表示此刻的值，每轮都变）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { archiveChalkBody, historyPathFor, historyCount, historyCounts } from './chalk-history.js';
import { rewriteChalkBody } from './chalk-rewrite.js';
import { renderChalk, parseChalk } from './chalk.js';
import { seatable } from '../engine/runs/board-seater.js';

let dir; let abs;
const write = (body, extra = {}) => fs.writeFile(abs, renderChalk({ body, by: 'agent', at: '2026-09-17T10:00:00.000Z', ...extra }), 'utf8');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-chalk-history-'));
  abs = path.join(dir, '配色讨论.md');
});

describe('archiveChalkBody', () => {
  it('旧正文进 .history 同名文件，最新在上，每版一个标题行', async () => {
    expect(await archiveChalkBody(abs, '第一版', { at: new Date('2026-09-17T10:20:00') })).toBe(1);
    expect(await archiveChalkBody(abs, '第二版', { at: new Date('2026-09-17T10:42:00') })).toBe(2);
    const raw = await fs.readFile(historyPathFor(abs), 'utf8');
    expect(raw.indexOf('第二版')).toBeLessThan(raw.indexOf('第一版'));
    expect(raw).toMatch(/^## 2026-09-17 10:42 · 被改写前/);
    expect(await historyCount(abs)).toBe(2);
  });

  it('附一行用户标注；空正文不记', async () => {
    await archiveChalkBody(abs, '正文', { note: '这里\n换个说法' });
    expect(await fs.readFile(historyPathFor(abs), 'utf8')).toContain('> 用户当时标注：这里 换个说法');
    expect(await archiveChalkBody(abs, '   ')).toBe(1);
  });

  it('historyCounts 一次问一批，没有历史的不进表', async () => {
    await archiveChalkBody(abs, 'x');
    const m = await historyCounts(dir, ['配色讨论.md', '没写过.md', '../越界.md']);
    expect(m.get('配色讨论.md')).toBe(1);
    expect(m.has('没写过.md')).toBe(false);
    expect(m.size).toBe(1);
  });
});

describe('rewriteChalkBody 改写即存档', () => {
  it('改写两次 → 历史两版，主文件只有当前正文（不膨胀）', async () => {
    await write('第一版正文');
    await rewriteChalkBody(abs, '第二版正文', { w: 432 });
    await rewriteChalkBody(abs, '第三版正文', { w: 432 });
    const cur = await fs.readFile(abs, 'utf8');
    expect(parseChalk(cur).body).toBe('第三版正文');
    expect(cur).not.toContain('第一版正文');
    expect(await historyCount(abs)).toBe(2);
    const hist = await fs.readFile(historyPathFor(abs), 'utf8');
    expect(hist.indexOf('第二版正文')).toBeLessThan(hist.indexOf('第一版正文'));
  });

  it('正文没变不记一版；archive:false 关掉存档', async () => {
    await write('原样');
    await rewriteChalkBody(abs, '原样', { w: 432 });
    expect(await historyCount(abs)).toBe(0);
    await rewriteChalkBody(abs, '换了', { w: 432 }, { archive: false });
    expect(await historyCount(abs)).toBe(0);
  });

  it('⭐ 状态表不进历史（它表示的是此刻的值，每轮都变会把历史撑成流水账）', async () => {
    await write('| 键 | 值 |\n| --- | --- |\n| 好感度 | 3 |', { tag: '状态表' });
    await rewriteChalkBody(abs, '| 键 | 值 |\n| --- | --- |\n| 好感度 | 4 |', { w: 432 });
    expect(await historyCount(abs)).toBe(0);
  });

  it('frontmatter 与用户拉出来的留白照旧保住（存档不许动这两条）', async () => {
    await write('原文', { anchor: 'site:x', tag: '配色' });
    const box = await rewriteChalkBody(abs, '新文', { w: 432, h: 900, sized: 'user' });
    const { chalk } = parseChalk(await fs.readFile(abs, 'utf8'));
    expect(chalk).toMatchObject({ anchor: 'site:x', tag: '配色', by: 'agent' });
    expect(box.h).toBe(900);
  });

  it('⭐ 历史文件不会变成画布上的卡（点开头的段整条不上墙）', () => {
    expect(seatable('notes/板书/配色讨论.md')).toBe(true);
    expect(seatable('notes/板书/.history/配色讨论.md')).toBe(false);
  });
});
