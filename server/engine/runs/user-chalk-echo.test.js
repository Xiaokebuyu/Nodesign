/**
 * 落痕（2026-08-27 solo 画布对话）：用户「说给角色」的话落成 by:'user' 的板书接进线。
 * 三件要钉：① 目标是板书 → reply_to 线程 + flow 线 + tag 继承；② 目标不是板书 →
 * annotates 线；③ 目标不在板上 → 无链落座（对话那半段不丢）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-echo-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { echoUserChalk } = await import('./user-chalk-echo.js');
const { readBoard, patchBoard } = await import('../../projects/board-store.js');
const { getSharedDir, ensureProjectWorkspace } = await import('../../projects/workspace.js');
const { parseChalk } = await import('../../lib/chalk.js');

const pid = 'proj_echo_test';
let sharedRoot;

beforeAll(async () => {
  await ensureProjectWorkspace(pid);
  sharedRoot = getSharedDir(pid);
});

describe('echoUserChalk', () => {
  it('⭐ 目标是角色的板书：reply_to 线程、flow 线、tag 继承、署名 user', async () => {
    const parent = 'notes/板书/20260827-100000-维拉的台词.md';
    await fs.mkdir(path.join(sharedRoot, 'notes/板书'), { recursive: true });
    await fs.writeFile(path.join(sharedRoot, parent), '---\nnd: chalk\nby: rp-vera\n---\n「客官要来点什么？」', 'utf8');
    await patchBoard(pid, { objects: { [parent]: { x: 1000, y: 1000, w: 300, h: 120, by: 'rp-vera', tag: '铁壶酒馆' } } });

    const { rel, seated } = await echoUserChalk(pid, { text: '来一杯麦酒，顺便打听个事。', anchor: parent });
    expect(seated).toBe(true);
    const raw = await fs.readFile(path.join(sharedRoot, rel), 'utf8');
    const { body, chalk } = parseChalk(raw);
    expect(body).toBe('来一杯麦酒，顺便打听个事。');
    expect(chalk.by).toBe('user');
    expect(chalk.replyTo).toBe(parent);
    expect(chalk.tag).toBe('铁壶酒馆');

    const board = await readBoard(pid);
    const e = board.objects[rel];
    expect(e.by).toBe('user');
    expect(e.tag).toBe('铁壶酒馆');
    expect(Number.isFinite(e.x)).toBe(true);
    // 领养同款接线：flow 线 parent → 落痕
    const edge = Object.values(board.bindings).find(b => b.from === parent && b.to === rel);
    expect(edge?.type).toBe('flow');
  });

  it('目标不是板书（产物卡）：annotates 线', async () => {
    await patchBoard(pid, { objects: { 'assets/画像.png': { x: 3000, y: 3000, w: 200, h: 160 } } });
    const { rel } = await echoUserChalk(pid, { text: '这幅画里的人是谁？', anchor: 'assets/画像.png' });
    const { chalk } = parseChalk(await fs.readFile(path.join(sharedRoot, rel), 'utf8'));
    expect(chalk.anchor).toBe('assets/画像.png');
    expect(chalk.replyTo).toBeNull();
    const board = await readBoard(pid);
    const edge = Object.values(board.bindings).find(b => b.from === rel && b.to === 'assets/画像.png');
    expect(edge?.type).toBe('annotates');
  });

  it('目标不在板上：无链落座，这半段对话不丢', async () => {
    const { rel, seated } = await echoUserChalk(pid, { text: '有人在吗？', anchor: 'notes/板书/不存在.md' });
    expect(seated).toBe(true);
    const { chalk } = parseChalk(await fs.readFile(path.join(sharedRoot, rel), 'utf8'));
    expect(chalk.by).toBe('user');
    expect(chalk.replyTo).toBeNull();
    expect(chalk.anchor).toBeNull();
  });
});

// （renderMessages 的落痕指针 2026-08-29 随收件箱一起退役：用户的话不再直投角色，
//  由主持人转交，落痕本身仍在 —— 上面那几条就是它的账。）
