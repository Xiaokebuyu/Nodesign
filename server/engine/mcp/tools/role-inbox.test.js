// await_user 的散场闸（2026-08-26，用户拍板 N=2）
//
// 为什么这几条要专门钉：这段返回值是**角色唯一会读到的行为指令**。
// 它决定角色是接着挂还是收场，而收场与否直接决定
//   ① 会话会不会被无限续命（角色循环挂着 = 每轮都刷新 lastActivityAt）
//   ② 用户的话还够不够得到它（收了回合服务端就投不进去了）
// 措辞错一次，症状是「用户关了标签页，进程还在空转一整夜」——没有任何报错。
//
// ⚠️ 断的是 emptyWaitMessage 这个纯函数，不是走真 handler：工具把等待时长
// 钳到最少 30 秒（WAIT_MIN_S），真等一遍每条用例要 30s，测试会变成没人肯跑的那种。
import { describe, it, expect, beforeEach } from 'vitest';
import { emptyWaitMessage, makeAwaitUserTool, makeCheckInboxTool } from './role-inbox.js';
import { waitFor, deliver, emptyStreakOf, _resetInboxes } from '../../agent/inbox.js';

const P = 'proj_inbox_wording';
beforeEach(() => { _resetInboxes(); });

describe('还没到散场次数：只给一条路——接着挂', () => {
  it('⛔ 不把「结束回合」写成平级选项（那是唯一会让角色失联的选择）', () => {
    const txt = emptyWaitMessage('rp-moli', 300, 1);
    expect(txt).toContain('别结束回合');
    expect(txt).toContain('await_user');        // 明确指回来接着挂
    expect(txt).toMatch(/1\/2/);                // 让它知道自己数到几了
    expect(txt).not.toContain('散场');
  });

  it('⭐ 推进要有理由 —— 不然它会为了填满超时硬编剧情', () => {
    expect(emptyWaitMessage('rp-moli', 300, 1)).toContain('有理由才写');
  });
});

describe('到了散场次数：劝退，并交代怎么被叫回来', () => {
  it('说清楚记忆不丢 + 主控会被告知 + 点名 SendMessage 的收件人', () => {
    const txt = emptyWaitMessage('rp-moli', 300, 2);
    expect(txt).toContain('散场');
    expect(txt).toContain('结束回合');
    expect(txt).toContain('SendMessage');
    expect(txt).toContain('rp-moli');           // 收件人名要出现在话术里
    expect(txt).toContain('记忆不会丢');
  });

  it('超过限额也还是劝退（不是只在等于 2 的那一次）', () => {
    expect(emptyWaitMessage('rp-moli', 300, 5)).toContain('散场');
  });
});

describe('⭐ 有人说话就重新计数（不然演到一半会被劝退）', () => {
  it('中间收到一句，计数归零', async () => {
    await waitFor(P, 'rp-moli', 1);
    expect(emptyStreakOf(P, 'rp-moli')).toBe(1);

    const w = waitFor(P, 'rp-moli', 60_000);
    await new Promise((r) => { setTimeout(r, 0); });
    deliver(P, 'rp-moli', { text: '我在听' });
    await w;

    expect(emptyStreakOf(P, 'rp-moli')).toBe(0);
    expect(emptyWaitMessage('rp-moli', 300, emptyStreakOf(P, 'rp-moli') + 1)).toMatch(/1\/2/);
  });
});

describe('守卫没变松', () => {
  it('不是常驻角色调 await_user 仍然被挡回去', async () => {
    const t = makeAwaitUserTool({ projectId: P });
    const r = await t.handler({ seconds: 30 }, { _meta: { 'claudecode/toolUseId': 'tu-nobody' } });
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => c.text).join('')).toContain('只有常驻角色');
  });

  it('check_inbox 同样只认常驻角色', async () => {
    const t = makeCheckInboxTool({ projectId: P });
    const r = await t.handler({}, { _meta: { 'claudecode/toolUseId': 'tu-nobody-2' } });
    expect(r.isError).toBe(true);
  });
});
