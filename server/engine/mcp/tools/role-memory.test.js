// jot_memory 的回归闸（2026-08-28 角色文件夹范式）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeJotMemoryTool, roleHomeDir } from './role-memory.js';
import { makePreToolUseActorStamp } from '../../agent/hooks/pre-defaults.js';
import { _resetActorTrail, noteAgentName } from '../../agent/actor-trail.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-rolemem-'));
const stamp = makePreToolUseActorStamp();
let n = 0;
const callAs = async (agentType, args, { agentId = 'amem1' } = {}) => {
  _resetActorTrail();
  const id = `toolu_mem_${n += 1}`;
  if (agentType) await stamp({ agent_id: agentId, agent_type: agentType }, id);
  return makeJotMemoryTool({ workspaceRoot: ws }).handler(args, { _meta: { 'claudecode/toolUseId': id } });
};

describe('jot_memory', () => {
  it('⭐ 角色记一笔 → 追加进 角色/<slug>/记忆.md（未登记时按 slug 开家）', async () => {
    const r = await callAs('rp-moli', { text: '答应了砚青，天亮前把信送到。' });
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    const file = path.join(ws, '角色', 'rp-moli', '记忆.md');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('天亮前把信送到');
    await callAs('rp-moli', { text: '第二件事。' });
    const body2 = fs.readFileSync(file, 'utf8');
    expect(body2).toContain('天亮前把信送到');   // 追加，不覆盖
    expect(body2).toContain('第二件事');
  });

  it('登记过的角色落进登记的家（展示名文件夹）', async () => {
    fs.mkdirSync(path.join(ws, '.nd'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.nd', 'cast.json'),
      JSON.stringify({ version: 1, roles: { 'rp-wan': { name: '程晚', pen: 'character', card: '角色/程晚/角色卡.md' } } }), 'utf8');
    const r = await callAs('rp-wan', { text: '他接住了我的杯子。' });
    expect(r.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(ws, '角色', '程晚', '记忆.md'), 'utf8')).toContain('杯子');
  });

  it('⭐ 登记表被改成逃逸路径 → 兜回 slug 家（判据不信模型可写的表）', async () => {
    fs.writeFileSync(path.join(ws, '.nd', 'cast.json'),
      JSON.stringify({ version: 1, roles: { 'rp-evil': { name: 'x', pen: 'character', card: '角色/../外面/角色卡.md' } } }), 'utf8');
    expect(await roleHomeDir(ws, 'rp-evil')).toBe('角色/rp-evil');
  });

  it('演员位实例经别名解析后记进实例的家', async () => {
    _resetActorTrail();
    noteAgentName('amem2', 'rp-elle');
    await stamp({ agent_id: 'amem2', agent_type: 'rp-actor' }, 'toolu_mem_alias');
    const r = await makeJotMemoryTool({ workspaceRoot: ws }).handler(
      { text: '今晚的听众只有一个人。' }, { _meta: { 'claudecode/toolUseId': 'toolu_mem_alias' } });
    expect(r.isError, r.content?.[0]?.text).toBeUndefined();
    expect(fs.existsSync(path.join(ws, '角色', 'rp-elle', '记忆.md'))).toBe(true);
  });

  it('主控（非角色）与裸演员位被拒', async () => {
    expect((await callAs(null, { text: 'x' })).isError).toBe(true);
    // 别名没学到的演员位实例：byOf 落回 rp-actor —— 不能把记忆记到"位置"名下
    const r = await callAs('rp-actor', { text: 'x' }, { agentId: 'a-unknown' });
    expect(r.isError).toBe(true);
  });
});
