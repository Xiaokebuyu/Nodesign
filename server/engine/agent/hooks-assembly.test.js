/**
 * hooks 装配测试 —— 钉的是「闸真的挂在真实 matcher 上」。
 *
 * 08-28 的教训：scene-tools 的单测直接调 stamp() 伪造身份，全绿；而真实装配里
 * actor-stamp 的 matcher 是手写名单、漏了场务四件 —— pass_turn 对真角色恒拒、
 * set_scene/cue_role 的 GM-only 闸反向漏开，没有任何测试 import 过 createHooks()
 * 去看 matcher 长什么样。单测绕过装配 = 判据本身没验（feedback-verify-the-instrument）。
 *
 * 所以这里走**真的 createHooks()**：拿真实 PreToolUse 配置，按 SDK 的 matcher 语义
 * （正则匹配工具名）逐个工具名问「actorStamp 盖不盖章」。
 */

import { describe, it, expect } from 'vitest';
import { createHooks } from './hooks.js';

/** SDK 语义：matcher 是匹配工具名的正则（没有 matcher = 通配） */
function stampedBy(cfg, toolName) {
  const entries = cfg.PreToolUse || [];
  return entries.some((e) => {
    if (e.matcher && !new RegExp(`^(?:${e.matcher})$`).test(toolName)) return false;
    return (e.hooks || []).some((h) => h.name === 'actorStamp');
  });
}

describe('createHooks —— actor-stamp 的真实覆盖面', () => {
  const cfg = createHooks({});

  it('凡 nodesign MCP 工具都盖章（含 08-28 审出漏掉的场务四件）', () => {
    // 名单承自 actor-stamp-coverage.test.js（08-26，本测试的前身，靠解析源码文本认
    // 名单，改成通配后退役）：这些是**行为依赖 byOf** 的工具，哪个跌出闸外就是
    // 生产静默失效 —— 将来有人把通配收窄回名单时，这里就是对账表。
    for (const short of [
      // 署名：写下去的东西要记是谁写的
      'write_on_board', 'create_on_board', 'edit_board', 'board_batch',
      'sketch_on_board', 'relate_on_board', 'arrange_on_board', 'edit_sketch',
      'finish_sketch', 'organize_board', 'pin_to_board',
      // 视角：同一句「你写的」对主控和角色含义相反
      'read_board',
      // 身份：这个收件箱是谁的（漏了 = 整条回路死掉，08-26 真踩）
      'await_user', 'check_inbox',
      // 08-28 审出的场务四件：漏章的症状是 byOf 静默落 'agent'——
      // pass_turn 恒拒真角色，set_scene/cue_role 反向对角色放行
      'set_scene', 'read_scene', 'cue_role', 'pass_turn',
      // 将来新加的工具也该天然在闸内 —— 挑一个跟署名八竿子打不着的名字当哨兵
      'some_future_tool',
    ]) {
      const name = `mcp__nodesign__${short}`;
      expect(stampedBy(cfg, name), `${name} 没被 actorStamp 盖章`).toBe(true);
    }
  });

  it('闸只圈 nodesign 命名空间（SDK 内置工具与别家 MCP 不盖）', () => {
    for (const name of ['SendMessage', 'Agent', 'Bash', 'Read', 'mcp__websearch__web_search']) {
      expect(stampedBy(cfg, name), `${name} 不该被 actorStamp 盖章`).toBe(false);
    }
  });
});
