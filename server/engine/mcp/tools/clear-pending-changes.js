/**
 * mcp/tools/clear-pending-changes.js — clear_pending_changes MCP tool
 *
 * 配 get_pending_changes 用：agent 处理完 pending 变更后清 buffer，
 * 避免下次 turn 又看到同样的变更被反复处理。
 *
 * 不传 ids → 全清；传 ids → 只删指定。
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
export function makeClearPendingChangesTool({ workspaceRoot, ctx }) {
  return tool(
    'clear_pending_changes',
    `Clear processed items from the user's pending changes buffer.

Call this after you've read pending changes via get_pending_changes and
acted on them, so the same changes don't re-appear in the next turn.

- Omit ids → clear all
- Pass ids → clear only those specific items`,
    {
      ids: z
        .array(z.string())
        .optional()
        .describe('Specific item ids to clear; omit to clear everything'),
    },
    async ({ ids }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot clear pending changes.' }],
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
        }

        const before = buf.items.length;
        if (Array.isArray(ids) && ids.length > 0) {
          const set = new Set(ids);
          buf.items = buf.items.filter(it => !set.has(it.id));
        } else {
          buf.items = [];
        }
        const removed = before - buf.items.length;

        await fs.writeFile(bufPath, JSON.stringify(buf, null, 2), 'utf8');

        try {
          ctx?.emit?.({
            type: 'run.pending_changes_cleared',
            removed,
            remaining: buf.items.length,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Cleared ${removed} pending change(s); ${buf.items.length} remaining.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `clear_pending_changes failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
