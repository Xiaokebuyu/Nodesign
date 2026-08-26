/**
 * mcp/tools/create-on-board.js —— create_on_board（2026-08-14，agent 建元素批）
 *
 * 让 agent 落**用户级的画布原生物件**。v1 只开手写字（text）：便签是留档不是
 * 聊天，agent 值得写下来的是"这一版为什么这么改"这类一句话，不是回复的搬运。
 * 涂鸦不开 —— agent 画矢量笔迹没有意义，它要画图走生图。
 *
 * 设计对齐用户侧：
 *   - near 锚定 = 用户"标注"的同构（落在锚右侧空白，关系线可选一步带上）——
 *     一次调用 = 一段字 + 一条线，跟 keepAnnotation 落的东西一模一样
 *   - 字体/字号走 board-store 同一份白名单（TEXT_FONTS）
 *   - 尺寸估算抄前端 handleCreateText 同款公式（约 26 全角字/行）
 *   - by:'agent' 出处，用户一眼分得出谁写的
 *
 * 护栏：每回合上限 08-23 按用户意思撤了（只记数）；画布不是弹幕区这条写在 prelude 里。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { z } from 'zod';
import { readBoard, patchBoard, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { normalizeCanvasId, layerOf } from '../../../lib/canvas-id.js';

const SIZE_PX = { sm: 13, md: 16, lg: 22, xl: 30 };

let seq = 0;
const nextTextId = () => `text:a${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;
const nextBindingId = () => `b:a${Date.now().toString(36)}n${(seq++ % 1000).toString(36)}`;

/** 前端 handleCreateText 同款身位估算（约 26 全角字/行，行高 1.6） */
function textBox(t, sizeKey) {
  const px = SIZE_PX[sizeKey] || 16;
  const cols = Math.min(26, Math.max(6, t.length));
  const lines = Math.ceil(t.length / cols) + (t.match(/\n/g)?.length || 0);
  return { w: Math.round(cols * px * 1.05) + 12, h: Math.round(lines * px * 1.6) + 10 };
}

export function makeCreateOnBoardTool({ projectId, ctx }) {
  const turnStamp = { turn: -1, count: 0 };
  return tool(
    'create_on_board',
    `Write a handwritten note directly on the canvas — the same kind the user writes.

Use it for remarks worth KEEPING on the board: why a version went this way, what
to compare, a caption for a group. Not for conversation (that goes in your reply)
and not for documents (write a .md instead).

- near: anchor it beside a thing (and usually pass relation to draw the line —
  that is exactly the user's "annotation" gesture: a note + an annotates edge)
- omit near: the note lands under the desktop's current content`,
    {
      text: z.string().min(1).max(200).describe('The note text (≤200 chars, one thought)'),
      near: z.string().max(300).optional()
        .describe('Canvas id to place the note next to (right side, auto-avoids overlap)'),
      relation: z.object({
        type: z.enum(['annotates', 'link']).describe('annotates = the note is ABOUT it; link = loosely related'),
        to: z.string().min(1).max(300).describe('Canvas id the line connects to (usually = near)'),
        label: z.string().max(60).optional().describe('Optional words on the line (link only usually)'),
      }).optional().describe('Draw a relation line from the note in the same call'),
      font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional()
        .describe('Handwriting style (default pen — same as the user\'s default)'),
      size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe('Text size (default md)'),
    },
    async ({ text, near: rawNear, relation, font, size }, extra) => {
      // 署名按调用者（常驻角色写的东西署它的名）——见 mcp/actor.js
      const by = byOf(extra);
      if (!projectId) {
        return { content: [{ type: 'text', text: 'No project bound.' }], isError: true };
      }
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

      // 回合闸 08-23 用户拍板先不设：只记数不拦
      const turn = ctx?.runId ?? -1;
      if (turnStamp.turn !== turn) { turnStamp.turn = turn; turnStamp.count = 0; }

      const t = String(text).trim();
      if (!t) return err('空字不落板。');
      const sizeKey = SIZE_PX[size] ? size : 'md';
      const box = textBox(t, sizeKey);

      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      let pos; let zone = '';
      if (rawNear) {
        const near = normalizeCanvasId(rawNear);
        const anchorEntry = near ? board.objects?.[near] : null;
        if (!anchorEntry || !Number.isFinite(anchorEntry.x)) {
          return err(`锚点 ${rawNear} 还没有座位（read_board 里看不到就锚不上）。`);
        }
        zone = layerOf(near, anchorEntry, known);
        const aSize = estimateSizeOn(board, near, anchorEntry);
        pos = { x: Math.round(anchorEntry.x + aSize.w + 24), y: Math.round(anchorEntry.y) };
        // 撞卡往下让（同 arrange 的避让）
        const obstacles = Object.entries(board.objects || {})
          .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === zone)
          .map(([id, e]) => ({ ...estimateSizeOn(board, id, e), x: e.x, y: e.y }));
        for (let g = 0; g < 40; g += 1) {
          const blocker = obstacles.find(o =>
            !(pos.x + box.w <= o.x || o.x + o.w <= pos.x || pos.y + box.h <= o.y || o.y + o.h <= pos.y));
          if (!blocker) break;
          pos.y = blocker.y + blocker.h + 16;
        }
      } else {
        // 桌面根层内容最低边下面（跟新物件入座同一条起排线精神）
        let bottom = 0;
        for (const [id, e] of Object.entries(board.objects || {})) {
          if (!Number.isFinite(e?.y) || layerOf(id, e, known) !== '') continue;
          bottom = Math.max(bottom, e.y + estimateSizeOn(board, id, e).h);
        }
        for (const zz of Object.values(board.zones || {})) {
          if (Number.isFinite(zz?.y)) bottom = Math.max(bottom, zz.y + 150);
        }
        pos = { x: 10, y: Math.round(bottom) + 16 };
      }

      const textId = nextTextId();
      const patch = {
        objects: {
          [textId]: {
            x: pos.x, y: pos.y, z: 1, w: box.w, h: box.h,
            kind: 'text',
            data: { t, font: TEXT_FONTS.includes(font) ? font : 'pen', size: sizeKey, color: 'ink' },
            zone, by,
          },
        },
      };
      if (relation) {
        const to = normalizeCanvasId(relation.to);
        if (to && to !== textId) {
          patch.bindings = {
            [nextBindingId()]: {
              type: relation.type, from: textId, to, by,
              ...(relation.label ? { label: relation.label } : {}),
            },
          };
        }
      }

      const saved = await patchBoard(projectId, patch);
      if (!saved.objects?.[textId]) return err('便签被 board 拒了（内容或字段不合法）。');
      turnStamp.count += 1;
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: '写了一条画布便签' });
      } catch { /* fail-soft */ }
      return {
        content: [{
          type: 'text',
          text: `Note on board at (${pos.x},${pos.y})${relation ? ' with a line' : ''} (id: ${textId}).`
            + '',
        }],
      };
    },
  );
}
