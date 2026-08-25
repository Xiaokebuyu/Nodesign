/**
 * mcp/tools/edit-sketch.js —— edit_sketch（2026-08-23 黑板二期）
 *
 * 改已有的图，不重画。原则抄用户自己的 AI-Annotation-demo 里那条「引用，不吐坐标」：
 * agent 只引用画布 id，位置用**相对关系**表达（在某件东西的右边/下面/上面/左边、
 * 或网格位移），像素由服务端解析 —— 让模型吐绝对坐标必幻觉。
 *
 * 一次调用一批操作（按序执行，一条坏了其余照做并在返回里报）：
 *   set_text   改字（文字节点：内容/格式/字号/颜色）
 *   move       挪一件：to {ref, side, gap?} 或 {dx, dy}（网格单位）
 *   move_group 挪一组（同 tag 的全部，保持相对位置）：to 同上
 *   remove     删一件画布原生物件（text/scribble）；产物卡不删（只能摘标签）
 *   add_node   加一个文字节点，位置 at {ref, side, gap?}，归进 tag
 *   add_edge / set_edge / remove_edge   线的增改删（线 id 见 read_board）
 * 改完前端按 board.updated 整份重拉；默认不进 staging（改的是已落定的图）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readBoard, patchBoard, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, textBox } from '../../../lib/sketch-layout.js';

const MAX_OPS = 40;
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

const REL = z.object({
  ref: z.string().min(1).max(300).describe('canvas id to place relative to'),
  side: z.enum(['right', 'left', 'above', 'below']),
  gap: z.number().min(0).max(40).optional().describe('grid units (default 1)'),
});
const DELTA = z.object({ dx: z.number().min(-200).max(200), dy: z.number().min(-200).max(200) }).describe('grid units');
const TO = z.union([REL, DELTA]);

const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(300), text: z.string().min(1).max(4000).optional(), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional() }),
  z.object({ op: z.literal('move'), id: z.string().min(1).max(300), to: TO }),
  z.object({ op: z.literal('move_group'), tag: z.string().min(1).max(40), to: TO }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('add_node'), id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().describe('local handle to reference in later ops of this call'), text: z.string().min(1).max(4000), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), at: REL, tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('add_edge'), from: z.string().min(1).max(300), to: z.string().min(1).max(300), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), label: z.string().max(60).optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_edge'), id: z.string().min(1).max(300), label: z.string().max(60).optional(), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional() }),
  z.object({ op: z.literal('remove_edge'), id: z.string().min(1).max(300) }),
]);

export function makeEditSketchTool({ projectId, ctx }) {
  return tool(
    'edit_sketch',
    `Edit what is already on the board — by id, without redrawing. Positions are RELATIVE
(to {ref, side, gap} = beside/above/below another canvas id) or grid deltas ({dx,dy},
1 cell = ${UNIT}px); you never give absolute coordinates. ids come from read_board
(nodes: text:…/scribble:…, cards: deck:…/site:…/paths; lines: b:…).
ops (run in order; a failing op is reported, the rest still apply):
 set_text{id,text?,format?,size?,color?,font?} · move{id,to} · move_group{tag,to} ·
 remove{id} · add_node{id?,text,at:{ref,side,gap?},…} · add_edge{from,to,type?,material?,label?} ·
 set_edge{id,label?,type?,material?} · remove_edge{id}
Use this for "move A under B", "rephrase that note", "add a branch", "delete the
wrong line". For a brand-new diagram use sketch_on_board.`,
    {
      tag: z.string().max(40).optional().describe('Default tag for add_node/add_edge (the sketch you are editing)'),
      ops: z.array(OP).min(1).max(MAX_OPS),
    },
    async ({ tag: defaultTag, ops }) => {
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
      if (!projectId) return err('No project bound.');
      const board = await readBoard(projectId);
      const known = new Set(Object.keys(board.zones || {}));
      const objects = {}; const bindings = {};      // 增量 patch
      const live = { ...board.objects };             // 本次调用内的"当前态"（让后一条 op 看见前一条的结果）
      const local = new Map();                       // add_node 的本地句柄 → canvas id
      // id 解析三级：本次调用的 add_node 句柄 → 真画布 id → **sketch_on_board 当初
      // 起的局部名**（data.lid）。第三级是 08-24 信箱那条：agent 画完图接着加线，
      // 自然会用 `linfan`，而它落定后叫 `text:amt7…`，7 条 add_edge 一次全灭。
      // 同名跨图时按 tag 收窄；还同名就取最后落盘的那个（同一次 sketch 内 id 唯一，
      // 撞名只会发生在不同图之间，最近画的那张几乎总是 agent 说的那张）。
      const byLid = (raw) => {
        const hits = Object.entries(live).filter(([, e]) => e?.data?.lid === raw && Number.isFinite(e?.x));
        if (!hits.length) return null;
        const scoped = defaultTag ? hits.filter(([, e]) => e.tag === defaultTag) : [];
        const pick = (scoped.length ? scoped : hits);
        return pick[pick.length - 1][0];
      };
      const rid = (raw) => {
        if (local.has(raw)) return local.get(raw);
        const c = normalizeCanvasId(raw);
        if (c && live[c]) return c;
        return byLid(raw);
      };
      const rectOf = (id) => { const e = live[id]; return e ? { x: e.x, y: e.y, ...estimateSizeOn(board, id, e) } : null; };
      const placeRel = (box, rel) => {
        const r = rectOf(rid(rel.ref));
        if (!r) return null;
        const g = (rel.gap ?? 1) * UNIT;
        if (rel.side === 'right') return { x: r.x + r.w + g, y: r.y };
        if (rel.side === 'left') return { x: r.x - g - box.w, y: r.y };
        if (rel.side === 'below') return { x: r.x, y: r.y + r.h + g };
        return { x: r.x, y: r.y - g - box.h };
      };
      const report = []; let ok = 0;
      const setObj = (id, e) => { live[id] = e; objects[id] = e; };

      for (let i = 0; i < ops.length; i += 1) {
        const o = ops[i];
        const fail = (why) => report.push(`✗ #${i + 1} ${o.op}: ${why}`);
        try {
          if (o.op === 'set_text') {
            const id = rid(o.id); const e = id && live[id];
            if (!e || e.kind !== 'text') { fail(`${o.id} 不是文字节点`); continue; }
            const data = { ...e.data };
            if (o.text) data.t = o.text;
            if (o.format) { if (o.format === 'md') data.format = 'md'; else delete data.format; }
            if (o.size) data.size = o.size; if (o.color) data.color = o.color; if (o.font && TEXT_FONTS.includes(o.font)) data.font = o.font;
            const box = textBox(data.t, data.size || 'md', { md: data.format === 'md' });
            setObj(id, { ...e, data, w: box.w, h: box.h }); ok += 1;
          } else if (o.op === 'move') {
            const id = rid(o.id); const e = id && live[id];
            if (!e) { fail(`${o.id} 不在板上`); continue; }
            const box = rectOf(id);
            const p = 'ref' in o.to ? placeRel(box, o.to) : { x: e.x + o.to.dx * UNIT, y: e.y + o.to.dy * UNIT };
            if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            setObj(id, { ...e, x: Math.round(p.x), y: Math.round(p.y), seat: 'agent' }); ok += 1;
          } else if (o.op === 'move_group') {
            const members = Object.entries(live).filter(([, e]) => e.tag === o.tag && Number.isFinite(e?.x));
            if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
            const bb = { x: Math.min(...members.map(([, e]) => e.x)), y: Math.min(...members.map(([, e]) => e.y)) };
            const rects = members.map(([id]) => rectOf(id));
            const w = Math.max(...rects.map(r => r.x + r.w)) - bb.x; const h = Math.max(...rects.map(r => r.y + r.h)) - bb.y;
            const p = 'ref' in o.to ? placeRel({ w, h }, o.to) : { x: bb.x + o.to.dx * UNIT, y: bb.y + o.to.dy * UNIT };
            if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
            for (const [id, e] of members) setObj(id, { ...e, x: e.x + dx, y: e.y + dy, seat: 'agent' });
            ok += 1;
          } else if (o.op === 'remove') {
            const id = rid(o.id); const e = id && live[id];
            if (!e) { fail(`${o.id} 不在板上`); continue; }
            if (!e.kind) { fail(`${id} 是产物卡，不能从黑板删；要摘标签用 finish_sketch erase`); continue; }
            delete live[id]; objects[id] = null; ok += 1;
          } else if (o.op === 'add_node') {
            const size = (o.size === 'sm' && o.text.length > 40) ? 'md' : (o.size || 'md');
            const box = textBox(o.text, size, { md: o.format === 'md' });
            const p = placeRel(box, o.at);
            if (!p) { fail(`参照 ${o.at.ref} 不在板上`); continue; }
            const refId = rid(o.at.ref);
            const zone = layerOf(refId, live[refId], known);
            const id = `text:a${stamp()}`;
            const tag = o.tag || defaultTag || live[refId]?.tag || null;
            setObj(id, {
              x: Math.round(p.x), y: Math.round(p.y), z: 1, w: box.w, h: box.h, kind: 'text',
              data: { t: o.text, ...(o.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(o.font) ? o.font : 'pen', size, color: o.color || 'ink' },
              zone, by: 'agent', seat: 'agent', ...(tag ? { tag } : {}),
            });
            if (o.id) local.set(o.id, id);
            report.push(`+ node ${o.id ? `${o.id}=` : ''}${id}`); ok += 1;
          } else if (o.op === 'add_edge') {
            const from = rid(o.from); const to = rid(o.to);
            if (!from || !to || from === to) {
              const miss = [!from ? o.from : null, !to ? o.to : null].filter(Boolean).join(' / ') || '两端相同';
              fail(`端点不在板上：${o.from} → ${o.to}（找不到：${miss}）。`
                + '画布 id 长这样 text:a… / scribble:a… / 文件路径；sketch_on_board 里起的局部名也认，'
                + '但要那张图还在板上。read_board 看一眼现在都有谁。');
              continue;
            }
            const id = `b:a${stamp()}`;
            const tag = o.tag || defaultTag || live[from]?.tag || live[to]?.tag || null;
            bindings[id] = { type: o.type || 'link', from, to, by: 'agent', ...(o.material && o.material !== 'ink' ? { material: o.material } : {}), ...(o.label ? { label: o.label } : {}), ...(tag ? { tag } : {}) };
            report.push(`+ edge ${id}`); ok += 1;
          } else if (o.op === 'set_edge') {
            const b = board.bindings?.[o.id];
            if (!b) { fail(`线 ${o.id} 不存在`); continue; }
            const nb = { ...b };
            if (o.label !== undefined) { if (o.label) nb.label = o.label; else delete nb.label; }
            if (o.type) nb.type = o.type;
            if (o.material) { if (o.material === 'ink') delete nb.material; else nb.material = o.material; }
            bindings[o.id] = nb; ok += 1;
          } else if (o.op === 'remove_edge') {
            if (!board.bindings?.[o.id]) { fail(`线 ${o.id} 不存在`); continue; }
            bindings[o.id] = null; ok += 1;
          }
        } catch (e) { fail(String(e?.message || e).slice(0, 120)); }
      }
      if (!ok) return err(`没有一条操作成功：\n${report.join('\n')}`);
      await patchBoard(projectId, { objects, bindings });
      try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `改了黑板（${ok} 处）` }); } catch { /* */ }
      return { content: [{ type: 'text', text: `Applied ${ok}/${ops.length} op(s).${report.length ? `\n${report.join('\n')}` : ''}` }] };
    },
  );
}
