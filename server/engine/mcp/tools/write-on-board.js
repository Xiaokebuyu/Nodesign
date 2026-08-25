/**
 * mcp/tools/write-on-board.js —— write_on_board（2026-08-23 黑板三期）
 *
 * agent 在画布上**说话**的主通道：一段 md 板书，贴着它说的那件东西（`near`），或者
 * 接在用户/自己的某条板书下面（`reply_to` = 线程）。本体是文件
 * （notes/板书/<stamp>-<slug>.md，见 lib/chalk.js），board.json 只存位置和线。
 *
 * 落位纪律（gutter）：
 *   - reply_to：落在被回应那条的**正下方**（同列、间距 12），自动连 flow 线（读序）
 *   - near：落在锚点右侧、顶对齐，撞了往下让；自动连 annotates 线（这段话关于它）
 *   - 都没有：用户视口里的空地 > 桌面内容底下
 * 跟 create_on_board 的分工：那是"记号"（手写一句、画布原生、给人看），这是"话"
 * （md、文件本体、agent 要能读回来、有线程）。黑板模式下回复的主体走这里。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId, tagEnvelope } from '../../../lib/canvas-id.js';
import { textBox, findSpot, SKETCH_FIT } from '../../../lib/sketch-layout.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../../lib/chalk.js';
import { Events } from '../../agent/events.js';

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

export function makeWriteOnBoardTool({ projectId, sharedRoot, sessionId, ctx }) {
  const turnStamp = { turn: -1, count: 0 };
  return tool(
    'write_on_board',
    `Say it ON THE BOARD: write a short Markdown note on the canvas, beside the thing it is
about (near) or right under a note you are replying to (reply_to). This is your main way
to talk to the user when they work on the canvas — the sidebar is the log, the board is
the conversation. The note is a real file (${CHALK_DIR}/…md) you can Read/Grep/Edit later.

- near: canvas id the note is about (an artifact card, an image, another note) → lands to
  its right, top-aligned, with an annotates line. Use it right after you finish something:
  "what this is / why this way / what to look at".
- reply_to: path of a board note (yours or the user's) → lands right under it with a
  flow line (a thread). When the user annotates one of your notes, answer with reply_to.
- neither → lands in the user's viewport (or below current content).
- text: Markdown (+KaTeX, lists, tables; ≤1500 chars, keep it one thought — long
  analysis belongs in a .md the user opens). size 'md' default, 'lg' for headlines.
Keep the chat reply short — a line pointing at the board is enough.`,
    {
      text: z.string().min(1).max(1500),
      near: z.string().max(300).optional(),
      reply_to: z.string().max(300).optional().describe(`path like ${CHALK_DIR}/20260823-070809-xxx.md`),
      tag: z.string().regex(/^[\w一-鿿぀-ヿ-]{1,40}$/).optional(),
      size: z.enum(['md', 'lg']).optional(),
      width: z.number().min(8).max(30).optional().describe('grid units (24px); default by content, max 30'),
    },
    async ({ text, near, reply_to: replyTo, tag, size, width }) => {
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
      if (!projectId || !sharedRoot) return err('No project bound.');
      // 回合闸 08-23 用户拍板先不设：只记数不拦
      const turn = ctx?.runId ?? -1;
      if (turnStamp.turn !== turn) { turnStamp.turn = turn; turnStamp.count = 0; }
      const body = String(text).trim();
      if (!body) return err('空话不上板。');

      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      // 默认宽度：散文按 14 格（336px）排，短句按内容；太窄会把一句话折成三行
      const em = (l) => [...l].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 1 : 0.62), 0);
      const longest = Math.max(...body.split('\n').map(em));
      const wUnits = width || (longest <= 12 ? null : Math.max(12, Math.min(18, Math.ceil(longest * 16 / 24) + 1)));
      const box = textBox(body, size || 'md', { md: true, wUnits });
      let zone = '';
      let pos = null;
      let anchorId = null; let parentId = null;
      const obstaclesOf = (z) => Object.entries(board.objects || {})
        .filter(([id, e]) => Number.isFinite(e?.x) && layerOf(id, e, known) === z)
        .map(([id, e]) => ({ id, x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
      const avoid = (p, obstacles, w, h) => {
        for (let g = 0; g < 40; g += 1) {
          const b = obstacles.find(o => !(p.x + w <= o.x || o.x + o.w <= p.x || p.y + h <= o.y || o.y + o.h <= p.y));
          if (!b) break;
          p.y = b.y + b.h + 12;
        }
        return p;
      };
      if (replyTo) {
        const pid = normalizeCanvasId(replyTo);
        const e = pid ? board.objects?.[pid] : null;
        if (!e || !Number.isFinite(e.x)) return err(`reply_to ${replyTo} 不在板上（read_board 里看不到就接不上）。`);
        parentId = pid; zone = layerOf(pid, e, known);
        const ps = estimateSizeOn(board, pid, e);
        pos = avoid({ x: e.x, y: e.y + ps.h + 12 }, obstaclesOf(zone), box.w, box.h);
      } else if (near) {
        const nid = normalizeCanvasId(near);
        const e = nid ? board.objects?.[nid] : null;
        if (e && Number.isFinite(e.x)) {
          anchorId = nid; zone = layerOf(nid, e, known);
          const as = estimateSizeOn(board, nid, e);
          pos = avoid({ x: e.x + as.w + 24, y: e.y }, obstaclesOf(zone), box.w, box.h);
        } else {
          // near 也认 tag（08-23 案）：落到那片东西的包络右侧，锚线连最右那个
          const env = tagEnvelope(board, near, (id2, e2) => estimateSizeOn(board, id2, e2));
          if (!env) return err(`锚点 ${near} 还没有座位，也不是板上任何 tag（read_board 里看不到就锚不上）。`);
          anchorId = env.anchorId; zone = layerOf(env.anchorId, board.objects[env.anchorId], known);
          pos = avoid({ x: env.x + env.w + 24, y: env.y }, obstaclesOf(zone), box.w, box.h);
        }
      } else {
        const obstacles = obstaclesOf('');
        let bottom = 0; for (const o of obstacles) bottom = Math.max(bottom, o.y + o.h);
        for (const zz of Object.values(board.zones || {})) if (Number.isFinite(zz?.y)) bottom = Math.max(bottom, zz.y + 240);
        const vp = getViewpoint(projectId);
        const vpRect = (vp && !(vp.layer) && vp.camera) ? vp.camera : null;
        const spot = findSpot({ w: box.w + 24, h: box.h + 24, obstacles, contentBottom: bottom, viewport: vpRect });
        pos = { x: spot.x + 12, y: spot.y + 12 };
      }

      const fileName = chalkFileName(body);
      const content = renderChalk({ body, by: 'agent', anchor: anchorId, replyTo: parentId, tag: tag || null, sessionId: sessionId || null });
      const rel = await writeChalkFile(sharedRoot, fileName, content);

      const objects = { [rel]: { x: Math.round(pos.x), y: Math.round(pos.y), z: 1, w: box.w, h: box.h, zone, by: 'agent', seat: 'agent', ...(tag ? { tag } : {}) } };
      const bindings = {};
      if (anchorId) bindings[`b:a${stamp()}`] = { type: 'annotates', from: rel, to: anchorId, by: 'agent', ...(tag ? { tag } : {}) };
      if (parentId) bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: rel, by: 'agent', material: 'pencil', ...(tag ? { tag } : {}) };
      await patchBoard(projectId, { objects, bindings });
      turnStamp.count += 1;
      const rect = { x: Math.round(pos.x), y: Math.round(pos.y), w: box.w, h: box.h };
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: parentId ? '回了一条板书' : '写了一条板书' });
        // chalk 字段进精灵追踪链（08-24）：形状钉在 Events.boardFocus，别再内联对象
        ctx?.emit?.(Events.boardFocus(rect, { tag: tag || null, layer: zone, soft: true, chalk: rel }));
      } catch { /* */ }
      const big = box.h > SKETCH_FIT.h * 0.6;
      return { content: [{ type: 'text', text:
        `Wrote board note ${rel} at (${rect.x},${rect.y}) ${rect.w}x${rect.h}`
        + (anchorId ? ` beside ${anchorId} (annotates line)` : parentId ? ` under ${parentId} (thread)` : ' in the user\'s view')
        + `.${big ? ' ⚠ It is tall — next time split or shorten.' : ''} Mention it in one line in chat; the user can annotate it to reply.` }] };
    },
  );
}
