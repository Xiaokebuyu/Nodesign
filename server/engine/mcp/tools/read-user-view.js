/**
 * mcp/tools/read-user-view.js —— read_user_view（2026-08-23 黑板）
 *
 * 「用户此刻在看哪」：视口世界矩形 + 缩放 + 当前层 + 开着的窗 + 选中集 +
 * 视口里有哪些东西。前端节流上报、服务端只留最近一份（viewpoint-store）。
 * UserPromptSubmit 注入一行摘要（只报变化）；细节走这个工具。
 * 指代消解的顺序：选中的 > 开着的窗 > 视口中心附近的东西。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf } from '../../../lib/canvas-id.js';
import { getViewpoint, describeViewpoint } from '../../../projects/viewpoint-store.js';
import { describeEndpoint } from '../../../lib/board-relations.js';

export function makeReadUserViewTool({ projectId }) {
  return tool(
    'read_user_view',
    `What the user is looking at RIGHT NOW: viewport (world rect + zoom), which folder
layer, which artifact window is open, what is selected, and which items are inside the
viewport (sorted by distance to its centre). Use it to resolve "this / here / that one"
and to decide where a sketch or note should land so the user actually sees it. Resolve
pointers in this order: selected > open window > items near the viewport centre.`,
    { _: z.string().max(1).optional().describe('(no arguments)') },
    async () => {
      if (!projectId) return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      const vp = getViewpoint(projectId);
      if (!vp) return { content: [{ type: 'text', text: '还没有用户视点上报（用户没开着画布页，或上报过期 >10 分钟）。' }] };
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const layer = vp.layer || '';
      const rects = Object.entries(board.objects || {})
        .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === layer)
        .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
      const lines = [`用户此刻（${Math.round((Date.now() - vp.at) / 1000)}s 前上报）：${describeViewpoint(vp, rects) || '未知'}`];
      if (vp.camera) {
        const c = vp.camera; const cx = c.x + c.w / 2; const cy = c.y + c.h / 2;
        const inside = rects
          .filter(r => !(r.x + r.w < c.x || r.x > c.x + c.w || r.y + r.h < c.y || r.y > c.y + c.h))
          .map(r => ({ ...r, d: Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy) }))
          .sort((a, b) => a.d - b.d);
        if (inside.length) {
          lines.push('视口里（离中心由近到远）：');
          for (const r of inside.slice(0, 20)) {
            const e = board.objects[r.id];
            const flags = `${e.staging ? ' 〔草稿〕' : ''}${e.tag ? ` #${e.tag}` : ''}`;
            lines.push(`- ${describeEndpoint(r.id, board, { withId: false })} @(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)} (id: ${r.id})${flags}`);
          }
          if (inside.length > 20) lines.push(`…还有 ${inside.length - 20} 件`);
        }
        lines.push(`视口中心 = (${Math.round(cx)},${Math.round(cy)})；想让用户不用动镜头就看到，就把东西摆进这个矩形。`);
      }
      // 选中行印能回填的 id（09-17 iss_mtgcjmnf_tye4：`X（site）` 被抄回去当端点）；上面那行自带 (id: …)，用不带 id 的写法
      if (vp.selected?.length) lines.push(`选中：${vp.selected.map(id => describeEndpoint(id, board)).join('、')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
