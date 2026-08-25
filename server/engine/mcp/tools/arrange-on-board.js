/**
 * mcp/tools/arrange-on-board.js —— arrange_on_board（2026-08-14，agent 摆位批·写侧）
 *
 * 语义摆位，**不给裸坐标**（用户拍板）：agent 说的是"把 A 摆到 B 旁边"这种
 * 人话，坐标由这里算出来、写进跟用户拖拽**同一个 layout 权威**（board.objects
 * 的 x/y）—— 布局引擎、用户、agent 三方从此不打架。撞上已有的卡就往下让
 * （跟入座避让同一个精神），落盘带 by:'agent' 出处。
 *
 * feature/unfeature 立/撤主角：写 board.hero，前端 pickHero 的推断被它压过。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { normalizeCanvasId, layerOf } from '../../../lib/canvas-id.js';

const GAP_X = 24;
const GAP_Y = 16;

const hit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/** 撞卡往下让：同一层的既有条目当障碍（subject 自己除外） */
function nudgeDown(pos, size, obstacles) {
  const r = { ...pos, ...size };
  for (let guard = 0; guard < 60; guard += 1) {
    const blocker = obstacles.find(o => hit(r, o));
    if (!blocker) return { x: r.x, y: r.y };
    r.y = blocker.y + blocker.h + GAP_Y;
  }
  return { x: r.x, y: r.y };
}

export function makeArrangeOnBoardTool({ projectId, ctx }) {
  return tool(
    'arrange_on_board',
    `Move things on the canvas by MEANING, not pixels. Read the chart first (read_board).

Actions:
- beside:   put subject immediately right of anchor (same row)
- below:    put subject under anchor (same column)
- feature:  make subject THE hero of the desktop (rendered one size up); no anchor
- unfeature: drop the explicit hero, back to automatic judgment; no subject needed

Rules the tool enforces: subject and anchor must live in the same folder layer
(move files with mv first); collisions push the subject downward; your placements
are marked by:'agent' so the user can tell who seated what. The user can always
drag things afterwards — their move wins, do not fight it.`,
    {
      action: z.enum(['beside', 'below', 'feature', 'unfeature'])
        .describe('What to do (see list above)'),
      subject: z.string().min(1).max(300).optional()
        .describe('Canvas id of the thing to move / feature (required except for unfeature)'),
      anchor: z.string().min(1).max(300).optional()
        .describe('Canvas id to place the subject relative to (required for beside/below)'),
    },
    async ({ action, subject: rawSubject, anchor: rawAnchor }) => {
      if (!projectId) {
        return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      }
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

      if (action === 'unfeature') {
        await patchBoard(projectId, { hero: null });
        try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: '撤了显式主角' }); } catch { /* fail-soft */ }
        return { content: [{ type: 'text', text: 'Hero override cleared — automatic judgment resumes.' }] };
      }

      const subject = normalizeCanvasId(rawSubject);
      if (!subject) return err('subject id 不合法。');

      if (action === 'feature') {
        await patchBoard(projectId, { hero: subject });
        try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `立了主角：${subject}` }); } catch { /* fail-soft */ }
        return { content: [{ type: 'text', text: `Featured: ${subject} now renders as the hero.` }] };
      }

      const anchor = normalizeCanvasId(rawAnchor);
      if (!anchor) return err('beside/below 需要 anchor。');
      if (anchor === subject) return err('subject 和 anchor 是同一件东西。');

      const board = await readBoard(projectId);
      const anchorEntry = board.objects?.[anchor];
      if (!anchorEntry || !Number.isFinite(anchorEntry.x)) {
        return err(`锚点 ${anchor} 还没有座位（read_board 里看不到的东西没法当锚）。`);
      }
      const known = new Set(Object.keys(board.zones || {}));
      const subjectEntry = board.objects?.[subject] || null;
      const anchorLayer = layerOf(anchor, anchorEntry, known);
      if (subjectEntry) {
        const subjectLayer = layerOf(subject, subjectEntry, known);
        if (subjectLayer !== anchorLayer) {
          return err(`不同层（${subjectLayer || '根'} vs ${anchorLayer || '根'}）：摆位只在同一层内有意义。`
            + '要摆到一起：先把文件放进同一个文件夹（assets/ 里的素材用 cp 复制过去 —— 母版别挪走）；'
            + '只是想表达"相关"，用 relate_on_board 连一条线更合适。');
        }
      }

      const aSize = estimateSizeOn(board, anchor, anchorEntry);
      const sSize = estimateSizeOn(board, subject, subjectEntry);
      const want = action === 'beside'
        ? { x: Math.round(anchorEntry.x + aSize.w + GAP_X), y: Math.round(anchorEntry.y) }
        : { x: Math.round(anchorEntry.x), y: Math.round(anchorEntry.y + aSize.h + GAP_Y) };

      const obstacles = Object.entries(board.objects || {})
        .filter(([id, e]) => id !== subject && Number.isFinite(e?.x)
          && layerOf(id, e, known) === anchorLayer)
        .map(([id, e]) => ({ ...estimateSizeOn(board, id, e), x: e.x, y: e.y }));
      const pos = nudgeDown(want, sSize, obstacles);

      // seat:'agent' = 这个**座**是 agent 摆的（by 是"谁造的"，别再拿它记摆位出处）
      await patchBoard(projectId, {
        objects: { [subject]: { ...(subjectEntry || {}), x: pos.x, y: pos.y, seat: 'agent' } },
      });
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `摆了 ${subject}` });
      } catch { /* fail-soft */ }
      return {
        content: [{
          type: 'text',
          text: `Placed ${subject} ${action} ${anchor} at (${pos.x},${pos.y})`
            + (pos.y !== want.y ? ' (nudged down to avoid overlap)' : '') + '.',
        }],
      };
    },
  );
}
