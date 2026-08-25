/**
 * mcp/tools/sketch-on-board.js —— finish_sketch（2026-08-25 范式重做②之后）
 *
 * sketch_on_board 本体已并进 write_on_board（一句话 = 图的最小单位，件数判据
 * 自动分流，见 write-on-board.js 头注释）；旧名在 write-on-board.js 里注册薄别名
 * 防老会话 resume。这里只剩 finish_sketch —— 草稿落定/整组擦除。它下一刀会被
 * edit_board 的 commit/erase_group 吞掉，先留着别断供。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { commitStaging, removeByTag } from '../../../projects/board-store.js';

export function makeFinishSketchTool({ projectId, ctx }) {
  return tool(
    'finish_sketch',
    `Commit a staging sketch (make it solid) — or erase it. Pass the #tag from
write_on_board; omit tag to commit everything still staging. erase:true deletes the
whole group (its notes/shapes/lines; real artifact cards only lose the tag).`,
    {
      tag: z.string().max(40).optional(),
      erase: z.boolean().optional(),
    },
    async ({ tag, erase }) => {
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      if (erase) {
        if (!tag) return { content: [{ type: 'text', text: 'erase needs a tag.' }], isError: true };
        const { removed } = await removeByTag(projectId, tag);
        try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `擦掉了草图 #${tag}` }); } catch { /* */ }
        return { content: [{ type: 'text', text: `Erased #${tag}: ${removed} item(s)/line(s) removed.` }] };
      }
      const { committed } = await commitStaging(projectId, { tag: tag || null });
      if (committed) { try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `草图落定${tag ? ` #${tag}` : ''}` }); } catch { /* */ } }
      return { content: [{ type: 'text', text: committed ? `Committed ${committed} item(s)${tag ? ` of #${tag}` : ''}.` : 'Nothing was staging.' }] };
    },
  );
}
