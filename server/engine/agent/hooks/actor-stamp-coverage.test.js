// 盖章覆盖面对账（2026-08-26）
//
// `byOf(extra)` 的那条章只有 hooks.js 里那个 matcher 会写。凡是**行为依赖 byOf**
// 的 MCP 工具，名字漏在 matcher 之外 = 那件工具在生产里静默失效：
//   - 板上工具漏了 → 角色写的东西署名落回 'agent'
//   - 收件箱两件漏了 → 守卫回「你是主控」，整条回路是死的（2026-08-26 真踩）
// 而这种漏法探针发现不了：探针往往接通配 matcher，比生产宽松。所以在这里对账。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hooksSrc = fs.readFileSync(path.join(HERE, '..', 'hooks.js'), 'utf8');

/** 行为依赖 byOf 的 MCP 短名（改这张表时，同一件事要在 hooks.js 的 matcher 里也有） */
const NEEDS_STAMP = [
  // 署名：写下去的东西要记是谁写的
  'write_on_board', 'create_on_board', 'edit_board', 'board_batch',
  'sketch_on_board', 'relate_on_board', 'arrange_on_board', 'edit_sketch',
  'finish_sketch', 'organize_board', 'pin_to_board',
  // 视角：同一句「你写的」对主控和角色含义相反
  'read_board',
  // 身份：这个收件箱是谁的（漏了 = 整条回路死掉）
  'await_user', 'check_inbox',
];

describe('actor 盖章 matcher', () => {
  const matcher = /matcher: '(mcp__nodesign__\([^']+\))'/.exec(hooksSrc)?.[1];

  it('matcher 存在且是那条 mcp 正则', () => {
    expect(matcher).toBeTruthy();
  });

  it('⭐ 每个依赖 byOf 的工具都在盖章 matcher 里', () => {
    const re = new RegExp(`^${matcher}$`);
    const missing = NEEDS_STAMP.filter((name) => !re.test(`mcp__nodesign__${name}`));
    expect(missing, `这些工具依赖 byOf 但没被盖章 —— 它们在生产里会静默失效：\n${missing.join('\n')}`).toEqual([]);
  });

  it('反向：matcher 里的名字都是真工具（别拼错）', () => {
    const inner = /\(([^)]+)\)/.exec(matcher)[1].split('|');
    for (const name of inner) expect(name).toMatch(/^[a-z_]+$/);
  });
});
