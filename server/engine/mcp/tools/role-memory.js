/**
 * mcp/tools/role-memory.js —— jot_memory：角色往自己家里记一笔（2026-08-28）
 *
 * 角色文件夹范式（用户拍板）：`角色/<名>/` 是一个角色的家 —— 角色卡.md 住这，
 * 记忆.md 也住这，**用户随时能改**。角色没有 Write/Edit（白名单如此，不放开），
 * 所以「角色自己记记忆」只能是一件 MCP 工具：身份从 byOf 盖章来（不是自称），
 * 落点由 harness 拼（角色写不了别人家）。
 *
 * 记忆是**追加式日志**：一次一条、带时间戳小节。改写/整理归用户和 GM（他们有真编辑
 * 权），角色只增不删 —— 「角色能抹掉自己说过的话」不是我们要的性质。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { byOf } from '../actor.js';
import { isResidentRole, isSlotType } from '../../agent/cast.js';
import { readCastRegistry } from '../../agent/role-card.js';

const ROLES_DIR = '角色';
const MEMORY_FILE = '记忆.md';
const MAX_NOTE = 2000;

/** 这个角色的家在哪：登记表里卡的目录优先，没登记就按 slug 开家 */
export async function roleHomeDir(workspaceRoot, slug) {
  const reg = await readCastRegistry(workspaceRoot);
  const card = reg.roles?.[slug]?.card;
  if (typeof card === 'string' && card.startsWith(`${ROLES_DIR}/`)) {
    const dir = path.dirname(card);
    // 登记表模型可写 —— 家必须还在 角色/ 里，逃出去就按 slug 兜底
    if (!dir.includes('..')) return dir;
  }
  return `${ROLES_DIR}/${slug}`;
}

export function makeJotMemoryTool({ workspaceRoot }) {
  return tool(
    'jot_memory',
    `Jot one note into YOUR OWN memory file (角色/<你>/${MEMORY_FILE}).

For resident roles only. Use it for things future-you must remember across scenes:
promises made, secrets learned, how you feel about someone now, where an item went.
One event per call, a few lines. Append-only — the user and the GM curate the file,
you never rewrite history. When you wake up lost, Read your card and this file.`,
    {
      text: z.string().min(1).max(MAX_NOTE).describe('The note. A few lines, first person, concrete.'),
    },
    async (args, extra) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!workspaceRoot) return fail('没有工作区。');
      const me = byOf(extra);
      if (!isResidentRole(me) || isSlotType(me)) {
        return fail('只有常驻角色有记忆文件。你是主控 —— 项目记忆走 记忆/ 目录（Write/Edit）。');
      }
      const text = String(args.text || '').trim();
      if (!text) return fail('空的记不了。');

      const homeRel = await roleHomeDir(workspaceRoot, me);
      const dir = path.join(workspaceRoot, homeRel);
      const file = path.join(dir, MEMORY_FILE);
      if (!path.resolve(file).startsWith(path.resolve(workspaceRoot, ROLES_DIR) + path.sep)) {
        return fail('记忆文件路径异常，拒绝写入。');
      }
      await fs.mkdir(dir, { recursive: true });
      let head = '';
      try { await fs.access(file); } catch {
        head = `# 记忆\n\n<!-- ${me} 的记忆：角色自己 jot_memory 追加，用户和 GM 可整理改写。 -->\n`;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await fs.appendFile(file, `${head}\n## ${stamp}\n\n${text}\n`, 'utf8');
      return { content: [{ type: 'text', text: `记下了 → ${homeRel}/${MEMORY_FILE}` }] };
    },
  );
}
