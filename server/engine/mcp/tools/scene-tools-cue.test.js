/**
 * cue_role 测试（2026-08-28 转发机）—— 钉三件事：
 *   ① GM 点名走 deliver，挂着的角色**当场**拿到（这正是 SendMessage 做不到的那半）
 *   ② 投递结果如实分档（在等/队列/名字没进过场）—— 把队列伪装成送达，GM 就会
 *      以为催过了，退回 08-28 事故
 *   ③ 角色不许拿它点别人（台上自组织走戏内/SendMessage，场务归 GM）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeCueRoleTool } from './scene-tools.js';
import { makePreToolUseActorStamp } from '../../agent/hooks/pre-defaults.js';
import { _resetActorTrail } from '../../agent/actor-trail.js';
import { waitFor, touchInbox, queueDepth, _resetInboxes } from '../../agent/inbox.js';

const P = 'proj_cue_test0';
const t = makeCueRoleTool({ projectId: P });
const stamp = makePreToolUseActorStamp();
let n = 0;

const callAs = async (agentType, args) => {
  _resetActorTrail();
  const toolUseId = `toolu_cue_${n += 1}`;
  if (agentType) await stamp({ agent_id: 'a1', agent_type: agentType }, toolUseId);
  return t.handler(args, { _meta: { 'claudecode/toolUseId': toolUseId } });
};

beforeEach(() => { _resetInboxes(); });

describe('cue_role', () => {
  it('挂着的当场送到，没挂的进队列，名字没进过场的给警示 —— 一次调用点一群', async () => {
    const pa = waitFor(P, 'rp-a', 500);          // rp-a 挂着等
    touchInbox(P, 'rp-b');                        // rp-b 在场但没在等
    const r = await callAs(null, { to: ['rp-a', 'rp-b', 'rp-ghost'], text: '你来一句' });
    const txt = r.content[0].text;
    expect(txt).toMatch(/rp-a：正挂着等，已当场送到/);
    expect(txt).toMatch(/rp-b：进了队列/);
    expect(txt).toMatch(/SendMessage 召回/);
    expect(txt).toMatch(/rp-ghost：进了队列.*没进过场/);
    const got = await pa;
    expect(got[0]).toMatchObject({ from: 'gm', text: '你来一句' });
    expect(queueDepth(P, 'rp-b')).toBe(1);
  });

  it('slug 长得不像角色：拒投并说明，不污染队列键空间', async () => {
    const r = await callAs(null, { to: ['珂雪'], text: 'x' });
    expect(r.content[0].text).toMatch(/✗ 珂雪：不是角色 slug/);
    expect(queueDepth(P, '珂雪')).toBe(0);
  });

  it('角色调它被拒（场务归 GM）', async () => {
    const r = await callAs('rp-a', { to: ['rp-b'], text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('主控的场务工具');
    expect(queueDepth(P, 'rp-b')).toBe(0);
  });
});
