/**
 * mcp/tools/get-pending-changes.js — get_pending_changes MCP tool
 *
 * 用户在 canvas 上的"直接编辑（双击文本改字）"和"评论"会被前端 push 到
 * workspace/pending-changes.json。下次用户发 chat 消息时，turn.js 在
 * composeUserMessage 里 prepend 一个 system 提示告诉 agent "有 N 处变更，
 * 可调本工具查看详情"。agent 决定要不要拉详情。
 *
 * pending-changes.json schema：
 *   {
 *     items: [{
 *       id: string,
 *       kind: 'edit' | 'comment',
 *       anchor: { dataId, path, textHint, bbox },
 *       aiContext: { tag, role?, pageInfo?, outerHtml?, computed?, siblings? },
 *       diff?: { oldText, newText },     // edit 时有
 *       text?: string,                   // comment 时有
 *       ts: ISO,
 *     }]
 *   }
 *
 * 拉完后建议调 mcp__nodesign__clear_pending_changes 清 buffer，避免重复处理。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeGetPendingChangesTool({ workspaceRoot, ctx: _ctx }) {
  return tool(
    'get_pending_changes',
    `Read the user's pending changes buffer — a list of direct edits and
inline comments the user made on the canvas in between chat turns.

When to use:
- You see a <system>用户在过去时段做了 N 处变更...</system> hint at the top
  of the user's message → call this tool to read the actual changes.
- The user references "the change I just made" / "the edit I did" → check
  the buffer first.

Each item has:
- kind: 'edit' (user changed text by double-clicking in the canvas) or
        'comment' (user wrote a comment for an element)
- anchor: stable element reference (dataId / path / textHint / bbox)
- aiContext: element role, page info, outerHTML, computed styles, siblings
- diff (edit only): { oldText, newText }
- text (comment only): the comment body

After processing, call mcp__nodesign__clear_pending_changes to clear the
buffer so subsequent turns don't see the same changes again.`,
    {
      // No params; reading is unconditional.
      _placeholder: z.string().optional().describe('Unused; reserved for future filters'),
    },
    async () => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot read pending changes.' }],
            isError: true,
          };
        }

        const bufPath = path.join(workspaceRoot, 'pending-changes.json');
        let buf = { items: [] };
        try {
          const raw = await fs.readFile(bufPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.items)) buf = parsed;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          // file doesn't exist = empty buffer
        }

        const items = buf.items;
        if (items.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No pending changes. The user has not made any direct edits or comments since the last clear.',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Pending changes (${items.length} item${items.length === 1 ? '' : 's'}):\n\n`
              + JSON.stringify(items, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `get_pending_changes failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
