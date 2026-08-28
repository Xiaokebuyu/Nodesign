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
  it('卡进角色文件夹，persona 原样在正文里，标了 slug 和笔权', async () => {
    const r = await call(ok);
    expect(r.isError).toBeUndefined();
    const card = fs.readFileSync(path.join(ws, '角色', '墨璃', '角色卡.md'), 'utf8');
    expect(card).toContain('# 墨璃');
    expect(card).toContain('rp-moli');
    expect(card).toContain('MAGIC-WORD-7');
    expect(card).toContain('角色笔');
  });

  it('登记表记下 slug → 展示名/笔权/卡路径，listRoleNames 读得到', async () => {
    await call(ok);
    const reg = await readCastRegistry(ws);
    expect(reg.roles['rp-moli']).toMatchObject({ name: '墨璃', pen: 'character' });
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

describe('返回话术：立即可派 + 正确的演员位', () => {
  it('character 笔指到 rp-actor，narrator 笔指到 rp-narrator，都说了不用等', async () => {
    const a = text(await call(ok));
    expect(a).toContain('现在就可以派');
    expect(a).toContain('subagent_type: "rp-actor"');
    expect(a).toContain('name: "rp-moli"');
    const b = text(await call({ ...ok, id: 'teller', name: '说书人', pen: 'narrator' }));
    expect(b).toContain('subagent_type: "rp-narrator"');
  });
  it('enum 之外的 pen 折回 character', async () => {
    expect(text(await call({ ...ok, id: 'moli2', pen: 'weird' }))).toContain('rp-actor');
    const reg = await readCastRegistry(ws);
    expect(reg.roles['rp-moli2'].pen).toBe('character');
  });
  it('改写已有的卡要说清「改卡不改在场的它」', async () => {
    await call({ ...ok, id: 'twice' });
    const r2 = text(await call({ ...ok, id: 'twice', persona: '第二版人设' }));
    expect(r2).toMatch(/改写/);
    expect(r2).toMatch(/不会改变|SendMessage/);
    expect(fs.readFileSync(path.join(ws, '角色', '墨璃', '角色卡.md'), 'utf8')).toContain('第二版人设');
  });
});

describe('id 校验：它要当 SendMessage 收件人名', () => {
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
