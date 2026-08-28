/**
 * set_scene 的 mode 闸（2026-08-28 归一）—— 钉「编排机械 rp-only」的口径。
 *
 * 病史：stage-broadcast 判 mode==='rp' 而 scene/roles 不判，design 项目手动
 * cast_role + set_scene(rounds) 会进「半条腿」状态（say 能开轮、广播整机不转），
 * 静默烂掉。归一后 set_scene 是机械的正门 —— design 项目在门口就被说清楚。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../projects/store.js', () => ({ getProject: vi.fn() }));
import { getProject } from '../../../projects/store.js';

import { makeSetSceneTool } from './scene-tools.js';
import { _resetScenes, getScene } from '../../agent/scene.js';

const P = 'proj_scene_gate0';
const t = makeSetSceneTool({ projectId: P });
// 不 stamp = byOf 落 'agent'（主控）——这里专测 mode 闸，身份闸有 cue 那份测试守
const call = (args) => t.handler(args, { _meta: {} });

beforeEach(() => { _resetScenes(); vi.resetAllMocks(); });

describe('set_scene —— 编排机械 rp-only', () => {
  it('design 项目：拒绝并指路（不落下半条腿的场声明）', async () => {
    getProject.mockReturnValue({ mode: 'design' });
    const r = await call({ mode: 'rounds', order: ['rp-a', 'rp-b'] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('设计模式');
    expect(getScene(P)).toBeNull();          // 场没被建出来
  });

  it('rp 项目：照常设场', async () => {
    getProject.mockReturnValue({ mode: 'rp' });
    const r = await call({ mode: 'rounds', order: ['rp-a', 'rp-b'] });
    expect(r.isError).toBeUndefined();
    expect(getScene(P)).toMatchObject({ mode: 'rounds' });
  });
});
