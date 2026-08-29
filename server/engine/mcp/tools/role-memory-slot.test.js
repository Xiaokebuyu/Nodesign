// 演员位调 jot_memory 时的话术（2026-08-28 真会话实录）
//
// proj_mtdc0v6e：角色 19:59 上场，20:10 调 jot_memory **连吃两次**
// 「只有常驻角色有记忆文件。你是主控」——它明明是角色，只是别名桥还没把
// agentId 解析成实例名。这句话把它引向 记忆/ + Write/Edit，而角色没有 Write 权限，
// 那是一条走不通的路。20:10 GM 一发 SendMessage 别名补上，20:21 同一个工具就成了。
//
// 判据钉的是：**演员位这一档必须说实话，并且不能把它当成主控**。
import { describe, it, expect, beforeEach } from 'vitest';
import { makeJotMemoryTool } from './role-memory.js';
import { noteToolCaller, noteAgentName, _resetActorTrail } from '../../agent/actor-trail.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-jot-'));
const call = (tid) => makeJotMemoryTool({ workspaceRoot: ws })
  .handler({ text: '记一笔' }, { _meta: { 'claudecode/toolUseId': tid } });
const text = (r) => r.content[0].text;

beforeEach(() => _resetActorTrail());

describe('jot_memory 的身份分档', () => {
  it('⭐ 演员位（实例名还没解析出来）：不许说「你是主控」', async () => {
    noteToolCaller('t1', { agentId: 'a1', agentType: 'rp-actor' });
    const r = await call('t1');
    expect(r.isError).toBe(true);
    expect(text(r), '它是角色，不是主控 —— 说反了它会去用没有的 Write 权限').not.toContain('你是主控');
    expect(text(r), '要给一条走得通的出路').toMatch(/SendMessage|下一拍/);
  });

  it('真·主控照旧被拒，指向 记忆/ 目录', async () => {
    const r = await call('nobody');   // 没盖过章 = 主 agent
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('你是主控');
  });

  it('⭐ 别名补上之后，同一枚章解析成实例名 → 记得进去', async () => {
    noteToolCaller('t2', { agentId: 'a2', agentType: 'rp-actor' });
    noteAgentName('a2', 'rp-kanade');            // SendMessage/派发结果教会的
    const r = await call('t2');
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('角色/rp-kanade/记忆.md');
    expect(fs.readFileSync(path.join(ws, '角色', 'rp-kanade', '记忆.md'), 'utf8')).toContain('记一笔');
  });
});
