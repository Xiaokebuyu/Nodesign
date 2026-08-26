/**
 * mcp/tools/edit-board.js —— edit_board（2026-08-25 范式重做③）
 *
 * 改板的唯一入口。前身 edit_sketch，这一刀吞进四件（旧名全留薄别名一版防 resume）：
 *   arrange_on_board  → feature / unfeature（beside/below = move 的 to:{ref,side}）
 *   finish_sketch     → commit / erase_group
 *   relate_on_board   → add_edge（它独有的"端点必须真实存在"校验下沉进共享 add_edge
 *                       —— 原来一个查一个不查是口径病，悬空线全从不查的那个进来）
 *   edit_sketch       → 本体改名
 *
 * 新能力（08-25 RP 真会话那批 friction 的正面回答）：
 *   set_edge 支持改端点 from/to（「状态锚在这一章」重指一条命令，不再 remove+add）
 *   reflow{tag}       set_text 改高后整组按 column/row 重堆（agent 不该自带补丁模板）
 *   remove            对 agent 自己写的板书放行（连文件带座位带线一起清）
 *   move              有避让了（原 placeRel 裸落点，是六套引擎里唯一不避让的）
 *
 * 位置永远是相对表达（{ref,side,gap} 或网格位移），像素由服务端解析。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { z } from 'zod';
import { readBoard, patchBoard, commitStaging, removeByTag, chalkAbsPath, TEXT_FONTS } from '../../../projects/board-store.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { BINDING_TYPES, BINDING_TYPE_IDS, BINDING_MATERIALS } from '../../../lib/binding-types.js';
import { UNIT, textBox } from '../../../lib/sketch-layout.js';
import { resolvePlacement } from '../../../lib/board-place.js';
import { CHALK_DIR, trashChalkFile } from '../../../lib/chalk.js';
import { readUiConfigFile, writeUiConfig } from '../../../projects/ui-config.js';

const MAX_OPS = 120;
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

const REL = z.object({
  ref: z.string().min(1).max(300).describe('canvas id to place relative to'),
  side: z.enum(['right', 'left', 'above', 'below']),
  gap: z.number().min(0).max(8).optional().describe('grid CELLS, 1 cell = 24px (default 1; max 8 = 192px). NOT pixels — gap:2 means 48px'),
});
const DELTA = z.object({ dx: z.number().min(-2000).max(2000), dy: z.number().min(-2000).max(2000) }).describe('grid units');
const TO = z.union([REL, DELTA]);

const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_text'), id: z.string().min(1).max(300), text: z.string().min(1).max(8000).optional(), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional() }),
  z.object({ op: z.literal('move'), id: z.string().min(1).max(300), to: TO }),
  z.object({ op: z.literal('move_group'), tag: z.string().min(1).max(40), to: TO }),
  z.object({ op: z.literal('remove'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('add_node'), id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/).optional().describe('local handle for later ops of this call'), text: z.string().min(1).max(8000), format: z.enum(['plain', 'md']).optional(), size: z.enum(['sm', 'md', 'lg', 'xl']).optional(), font: z.enum(['pen', 'kai', 'sans', 'serif', 'mono']).optional(), color: z.enum(['ink', 'red', 'pencil', 'brass']).optional(), at: REL, tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('add_edge'), from: z.string().min(1).max(300), to: z.string().min(1).max(300), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), label: z.string().max(60).optional(), tag: z.string().max(40).optional() }),
  z.object({ op: z.literal('set_edge'), id: z.string().min(1).max(300), label: z.string().max(60).optional(), type: z.enum(BINDING_TYPE_IDS).optional(), material: z.enum(BINDING_MATERIALS).optional(), from: z.string().min(1).max(300).optional().describe('re-point the line: new source end'), to: z.string().min(1).max(300).optional().describe('re-point the line: new target end') }),
  z.object({ op: z.literal('remove_edge'), id: z.string().min(1).max(300) }),
  z.object({ op: z.literal('reflow'), tag: z.string().min(1).max(40), layout: z.enum(['column', 'row']).optional().describe('default column: restack the group in reading order with real sizes (use after set_text changes heights)') }),
  z.object({ op: z.literal('follow'), group_tag: z.string().min(1).max(40).describe('the group that should follow (e.g. a status panel)'), target_tag: z.string().min(1).max(40).describe('whenever a new item with this tag lands, the group auto-moves beside it and the anchor line re-points'), side: z.enum(['right', 'left', 'above', 'below']).optional(), label: z.string().max(60).optional() }),
  z.object({ op: z.literal('unfollow'), group_tag: z.string().min(1).max(40) }),
  z.object({ op: z.literal('commit'), tag: z.string().max(40).optional().describe('make staging solid; omit tag = everything staging') }),
  z.object({ op: z.literal('erase_group'), tag: z.string().min(1).max(40).describe('delete the whole tagged group (notes/shapes/lines; artifact cards only lose the tag)') }),
  z.object({ op: z.literal('feature'), id: z.string().min(1).max(300).describe('make this the hero of the desktop') }),
  z.object({ op: z.literal('unfeature') }),
  z.object({ op: z.literal('chalk_edit'), on: z.boolean().describe('true = turn ON the user-side 改板书 toggle (notes become freely draggable/editable for the user); false = back to guarded mode') }),
]);

export function makeEditBoardTool({ projectId, sharedRoot, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, ctx });
  return tool(
    'edit_board',
    `Edit what is already on the board — by id, without redrawing. Positions are RELATIVE
(to {ref, side, gap} beside another canvas id, or grid deltas {dx,dy}, 1 cell = ${UNIT}px);
you never write absolute coordinates. ids come from read_board (nodes text:…/scribble:…,
cards deck:…/site:…/paths, lines b:…); local names from the sketch that drew them work too.
ops (run in order; a failing op is reported, the rest still apply):
 set_text{id,text?,…} · move{id,to} · move_group{tag,to} · remove{id} (agent-written board
 notes included: file + seat + lines go together) · add_node{id?,text,at:{ref,side,gap?},…} ·
 add_edge{from,to,type?,material?,label?} · set_edge{id,from?,to?,label?,type?,material?}
 (re-point a line in one op) · remove_edge{id} · reflow{tag,layout?} (restack a group after
 text edits changed heights) · follow{group_tag,target_tag,side?} (standing rule: whenever a
 new item with target_tag lands, the group auto-moves beside it — a status panel that tracks
 the latest chapter needs this ONCE, not per turn) · unfollow{group_tag} ·
 commit{tag?} (staging → solid) · erase_group{tag} · feature{id} / unfeature (hero) ·
 chalk_edit{on} (flip the user's 改板书 toggle — turn it ON when the session leans on
 board notes, e.g. blackboard RP, so the user can drag/edit notes without double-click arming).
Moves avoid collisions (nearest free cell, user-dragged seats are never displaced).
For brand-new content use write_on_board.`,
    {
      tag: z.string().max(40).optional().describe('Default tag for add_node/add_edge (the group you are editing)'),
      ops: z.array(OP).min(1).max(MAX_OPS),
    },
    handler,
  );
}

/** 旧名薄别名（一版）：edit_sketch 同参数同 handler */
export function makeEditSketchAlias({ projectId, sharedRoot, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, ctx });
  return tool('edit_sketch', 'Deprecated alias of edit_board (same arguments). Use edit_board.', {
    tag: z.string().max(40).optional(),
    ops: z.array(OP).min(1).max(MAX_OPS),
  }, handler);
}

/** 端点存在性（relate_on_board 下沉来的那道闸，add_edge/set_edge 共用）：
 *  板上有座位 / doc: 固定名额 / 磁盘上真有这个路径。 */
async function endpointReal(id, live, zones, sharedRoot) {
  if (live[id]) return true;
  if (zones && zones[id] !== undefined) return true;
  if (/^doc:/.test(id)) return true;
  if (!sharedRoot) return false;
  const bare = id.replace(/^(deck|site|docx|text|scribble):/, '');
  if (!bare || bare.includes('..')) return false;
  try { await fs.access(path.join(sharedRoot, bare)); return true; } catch { return false; }
}

function makeHandler({ projectId, sharedRoot, ctx }) {
  return async ({ tag: defaultTag, ops }, extra) => {
    // 署名按调用者（常驻角色改板时署它的名）——见 mcp/actor.js
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId) return err('No project bound.');
    const board = await readBoard(projectId);
    const known = new Set(Object.keys(board.zones || {}));
    const objects = {}; const bindings = {};      // 增量 patch
    const live = { ...board.objects };             // 调用内"当前态"
    const liveBindings = { ...board.bindings };
    const local = new Map();                       // add_node 本地句柄 → canvas id
    let heroPatch;                                 // undefined = 不动；null = 撤；string = 立
    const chalkUnlinks = [];                       // remove 板书：patch 后再删文件
    let committed = 0; let erased = 0;

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
    /** 相对落位 + 避让（同层障碍，subject 自己除外；user 座是障碍永不被压） */
    const placeRel = (subjectId, box, rel) => {
      const refId = rid(rel.ref);
      const r = rectOf(refId);
      if (!r) return null;
      const zone = layerOf(refId, live[refId], known);
      const obstacles = Object.entries(live)
        .filter(([id, e]) => id !== subjectId && Number.isFinite(e?.x) && layerOf(id, e, known) === zone)
        .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
      const placed = resolvePlacement({
        box, anchor: r, side: rel.side, gap: (rel.gap ?? 1) * UNIT,
        obstacles, contentBottom: obstacles.reduce((m, o) => Math.max(m, o.y + o.h), 0),
      });
      return placed;
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
          if ('ref' in o.to) {
            const p = placeRel(id, box, o.to);
            if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            setObj(id, { ...e, x: Math.round(p.x), y: Math.round(p.y), seat: 'agent' });
            report.push(`· #${i + 1} move → (${Math.round(p.x)},${Math.round(p.y)})${p.nudged ? `（目标位被占，就近落在 ${p.resolution}）` : ''}`);
          } else {
            const nx = Math.round(e.x + o.to.dx * UNIT); const ny = Math.round(e.y + o.to.dy * UNIT);
            setObj(id, { ...e, x: nx, y: ny, seat: 'agent' });
            report.push(`· #${i + 1} move → (${nx},${ny})`);
          }
          ok += 1;
        } else if (o.op === 'move_group') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const bb = { x: Math.min(...members.map(([, e]) => e.x)), y: Math.min(...members.map(([, e]) => e.y)) };
          const rects = members.map(([id]) => rectOf(id));
          const w = Math.max(...rects.map(r => r.x + r.w)) - bb.x; const h = Math.max(...rects.map(r => r.y + r.h)) - bb.y;
          let p;
          if ('ref' in o.to) {
            const refId = rid(o.to.ref);
            const r = rectOf(refId);
            if (!r) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            const zone = layerOf(refId, live[refId], known);
            const memberIds = new Set(members.map(([id]) => id));
            const obstacles = Object.entries(live)
              .filter(([id, e]) => !memberIds.has(id) && Number.isFinite(e?.x) && layerOf(id, e, known) === zone)
              .map(([id, e]) => ({ x: e.x, y: e.y, ...estimateSizeOn(board, id, e) }));
            p = resolvePlacement({ box: { w, h }, anchor: r, side: o.to.side, gap: Math.min(8, o.to.gap ?? 1) * UNIT, obstacles, contentBottom: 0 });
          } else {
            p = { x: bb.x + o.to.dx * UNIT, y: bb.y + o.to.dy * UNIT };
          }
          const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
          for (const [id, e] of members) setObj(id, { ...e, x: e.x + dx, y: e.y + dy, seat: 'agent' });
          report.push(`· #${i + 1} move_group #${o.tag} → 组左上 (${Math.round(p.x)},${Math.round(p.y)})${'ref' in o.to && p.resolution ? `（${p.resolution}${p.nudged ? '，就近避让过' : ''}）` : ''}`);
          ok += 1;
        } else if (o.op === 'remove') {
          const id = rid(o.id); const e = id && live[id];
          if (!e) { fail(`${o.id} 不在板上`); continue; }
          if (!e.kind) {
            // 板书文件卡：**agent 侧写的**放行（连文件），用户写的和普通产物卡拒。
            // 08-26：agent 侧现在有三类署名（主控 'agent' + 常驻角色 rp-*）。原来死比
            // 'agent'，于是角色写的板书谁都删不掉（连角色自己），报错还说那是「用户的板书」。
            if (id.startsWith(`${CHALK_DIR}/`) && e.by && e.by !== 'user') {
              const abs = chalkAbsPath(projectId, id);
              if (abs) chalkUnlinks.push(abs);
              delete live[id]; objects[id] = null; ok += 1; continue;
            }
            fail(`${id} 是${id.startsWith(`${CHALK_DIR}/`) ? '用户的板书' : '产物卡'}，不能从黑板删；整组擦用 erase_group`); continue;
          }
          delete live[id]; objects[id] = null; ok += 1;
        } else if (o.op === 'add_node') {
          const size = (o.size === 'sm' && o.text.length > 40) ? 'md' : (o.size || 'md');
          const box = textBox(o.text, size, { md: o.format === 'md' });
          const p = placeRel(null, box, o.at);
          if (!p) { fail(`参照 ${o.at.ref} 不在板上`); continue; }
          const refId = rid(o.at.ref);
          const zone = layerOf(refId, live[refId], known);
          const id = `text:a${stamp()}`;
          const tag = o.tag || defaultTag || live[refId]?.tag || null;
          setObj(id, {
            x: Math.round(p.x), y: Math.round(p.y), z: 1, w: box.w, h: box.h, kind: 'text',
            data: { t: o.text, ...(o.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(o.font) ? o.font : 'pen', size, color: o.color || 'ink', ...(o.id ? { lid: o.id } : {}) },
            zone, by, seat: 'agent', ...(tag ? { tag } : {}),
          });
          if (o.id) local.set(o.id, id);
          report.push(`+ node ${o.id ? `${o.id}=` : ''}${id}`); ok += 1;
        } else if (o.op === 'add_edge') {
          const from = rid(o.from) || normalizeCanvasId(o.from);
          const to = rid(o.to) || normalizeCanvasId(o.to);
          if (!from || !to || from === to) { fail(`端点不合法：${o.from} → ${o.to}`); continue; }
          // relate 下沉来的闸：两端都必须真实存在（板上有座 / doc: / 磁盘真身）
          const missing = [];
          if (!(await endpointReal(from, live, board.zones, sharedRoot))) missing.push(o.from);
          if (!(await endpointReal(to, live, board.zones, sharedRoot))) missing.push(o.to);
          if (missing.length) {
            fail(`端点不在板上也不是存在的工作区路径：${missing.join(' / ')}。read_board 看一眼现在都有谁。`);
            continue;
          }
          const id = `b:a${stamp()}`;
          const tag = o.tag || defaultTag || live[from]?.tag || live[to]?.tag || null;
          const binding = { type: o.type || 'link', from, to, by, ...(o.material && o.material !== 'ink' ? { material: o.material } : {}), ...(o.label ? { label: o.label } : {}), ...(tag ? { tag } : {}) };
          bindings[id] = binding; liveBindings[id] = binding;
          report.push(`+ edge ${id}`); ok += 1;
        } else if (o.op === 'set_edge') {
          const b = liveBindings[o.id];
          if (!b) { fail(`线 ${o.id} 不存在`); continue; }
          const nb = { ...b };
          if (o.label !== undefined) { if (o.label) nb.label = o.label; else delete nb.label; }
          if (o.type) nb.type = o.type;
          if (o.material) { if (o.material === 'ink') delete nb.material; else nb.material = o.material; }
          // 改端点（08-25 RP 案：「状态锚在这一章」每章 remove+add 两次 → 一条命令重指）
          let bad = null;
          for (const end of ['from', 'to']) {
            if (o[end] === undefined) continue;
            const nid = rid(o[end]) || normalizeCanvasId(o[end]);
            if (!nid || !(await endpointReal(nid, live, board.zones, sharedRoot))) { bad = o[end]; break; }
            nb[end] = nid;
          }
          if (bad) { fail(`新端点不在板上也不是存在的路径：${bad}`); continue; }
          if (nb.from === nb.to) { fail('改完两端相同（自环）'); continue; }
          bindings[o.id] = nb; liveBindings[o.id] = nb; ok += 1;
        } else if (o.op === 'remove_edge') {
          if (!liveBindings[o.id]) { fail(`线 ${o.id} 不存在`); continue; }
          bindings[o.id] = null; delete liveBindings[o.id]; ok += 1;
        } else if (o.op === 'reflow') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.tag && Number.isFinite(e?.x) && e.kind !== 'scribble');
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const horizontal = o.layout === 'row';
          const sorted = members.map(([id, e]) => ({ id, e, r: rectOf(id) }))
            .sort((a, b) => (horizontal ? a.r.x - b.r.x || a.r.y - b.r.y : a.r.y - b.r.y || a.r.x - b.r.x));
          const skipped = [];
          const left = Math.min(...sorted.map(m => m.r.x));
          const top = Math.min(...sorted.map(m => m.r.y));
          let cur = horizontal ? left : top;
          for (const m of sorted) {
            if (m.e.seat === 'user') { skipped.push(m.id); cur = horizontal ? Math.max(cur, m.r.x + m.r.w + 16) : Math.max(cur, m.r.y + m.r.h + 16); continue; }
            const nx = horizontal ? cur : left;
            const ny = horizontal ? top : cur;
            if (nx !== m.e.x || ny !== m.e.y) setObj(m.id, { ...m.e, x: Math.round(nx), y: Math.round(ny) });
            cur += (horizontal ? m.r.w : m.r.h) + 16;
          }
          if (skipped.length) report.push(`· #${i + 1} reflow: 跳过用户拖过的 ${skipped.length} 件`);
          ok += 1;
        } else if (o.op === 'follow') {
          const members = Object.entries(live).filter(([, e]) => e.tag === o.group_tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.group_tag} 的东西`); continue; }
          const targets = Object.entries(live).filter(([, e]) => e.tag === o.target_tag && Number.isFinite(e?.x));
          if (!targets.length) { fail(`目标 tag #${o.target_tag} 板上还没有东西`); continue; }
          const from = members.sort((a, b) => a[1].y - b[1].y)[0][0];   // 组里最上面那件当代表
          const to = targets.sort((a, b) => (a[1].y + (a[1].h || 0)) - (b[1].y + (b[1].h || 0))).pop()[0];   // 最下面 = 最新
          if (from === to) { fail('组代表和目标是同一件（group_tag/target_tag 传反了？）'); continue; }
          const existing = Object.entries(liveBindings).find(([, b]) => b.follow === o.target_tag && live[b.from]?.tag === o.group_tag);
          const id = existing ? existing[0] : `b:a${stamp()}`;
          const binding = { type: 'annotates', from, to, by, label: o.label || '跟随', follow: o.target_tag, ...(o.side ? { followSide: o.side } : {}) };
          bindings[id] = binding; liveBindings[id] = binding; ok += 1;
          // 立规则的同时把组摆到目标旁边：之后的跟随是**平移**（保留相对格局），
          // 基线偏移必须在此刻就有意义 —— 不摆的话组停在原地，平移只是搬运一个
          // 无意义的初始偏移（08-25 平移跟随改造时补）
          {
            const r = rectOf(to);
            const memberIds = new Set(members.map(([mid]) => mid));
            const zone = layerOf(to, live[to], known);
            const rects = members.map(([mid]) => rectOf(mid));
            const bb = {
              x: Math.min(...rects.map(x => x.x)), y: Math.min(...rects.map(x => x.y)),
              w: Math.max(...rects.map(x => x.x + x.w)) - Math.min(...rects.map(x => x.x)),
              h: Math.max(...rects.map(x => x.y + x.h)) - Math.min(...rects.map(x => x.y)),
            };
            const obstacles = Object.entries(live)
              .filter(([oid2, e2]) => !memberIds.has(oid2) && oid2 !== to && Number.isFinite(e2?.x) && layerOf(oid2, e2, known) === zone)
              .map(([oid2, e2]) => ({ x: e2.x, y: e2.y, ...estimateSizeOn(board, oid2, e2) }));
            const pp = resolvePlacement({ box: { w: bb.w, h: bb.h }, anchor: r, side: o.side || 'right', obstacles, contentBottom: 0 });
            const mdx = Math.round(pp.x - bb.x); const mdy = Math.round(pp.y - bb.y);
            if (mdx || mdy) for (const [mid, me] of members) setObj(mid, { ...me, x: me.x + mdx, y: me.y + mdy, seat: 'agent' });
          }
          report.push(`· follow：#${o.group_tag} 已摆到目标旁并从此跟着 #${o.target_tag} 的最新一件（整组平移，用户摆的相对位置保留）`);
        } else if (o.op === 'unfollow') {
          const hits = Object.entries(liveBindings).filter(([, b]) => b.follow && live[b.from]?.tag === o.group_tag);
          if (!hits.length) { fail(`#${o.group_tag} 没有跟随线`); continue; }
          for (const [id] of hits) { bindings[id] = null; delete liveBindings[id]; }
          ok += 1;
        } else if (o.op === 'commit') {
          const { committed: n } = await commitStaging(projectId, { tag: o.tag || null });
          committed += n; ok += 1;
          report.push(`· commit：落定 ${n} 件`);
        } else if (o.op === 'erase_group') {
          const { removed } = await removeByTag(projectId, o.tag);
          erased += removed; ok += 1;
          for (const id of Object.keys(live)) if (live[id]?.tag === o.tag && live[id]?.kind) delete live[id];
          report.push(`· erase_group #${o.tag}：擦掉 ${removed} 件`);
        } else if (o.op === 'feature') {
          const id = rid(o.id) || normalizeCanvasId(o.id);
          if (!id) { fail(`${o.id} 不合法`); continue; }
          heroPatch = id; ok += 1;
        } else if (o.op === 'unfeature') {
          heroPatch = null; ok += 1;
        } else if (o.op === 'chalk_edit') {
          // 改板书开关（08-25 用户提：黑板 RP 这类板书密集会话该由 agent 帮忙打开）。
          // 存 ui-config（重开页面还在），并广播给开着的前端当场生效。
          const cfg = (await readUiConfigFile(sharedRoot)) || {};
          await writeUiConfig(sharedRoot, { ...cfg, chalk_edit: !!o.on });
          try { ctx?.emit?.({ type: 'ui.chalk_edit', sessionId: null, on: !!o.on }); } catch { /* */ }
          report.push(`· 改板书开关 → ${o.on ? '开（用户现在可直接拖动/编辑板书）' : '关'}`);
          ok += 1;
        }
      } catch (e) { fail(String(e?.message || e).slice(0, 120)); }
    }
    if (!ok) return err(`没有一条操作成功：\n${report.join('\n')}`);
    if (Object.keys(objects).length || Object.keys(bindings).length || heroPatch !== undefined) {
      await patchBoard(projectId, { objects, bindings, ...(heroPatch !== undefined ? { hero: heroPatch } : {}) });
    }
    // 软删进 .nd/trash/（08-25：删掉的板书要捞得回来，别裸 unlink）
    for (const abs of chalkUnlinks) await trashChalkFile(sharedRoot, abs);
    try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `改了黑板（${ok} 处）` }); } catch { /* */ }
    return { content: [{ type: 'text', text: `Applied ${ok}/${ops.length} op(s).${report.length ? `\n${report.join('\n')}` : ''}` }] };
  };
}

/** arrange_on_board 薄别名（原 schema 原语义，转发进共享实现） */
export function makeArrangeOnBoardAlias({ projectId, sharedRoot, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, ctx });
  return tool(
    'arrange_on_board',
    'Deprecated alias — use edit_board: move{id,to:{ref,side}} / feature / unfeature.',
    {
      action: z.enum(['beside', 'below', 'feature', 'unfeature']),
      subject: z.string().min(1).max(300).optional(),
      anchor: z.string().min(1).max(300).optional(),
    },
    // ⚠️ 别名把入参转成 ops 交给同一个 handler —— **extra 要跟着走**（署名从它查）。
    // 今天这三个 op 不写 by 所以看不出病，但形状是雷：哪天 move/feature 也要署名就静默错。
    async ({ action, subject, anchor }, extra) => {
      if (action === 'unfeature') return handler({ ops: [{ op: 'unfeature' }] }, extra);
      if (!subject) return { content: [{ type: 'text', text: 'subject required.' }], isError: true };
      if (action === 'feature') return handler({ ops: [{ op: 'feature', id: subject }] }, extra);
      if (!anchor) return { content: [{ type: 'text', text: 'beside/below 需要 anchor。' }], isError: true };
      return handler({ ops: [{ op: 'move', id: subject, to: { ref: anchor, side: action === 'beside' ? 'right' : 'below' } }] }, extra);
    },
  );
}

/** relate_on_board 薄别名（原 schema，转发 add_edge；端点校验在共享实现里） */
export function makeRelateOnBoardAlias({ projectId, sharedRoot, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, ctx });
  const VOCAB = BINDING_TYPE_IDS
    .map(id => `- ${id} (${BINDING_TYPES[id].label})${BINDING_TYPES[id].directed ? '' : ' — undirected'}`)
    .join('\n');
  return tool(
    'relate_on_board',
    `Draw a relationship line between two things on the canvas. Endpoints are canvas ids
(kind prefix + workspace-relative path). Types:\n${VOCAB}\nOnly record relationships not
obvious from where files live. (Alias of edit_board add_edge.)`,
    {
      type: z.enum(BINDING_TYPE_IDS),
      from: z.string().min(1).max(300),
      to: z.string().min(1).max(300),
      label: z.string().max(60).optional(),
      material: z.enum(BINDING_MATERIALS).optional(),
    },
    // ⚠️ relate_on_board 在**角色工具白名单里**：extra 漏了的话，角色画的每条线都署 'agent'
    async ({ type, from, to, label, material }, extra) => {
      const r = await handler({ ops: [{ op: 'add_edge', from, to, type, ...(label ? { label } : {}), ...(material ? { material } : {}) }] }, extra);
      if (!r.isError && ctx?.emit) {
        try { ctx.emit({ type: 'board.updated', sessionId: null, summary: `已画一条「${BINDING_TYPES[type].label}」关系` }); } catch { /* */ }
      }
      return r;
    },
  );
}
