/**
 * mcp/tools/draw-trend.js —— `draw_trend`：状态表历史 → 手绘趋势线
 * （2026-08-30 画图能力线·「活图」第一块）
 *
 * 数据不用记：状态表住在板书文件里、文件进 git、**每回合落一个 commit** ——
 * 「好感度随拍数怎么走」的序列是现成的，git 就是时间轴（lib/state-trend.js）。
 *
 * 重画语义：同 key 再调一次 = 原地重画（旧的擦掉、**位置保留** —— 用户拖过它
 * 摆在哪就还在哪）。所以每拍 set_vars 之后想让曲线长一格，再调一次就行。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { removeByTag } from '../../../projects/board-tags.js';
import { trendSeries, trendGeometry } from '../../../lib/state-trend.js';
import { roughFreePath, textBox } from '../../../lib/sketch-layout.js';
import { KEY_MAX } from '../../../lib/state-table.js';
import { currentSheet, toWorld } from '../../../lib/board-sheets.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { Events } from '../../agent/events.js';

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

export function makeDrawTrendTool({ projectId, sharedRoot, sessionId, ctx }) {
  return tool(
    'draw_trend',
    `Draw a hand-inked trend line of one state-table key over the story so far — 好感度
climbing across eight beats, HP bleeding down. The series comes from the workspace's
git history (one commit per turn), so there is nothing to record: if the number lived
in the state table, its past is already there. Call it again after set_vars and the
chart redraws IN PLACE (position kept, even if the user dragged it). Needs ≥2 numeric
points — early beats will refuse loudly, that is normal.`,
    {
      key: z.string().min(1).max(KEY_MAX).describe('Which state-table key to chart (must hold numbers — 8/10 counts as 8)'),
      at: z.object({ x: z.number().min(0).max(12000), y: z.number().min(0).max(12000) }).optional()
        .describe('Sheet-local pixels for first placement. Omit it: lands under the state-table card (or where the previous chart of this key sits)'),
    },
    async (args) => {
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
      if (!projectId) return err('No project bound.');
      const s = await trendSeries(sharedRoot, args.key);
      if (!s.ok) return err(`⛔ ${s.why}`);

      const g = trendGeometry(s.points);
      const tag = `trend-${args.key}`.slice(0, 40);
      const board = await readBoard(projectId);

      // 落点：旧图原位 > at（纸内像素） > 状态表卡正下方
      let origin = null;
      const prev = Object.entries(board.objects || {}).filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
      if (prev.length) {
        origin = { x: Math.min(...prev.map(([, e]) => e.x)), y: Math.min(...prev.map(([, e]) => e.y)) };
        await removeByTag(projectId, tag);
      } else if (args.at) {
        const sheet = currentSheet(board, currentSheetIdOf(sessionId));
        if (!sheet) return err('还没有纸 —— 先 open_sheet，或者省掉 at 让它落在状态表卡下面。');
        origin = toWorld(sheet, args.at);
      } else {
        const e = board.objects?.[s.rel];
        if (!e || !Number.isFinite(e.x)) {
          return err(`状态表那条板书（${s.rel}）不在板上（没有座位）—— 传 at:{x,y}（纸内像素）指个位置。`);
        }
        const sz = estimateSizeOn(board, s.rel, e);
        origin = { x: e.x, y: e.y + sz.h + 16 };
      }

      // 标签在图上方一行；曲线 ink、基线 pencil、现值小圈 red —— 全过同一支抖动笔
      const label = `${args.key}  ${s.points[0]} → ${s.points[s.points.length - 1]}（${s.points.length} 拍，${g.min}~${g.max}）`;
      const lb = textBox(label, 'sm');
      const seed = `trend:${args.key}`;
      const objects = {
        [`text:a${stamp()}`]: {
          x: Math.round(origin.x), y: Math.round(origin.y), w: lb.w, h: lb.h, z: 1, kind: 'text',
          data: { t: label, font: 'kai', size: 'sm' }, zone: '', by: 'agent', seat: 'agent', tag,
        },
        [`scribble:a${stamp()}`]: {
          x: Math.round(origin.x), y: Math.round(origin.y + lb.h + 4), w: g.w, h: g.h, z: 1, kind: 'scribble',
          data: { d: roughFreePath(g.baselineD, `${seed}:base`), color: 'pencil', width: 1 }, zone: '', by: 'agent', seat: 'agent', tag,
        },
        [`scribble:b${stamp()}`]: {
          x: Math.round(origin.x), y: Math.round(origin.y + lb.h + 4), w: g.w, h: g.h, z: 1, kind: 'scribble',
          data: { d: roughFreePath(g.lineD, `${seed}:line`), color: 'ink', width: 2 }, zone: '', by: 'agent', seat: 'agent', tag,
        },
        [`scribble:c${stamp()}`]: {
          x: Math.round(origin.x), y: Math.round(origin.y + lb.h + 4), w: g.w, h: g.h, z: 1, kind: 'scribble',
          data: { d: g.dotD, color: 'red', width: 2 }, zone: '', by: 'agent', seat: 'agent', tag,
        },
      };
      await patchBoard(projectId, { objects });
      const rect = { x: Math.round(origin.x), y: Math.round(origin.y), w: g.w, h: g.h + lb.h + 4 };
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `画了 ${args.key} 的趋势线` });
        ctx?.emit?.(Events.boardFocus(rect, { tag, layer: '', soft: true }));
      } catch { /* fail-soft */ }
      return { content: [{ type: 'text', text:
        `Trend #${tag}: ${s.points.length} points (${s.points.join(' → ')}), range ${g.min}~${g.max}, `
        + `at (${rect.x},${rect.y}) ${rect.w}x${rect.h}${prev.length ? ' — redrawn in place' : ''}.\n`
        + `Call draw_trend again after set_vars to grow it; move/group it like any sketch (tag #${tag} — `
        + `edit_board follow can pin it to the 状态板 group).` }] };
    },
  );
}
