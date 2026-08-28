/**
 * stage-broadcast 测试 —— 钉转发机的分发语义。
 *
 * 这台机器错了不报错，只会退回 08-28 事故的原样：GM 叙完事角色永远接不上，
 * 或者反过来全场被一条板书炸醒。所以把四种模式 + 级联阻尼逐一走出来断言，
 * 唤醒断言直接打在挂着的 waitFor promise 上（那才是「即刻送达」的真判据，
 * 不是队列深度 —— feedback-verify-the-instrument）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../projects/store.js', () => ({ getProject: vi.fn() }));
import { getProject } from '../../projects/store.js';

import { broadcastStageNote, stageNoteMessage, MAX_HOP, _resetStage } from './stage-broadcast.js';
import { deliver, waitFor, drain, queueDepth, isWaiting, touchInbox, _resetInboxes } from './inbox.js';
import { setScene, getScene, _resetScenes } from './scene.js';

const P = 'proj_stage_test0';
const A = 'rp-a'; const B = 'rp-b'; const C = 'rp-c';
const rpProject = () => getProject.mockReturnValue({ mode: 'rp' });

/** 挂一个角色上 await（真 waiter），返回它的 promise —— 唤醒与否看它 resolve 成什么 */
const hang = (slug, ms = 200) => waitFor(P, slug, ms);

beforeEach(() => { _resetStage(); _resetInboxes(); _resetScenes(); vi.resetAllMocks(); rpProject(); });

describe('broadcastStageNote —— 模式分发', () => {
  it('design 项目整机不转（返回 null，谁的收件箱都不动）', async () => {
    getProject.mockReturnValue({ mode: 'design' });
    touchInbox(P, A);
    expect(broadcastStageNote(P, { rel: 'notes/板书/x.md', by: 'agent', text: '旁白' })).toBeNull();
    expect(queueDepth(P, A)).toBe(0);
  });

  it('free（含没设过场）：旁白落板即刻唤醒挂着的在场角色，作者与 exclude 不投', async () => {
    touchInbox(P, A); touchInbox(P, B); touchInbox(P, C);
    const pa = hang(A);
    const st = broadcastStageNote(P, { rel: 'notes/板书/n1.md', by: 'agent', text: '公会大厅飘着麦酒味', exclude: [C] });
    expect(st.mode).toBe('free');
    expect(st.line).toMatch(/rp-a（在等，已送达）/);
    expect(st.line).toMatch(/rp-b（没在等，进了队列）/);
    expect(st.line).not.toMatch(/rp-c/);
    const got = await pa;                       // waiter 当场 resolve = 真·即刻送达
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('stage');
    expect(got[0].text).toContain('notes/板书/n1.md');
    expect(got[0].text).toContain('旁白');
    expect(queueDepth(P, B)).toBe(1);
    expect(queueDepth(P, C)).toBe(0);
  });

  it('角色开口顺手进名册（touchInbox），下一条旁白就能找到它', () => {
    // 名册全空时角色 B 说话：没人可投（A 还不认识），但 B 从此在场
    broadcastStageNote(P, { rel: 'n0', by: B, text: 'B 的第一句' });
    const st = broadcastStageNote(P, { rel: 'n1', by: 'agent', text: '旁白' });
    expect(st.line).toMatch(/rp-b/);
  });

  it('solo：order 排了就只投 order 里的人', () => {
    touchInbox(P, A); touchInbox(P, B);
    setScene(P, { mode: 'solo', order: [A] });
    const st = broadcastStageNote(P, { rel: 'n1', by: 'agent', text: '旁白' });
    expect(st.line).toMatch(/rp-a/);
    expect(st.line).not.toMatch(/rp-b/);
    expect(queueDepth(P, B)).toBe(0);
  });

  it('directed：机器不插手', () => {
    touchInbox(P, A);
    setScene(P, { mode: 'directed' });
    const st = broadcastStageNote(P, { rel: 'n1', by: 'agent', text: '旁白' });
    expect(st).toMatchObject({ mode: 'directed', line: null });
    expect(queueDepth(P, A)).toBe(0);
  });
});

describe('broadcastStageNote —— rounds 交给轮次机', () => {
  it('旁白落板 = 从 order[0] 开一轮（cue 带板书指针）；轮内旁白不重开', async () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    const pa = hang(A);
    const st = broadcastStageNote(P, { rel: 'notes/板书/n1.md', by: 'agent', text: '旁白' });
    expect(st.scene.turnSlug).toBe(A);
    expect(st.line).toMatch(/开了新一轮/);
    const got = await pa;
    expect(got[0].from).toBe('scene');
    expect(got[0].text).toContain('notes/板书/n1.md');
    // 轮次进行中，GM 再插一条场记：不重开、不再投
    const st2 = broadcastStageNote(P, { rel: 'n2', by: 'agent', text: '场记' });
    expect(st2.scene).toBeNull();
    expect(queueDepth(P, A)).toBe(0);
  });

  it('角色发言不广播也不开轮（推进归 onRoleWait，广播会让全桌抢话）', () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    const st = broadcastStageNote(P, { rel: 'n1', by: A, text: 'A 的台词' });
    expect(st).toMatchObject({ mode: 'rounds', line: null, scene: null });
    expect(queueDepth(P, B)).toBe(0);
  });
});

describe('broadcastStageNote —— 级联阻尼', () => {
  it(`回声链深超过 ${MAX_HOP} 只进队列不唤醒；GM/用户一开口链深清零`, async () => {
    touchInbox(P, A); touchInbox(P, B);
    // 拍源（hop0）→ A 接（A 的发言 hop1）→ B 接（hop2）→ A 再接（hop3 = 超）
    broadcastStageNote(P, { rel: 'n0', by: 'agent', text: '旁白' });
    drain(P, A); drain(P, B);
    broadcastStageNote(P, { rel: 'n1', by: A, text: 'A1' });   // B 收到 hop1
    broadcastStageNote(P, { rel: 'n2', by: B, text: 'B1' });   // A 收到 hop2
    drain(P, A); drain(P, B);
    const pb = hang(B, 120);
    const st = broadcastStageNote(P, { rel: 'n3', by: A, text: 'A2' });  // hop3 → 不唤醒
    expect(st.line).toMatch(/回声太深/);
    expect(await pb).toHaveLength(0);            // waiter 超时空手 —— 没被这条炸醒
    expect(queueDepth(P, B)).toBe(1);            // 但话在队列里，下次自己醒来能看到
    // 用户落痕 = 新的一拍，链深归零，又能唤醒了（先清掉积压再挂，不然 waitFor 带积压立即返回）
    drain(P, B);
    const pb2 = hang(B, 500);
    broadcastStageNote(P, { rel: 'n4', by: 'user', text: '用户的话' });
    expect((await pb2).some((m) => m.text.includes('n4'))).toBe(true);
  });
});

describe('stageNoteMessage', () => {
  it('三种作者三种称呼，摘要与指针都在', () => {
    expect(stageNoteMessage({ rel: 'p.md', by: 'agent', excerpt: 'x' })).toContain('旁白');
    expect(stageNoteMessage({ rel: 'p.md', by: 'user', excerpt: 'x' })).toContain('用户');
    expect(stageNoteMessage({ rel: 'p.md', by: 'rp-a', excerpt: 'x' })).toContain('「rp-a」');
    const m = stageNoteMessage({ rel: 'notes/板书/z.md', by: 'agent', excerpt: '摘一句' });
    expect(m).toContain('notes/板书/z.md');
    expect(m).toContain('摘一句');
    expect(m).toContain('不是点名');
  });
});

describe('deliver wake:false（阻尼档的底座）', () => {
  it('只排队不唤醒，挂着的 waiter 原地不动', async () => {
    const pa = hang(A, 120);
    const r = deliver(P, A, { text: 'quiet', from: 'stage' }, { wake: false });
    expect(r.delivered).toBe('queued');
    expect(isWaiting(P, A)).toBe(true);
    expect(await pa).toHaveLength(0);
    expect(drain(P, A)).toHaveLength(1);
  });
});

describe('场况档（08-28 文风节食：facts 投干货不投散文）', () => {
  it('GM 填了 facts：广播正文是场况条目 + 防染提示，原文只留指针', async () => {
    touchInbox(P, A);
    const pa = hang(A);
    broadcastStageNote(P, { rel: 'notes/板书/n1.md', by: 'agent', text: '她端着垃圾袋迎面走来，厚底鞋哒哒响……（三百字散文）', facts: ['江篱端着垃圾袋出门，在走廊撞见不语', '她主动打了招呼，说"好巧"'] });
    const got = await pa;
    expect(got[0].text).toContain('· 江篱端着垃圾袋出门');
    expect(got[0].text).toContain('· 她主动打了招呼');
    expect(got[0].text).toContain('另一支笔的文风');
    expect(got[0].text).toContain('notes/板书/n1.md');
    expect(got[0].text).not.toContain('厚底鞋');          // 散文一字不进收件箱
  });

  it('角色带 facts 不认（场况是旁白的档），照走散文摘要', async () => {
    touchInbox(P, A); touchInbox(P, B);
    const pb = hang(B);
    broadcastStageNote(P, { rel: 'n1', by: A, text: '我的台词', facts: ['伪装成场况'] });
    const got = await pb;
    expect(got[0].text).toContain('「我的台词」');
    expect(got[0].text).not.toContain('伪装成场况');
  });

  it('rounds：旁白开轮的 cue 也带场况', async () => {
    setScene(P, { mode: 'rounds', order: [A, B] });
    const pa = hang(A);
    broadcastStageNote(P, { rel: 'notes/板书/n1.md', by: 'agent', text: '散文', facts: ['门开了', '没人拿垃圾袋'] });
    const got = await pa;
    expect(got[0].from).toBe('scene');
    expect(got[0].text).toContain('轮到你了');
    expect(got[0].text).toContain('· 门开了');
    expect(got[0].text).toContain('要引用原句才去读');
  });

  it('不填 facts：回落到散文摘要 + 读它（昨天的行为一字不变）', async () => {
    touchInbox(P, A);
    const pa = hang(A);
    broadcastStageNote(P, { rel: 'n1', by: 'agent', text: '旁白散文' });
    expect((await pa)[0].text).toContain('写了「旁白散文」');
  });
});
