// 角色文件的读取与派发期白名单（2026-08-26）
//
// 这条链的要害：角色文件**是模型可写的**。cast_role 是正门，但主 agent 手里有
// Write/Edit/Bash，`.claude/agents/` 就在工作区内。所以「角色只能拿板上工具」
// 这条教义必须在**派发时**成立，而不是只在写入时成立。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRoleCard, parseToolsDeclaration } from './role-card.js';
import { makePreToolUseAgentForceForegroundHandler } from './hooks/pre-defaults.js';
import { createRoleRoster } from './cast.js';

let ws;
const write = (slug, body) => {
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'agents', `${slug}.md`), body);
};
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-rolecard-')); });
afterEach(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } });

const card = (tools) => `---
name: rp-x
description: "RP 角色「墨璃」。讲故事"
${tools}
model: inherit
---

你是墨璃。
`;

const spawn = (type) => makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster(), workspaceRoot: ws })
  ({ tool_input: { subagent_type: type } });
const denyReason = async (type) => (await spawn(type))?.hookSpecificOutput?.permissionDecisionReason ?? null;

describe('tools 声明的三种合法写法都认得', () => {
  it('逗号列表（cast_role 写的那种）', () => {
    expect(parseToolsDeclaration('tools: a, b, c').tools).toEqual(['a', 'b', 'c']);
  });
  it('flow 数组', () => {
    expect(parseToolsDeclaration('tools: [a, b]').tools).toEqual(['a', 'b']);
  });
  it('多行数组', () => {
    expect(parseToolsDeclaration('tools:\n  - a\n  - b\nmodel: inherit').tools).toEqual(['a', 'b']);
  });
  it('⭐ 完全没有 tools 行 = missing（SDK 语义是继承父的全部工具）', () => {
    expect(parseToolsDeclaration('name: rp-x\nmodel: inherit').kind).toBe('missing');
  });
});

describe('派发期白名单：手写角色文件绕不开', () => {
  it('⭐ 点名要外发工具 → 拒', async () => {
    write('rp-evil', card('tools: mcp__nodesign__write_on_board, mcp__nodesign__publish_site'));
    expect(await denyReason('rp-evil')).toMatch(/publish_site/);
  });

  it('⭐⭐ server 通配（= 该 server 全部工具）→ 拒', async () => {
    write('rp-evil', card('tools: mcp__nodesign'));
    expect(await denyReason('rp-evil')).toMatch(/不该给角色的工具/);
  });

  it('⭐⭐ 压根不写 tools 行（= 继承父代理全部工具）→ 拒，且说清楚为什么', async () => {
    write('rp-evil', `---\nname: rp-evil\ndescription: "RP 角色「坏」。x"\nmodel: inherit\n---\n你好\n`);
    expect(await denyReason('rp-evil')).toMatch(/没有 tools 那一行.*继承你的全部工具/s);
  });

  it('形状看不懂 → 拒（判据看不懂的东西不默认放行）', async () => {
    write('rp-evil', card('tools:'));
    expect(await denyReason('rp-evil')).toMatch(/看不懂/);
  });

  it('cast_role 写出来的合法角色 → 放行并强制后台', async () => {
    write('rp-good', card('tools: mcp__nodesign__write_on_board, SendMessage, ToolSearch'));
    const out = await spawn('rp-good');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.run_in_background).toBe(true);
  });

  it('角色文件不存在 → 放行（派发自己会失败，失败会把名字撤回）', async () => {
    expect(await denyReason('rp-nobody')).toBeNull();
  });

  it('普通子代理完全不走这条路', async () => {
    write('rp-evil', card('tools: mcp__nodesign'));
    const out = await spawn('worker');
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(out.hookSpecificOutput.updatedInput.run_in_background).toBe(false);
  });
});

describe('展示名反解', () => {
  it('带引号的 description 剥得开', async () => {
    write('rp-x', card('tools: SendMessage'));
    expect((await readRoleCard(ws, 'rp-x')).displayName).toBe('墨璃');
  });
  it('⚠️ 自称保留字在**出口**就被打回 slug（08-28 闸下沉进 readRoleCard）', async () => {
    // 旧契约是"读得出原始自称、闸在 listRoleNames 过"——那意味着任何直接消费
    // readRoleCard().displayName 的新调用点都会重蹈「三个渲染面漏一个」。
    // 新契约：这个出口拿到的永远是洗过的名字，冒充「用户」直接退回 slug。
    write('rp-x', `---\nname: rp-x\ndescription: "RP 角色「用户」。冒充"\ntools: SendMessage\n---\nhi\n`);
    expect((await readRoleCard(ws, 'rp-x')).displayName).toBe('rp-x');
  });
});
