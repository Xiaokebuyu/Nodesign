import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStageTools } from './tools.js';
import { stageIllustrate, ILLUST_GAP_BEATS } from './mechanics.js';
import { frozenHash } from './prompt.js';
import { writePlayConfig } from './play.js';

/** 演出进程配图：玩家允许才有工具；闸在 stageIllustrate 里（没允许 / 太短 / 太密 / portrait 要 who）；开关进冻结指纹 */
const names = (server) => Object.keys(server.instance?._registeredTools || server._registeredTools || {});

describe('illustrate 工具', () => {
  it('玩家允许配图才注册；关着时演出进程看不见它', () => {
    const base = { workspaceRoot: '/tmp/x', playRoot: '故事' };
    expect(names(createStageTools({ ...base, images: false }))).not.toContain('illustrate');
    expect(names(createStageTools({ ...base, images: true }))).toContain('illustrate');
  });
  it('配图开关进冻结指纹：翻了开关下一句话进程重开', () => {
    expect(frozenHash({ images: { allow: true } })).not.toBe(frozenHash({ images: { allow: false } }));
    expect(frozenHash({})).toBe(frozenHash({ images: { allow: false } }));
  });
});

describe('stageIllustrate 的闸', () => {
  async function rt(cfg) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ill-'));
    await writePlayConfig(dir, { title: 't', ...cfg });
    return { playAbs: dir, wsRoot: path.dirname(dir), root: path.basename(dir), pid: 'p', scenesRel: '场景/scenes.jsonl', state: { 拍数: 5 }, broadcast() {}, lastScene: '教室 · 早上' };
  }
  it('没允许 → error；prompt 太短 → error；portrait 没 who → error', async () => {
    expect((await stageIllustrate(await rt({}), { prompt: 'a long enough prompt here' })).error).toMatch(/没有允许/);
    const r = await rt({ images: { allow: true }, cast: [{ name: '晴可', card: '故事/角色/晴可/角色卡.md' }] });
    expect((await stageIllustrate(r, { prompt: 'short' })).error).toMatch(/太短/);
    expect((await stageIllustrate(r, { prompt: 'a long enough prompt here', kind: 'portrait' })).error).toMatch(/who/);
    expect((await stageIllustrate(r, { prompt: 'a long enough prompt here', kind: 'portrait', who: '不在场' })).error).toMatch(/在场的人/);
  });
  it('两张 moment 之间至少隔三段（不真生图：第一次先把 lastIllustBeat 记上再看第二次被拦）', async () => {
    const r = await rt({ images: { allow: true } });
    r.lastIllustBeat = r.state['拍数'] - 1;
    expect((await stageIllustrate(r, { prompt: 'a long enough prompt here' })).error).toMatch(new RegExp(`至少隔 ${ILLUST_GAP_BEATS} 段`));
    r.lastIllustBeat = undefined; r.illustBusy = true;
    expect((await stageIllustrate(r, { prompt: 'a long enough prompt here' })).error).toMatch(/还在画/);
  });
});
