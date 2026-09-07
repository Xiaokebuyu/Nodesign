/**
 * 闸真的接在 sayToStage 上了吗（09-07）。
 *
 * moderate.test.js 测的是判定本身；那份全绿也证明不了这道闸**接**在路上 ——
 * 接错地方、条件写反，单测照样绿（判据扫不到的地方等于没有判据）。
 * 所以这里走真的 sayToStage：真工作区、真戏文件夹、真账号，只把分类器换成注入的。
 *
 * 断言的是「拦下 = 零成本」这条纪律本身：话不进 scenes.jsonl、run 一条都不建。
 * 放行那一半不在这里测 —— 它下一步就要 startStage 起一个 SDK 子进程（300-500MB）。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-saygate-'));
process.env.PROJECTS_DATA_DIR = DATA;
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-not-used';
delete process.env.NODESIGN_MODERATION;

const db = (await import('../runs/store.js')).default;
const { sayToStage } = await import('./manager.js');

const PID = 'proj_saygate_t1';
const PLAY = '四方世界';
const PLAY_ABS = path.join(DATA, PID, 'shared', PLAY);

// basic 档 + 订阅行 = strict（tier.js 的默认表），这样闸才会真的去问分类器
const USER = 'u_' + crypto.randomBytes(4).toString('hex');
const BROKE = 'u_' + crypto.randomBytes(4).toString('hex');   // 日限 0 = 额度已用完

beforeAll(() => {
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, 0)')
    .run(USER, USER, 'x', 'user');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled, daily_cost_limit_usd) VALUES (?, ?, ?, ?, 0, 0)')
    .run(BROKE, BROKE, 'x', 'user');
  fs.mkdirSync(PLAY_ABS, { recursive: true });
  fs.writeFileSync(path.join(PLAY_ABS, '戏.json'), JSON.stringify({ title: PLAY, cast: [{ name: '柜台小姐' }], model: 'claude-sonnet-5[1m]' }), 'utf8');
});

const scenesFile = path.join(PLAY_ABS, '场景', 'main.jsonl');
const runsOf = () => db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get(PID).n;

describe('外审闸接在演出的入口上', () => {
  it('拦下：抛 451，话没落盘，run 一条都没建', async () => {
    const before = runsOf();
    const block = vi.fn(async () => ({ ok: false, category: 'violence', severity: 'normal', reason: '测试拦截' }));

    await expect(sayToStage(PID, PLAY, '一句会被拦下的话', { userId: USER, moderate: block }))
      .rejects.toMatchObject({ status: 451, code: 'MODERATION_BLOCKED' });

    expect(block).toHaveBeenCalledOnce();
    expect(block.mock.calls[0][0]).toBe('一句会被拦下的话');   // 交过去的是玩家那句，不是别的
    expect(fs.existsSync(scenesFile) ? fs.readFileSync(scenesFile, 'utf8') : '').not.toContain('一句会被拦下的话');
    expect(runsOf()).toBe(before);
  });

  it('机器合成的开场指令（row.by=system）不进这道闸', async () => {
    const block = vi.fn(async () => ({ ok: false, category: 'other', severity: 'normal' }));
    // 开场那条会一路走到起进程，这里只要证明它**没有**在闸上被拦：
    // 拦下抛的是 451，其它任何失败都说明它越过了闸。
    await expect(
      sayToStage(PID, PLAY, '开场指令正文', { userId: USER, row: { by: 'system', text: '故事开始了' }, moderate: block }),
    ).rejects.not.toMatchObject({ code: 'MODERATION_BLOCKED' });
    expect(block).not.toHaveBeenCalled();
  });

  it('额度用完：抛 429，话没落盘，run 一条都没建，分类器一次都没打', async () => {
    const before = runsOf();
    const block = vi.fn(async () => ({ ok: false, category: 'other', severity: 'normal' }));

    await expect(sayToStage(PID, PLAY, '额度用完之后的一句', { userId: BROKE, moderate: block }))
      .rejects.toMatchObject({ status: 429, code: 'QUOTA_EXCEEDED' });

    expect(block).not.toHaveBeenCalled();   // 先额度后外审
    expect(fs.existsSync(scenesFile) ? fs.readFileSync(scenesFile, 'utf8') : '').not.toContain('额度用完之后的一句');
    expect(runsOf()).toBe(before);
  });
});
