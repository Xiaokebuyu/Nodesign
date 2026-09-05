// cast_role 的回归闸（2026-08-26 建；2026-08-28 演员位重构改版）
//
// 重构后 cast_role 不再写 agent 定义（那条路生产不可靠，见 cast-role.js 头注），
// 只写角色卡数据 + 登记表。测试跟着语义走：卡落在哪、登记表长什么样、
// 返回话术有没有把「现在就能派」和正确的演员位说清楚。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCastRoleTool, ID_RE } from './cast-role.js';
import { readCastRegistry, listRoleNames } from '../../agent/role-card.js';
import { ROLE_SLUG_RE } from '../../agent/cast.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cast-'));
const call = (args) => makeCastRoleTool({ workspaceRoot: ws, ctx: { emit() {} } }).handler(args, {});
const ok = { id: 'moli', name: '墨璃', duty: '负责讲故事', persona: '你是墨璃。MAGIC-WORD-7' };
const text = (r) => r.content[0].text;

describe('角色卡落盘（文件夹范式：角色/<名>/角色卡.md）', () => {
  it('卡进角色文件夹，persona 原样在正文里，标了 slug', async () => {
    const r = await call(ok);
    expect(r.isError).toBeUndefined();
    const card = fs.readFileSync(path.join(ws, '角色', '墨璃', '角色卡.md'), 'utf8');
    expect(card).toContain('# 墨璃');
    expect(card).toContain('rp-moli');
    expect(card).toContain('MAGIC-WORD-7');
  });

  it('登记表记下 slug → 展示名/卡路径，listRoleNames 读得到', async () => {
    await call(ok);
    const reg = await readCastRegistry(ws);
    expect(reg.roles['rp-moli']).toMatchObject({ name: '墨璃' });
    expect(reg.roles['rp-moli'].card).toContain('角色卡.md');
    const names = await listRoleNames(ws);
    expect(names.get('rp-moli')).toBe('墨璃');
  });

  it('⭐ 展示名里的路径分隔剥掉，文件夹坏不了路径', async () => {
    const r = await call({ ...ok, id: 'evil', name: '../.. /x' });
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(ws, '角色'))).toBe(true);
    // 没有逃出 角色/ 目录的文件
    expect(fs.existsSync(path.join(ws, 'x'))).toBe(false);
  });

  it('⭐ 展示名撞保留字：登记表原样存，出口（listRoleNames）洗成 slug', async () => {
    await call({ ...ok, id: 'sneak', name: '用户' });
    const names = await listRoleNames(ws);
    expect(names.get('rp-sneak')).toBe('rp-sneak');
  });
});

// 09-06 故事在显示器上演：返回文案只说卡进演出进程、玩家能改、别在对话里代演。
// ⭐ 这段话和工具 description 是同一条教义的两个读者 —— 断言两头都钉住，
//    免得再出现「改了 description 忘了返回文案」那种半边改（08-30 与 09-06 各栽一次）。
describe('返回话术：卡进演出进程 + 不代演', () => {
  it('⭐ 指向 open_stage 的 cast、说明玩家能在显示器改卡、明令不在对话里替他说话', async () => {
    const a = text(await call(ok));
    expect(a).toContain('角色卡.md');
    expect(a).toContain('open_stage');
    expect(a).toContain('演出进程');
    expect(a).toMatch(/别在对话里替他说话/);
    for (const stale of ['不要派子代理', 'subagent_type', 'SendMessage', '先 Read 一遍', '由你自己演', '现在就可以派']) {
      expect(a, `⛔ 旧教义不许残留：${stale}`).not.toContain(stale);
    }
  });
  it('⛔ 没有第二个位可选：pen 这类旧参数传了也不影响落点（schema 已收）', async () => {
    // ⚠️ 展示名跟别的用例错开：家按展示名取，共用工作区里同名会撞「一个家一个角色」那道闸
    expect(text(await call({ ...ok, id: 'moli2', name: '墨璃二', pen: 'narrator' }))).toContain('角色/墨璃二/角色卡.md');
  });
  it('改写已有的卡要说清「改卡不改在场的它」', async () => {
    await call({ ...ok, id: 'twice', name: '重写君' });
    const r2 = text(await call({ ...ok, id: 'twice', name: '重写君', persona: '第二版人设' }));
    expect(r2).toMatch(/改写/);
    expect(r2, '改完卡要说清进程会带新卡自动重开').toMatch(/自动重开/);
    expect(fs.readFileSync(path.join(ws, '角色', '重写君', '角色卡.md'), 'utf8')).toContain('第二版人设');
  });
});

// 家是按**展示名**取的，slug 另算 —— 两个 slug 用同一个展示名就会共用
// 角色/<名>/：卡被后来者覆盖，记忆.md 也共用，A 的 jot_memory 落进 B 的记忆里。
// 2026-08-28 对账发现，闸堵在写口。
describe('一个家只住一个角色', () => {
  it('⭐ 别的 slug 已经占了这个展示名 → 拒绝，并指出占用者', async () => {
    await call({ ...ok, id: 'hometaken', name: '同名君' });
    const r = await call({ ...ok, id: 'hometaken2', name: '同名君' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('rp-hometaken');
    expect(text(r)).toContain('同名君');
  });

  it('同一个 slug 重登不受影响 —— 那本来就是同一个人在改卡', async () => {
    await call({ ...ok, id: 'samehome', name: '改卡君' });
    const r = await call({ ...ok, id: 'samehome', name: '改卡君', persona: '改过的人设' });
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(ws, '角色', '改卡君', '角色卡.md'), 'utf8')).toContain('改过的人设');
  });

  it('⛔ 占用者的卡和记忆没被动过', async () => {
    await call({ ...ok, id: 'keeper', name: '守家君', persona: '原版人设 KEEP-ME' });
    fs.writeFileSync(path.join(ws, '角色', '守家君', '记忆.md'), '# 记忆\n\n守家君记得的事\n');
    await call({ ...ok, id: 'intruder', name: '守家君', persona: '入侵者人设' });
    expect(fs.readFileSync(path.join(ws, '角色', '守家君', '角色卡.md'), 'utf8')).toContain('KEEP-ME');
    expect(fs.readFileSync(path.join(ws, '角色', '守家君', '记忆.md'), 'utf8')).toContain('守家君记得的事');
  });
});

describe('id 校验：它是登记名和文件名', () => {
  it('⭐ 坏 id 一个都不许落盘', async () => {
    for (const id of ['A', '墨璃', 'a b', 'x', 'a/..', '']) {
      const r = await call({ ...ok, id });
      expect(r.isError).toBe(true);
    }
  });
  it('演员位的名字不能当角色 id', async () => {
    expect((await call({ ...ok, id: 'actor' })).isError).toBe(true);
    expect((await call({ ...ok, id: 'narrator' })).isError).toBe(true);
  });
  it('中文名字走 name 参数，不影响寻址名', async () => {
    const r = await call({ ...ok, id: 'chn', name: '程晚' });
    expect(text(r)).toContain('rp-chn');
    expect(text(r)).toContain('程晚');
  });
});

describe('人设本体', () => {
  it('空人设拒收', async () => {
    expect((await call({ ...ok, id: 'empty1', persona: '  ' })).isError).toBe(true);
  });
  it('超长人设拒收，指路世界书', async () => {
    const r = await call({ ...ok, id: 'long1', persona: 'x'.repeat(20001) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/世界书|grep/);
  });
});

describe('ID_RE 与 ROLE_SLUG_RE 的蕴含关系（08-28 钉死：两处判据不许各改各的）', () => {
  it('ID_RE 过的 id 拼上 rp- 前缀必被 ROLE_SLUG_RE 认账（含长度边界）', () => {
    for (const id of ['ab', 'a0', 'z_9', 'x-y_z', 'a'.repeat(41)]) {
      expect(ID_RE.test(id)).toBe(true);
      expect(ROLE_SLUG_RE.test(`rp-${id}`)).toBe(true);
    }
  });
  it('ID_RE 确实比全局判据严（大写/单字符被它拒，全局却认）——收紧方向别悄悄反转', () => {
    for (const id of ['A2', 'a']) {
      expect(ID_RE.test(id)).toBe(false);
      expect(ROLE_SLUG_RE.test(`rp-${id}`)).toBe(true);
    }
  });
});
