/**
 * mcp/tools/edit-board.js —— edit_board（2026-08-25 范式重做③）
 *
 * 改板的唯一入口。前身 edit_sketch，08-25 这一刀吞进四件；旧名薄别名 08-28 全部
 * 收摊（exp 不为过去的会话背兼容，用户拍板）：
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
 * 位置永远是相对表达（{ref,side,gap} 或位移 {dx,dy}），落到哪一格由服务端解析。
 * 距离单位一律像素（08-29；此前是格，见下面 GAP/PX_DELTA 那段的账）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { z } from 'zod';
import { readBoard, patchBoard, chalkAbsPath, TEXT_FONTS } from '../../../projects/board-store.js';
import { commitStaging, removeByTag, clearTags } from '../../../projects/board-tags.js';
import { estimateSizeOn, FOLDER_CARD } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId, tagEnvelope, bareTag } from '../../../lib/canvas-id.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { UNIT, textBox, shapePath } from '../../../lib/sketch-layout.js';
import { placeBeside, placeAtOnSheet, overlapIds, currentSheet, isInk } from '../../../lib/board-sheets.js';
import { makeEditPlacer } from './edit-board-place.js';
import { applyUiOp } from './edit-board-ui-ops.js';
import { applyReplan } from './sheet-replan.js';
import { transformGroup } from '../../../lib/board-transform.js';
import { OP, EDIT_BOARD_DESC } from './edit-board-schema.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { currentSheetIdOf } from '../../../lib/sheet-state.js';
import { rewriteChalkBody } from '../../../lib/chalk-rewrite.js';
import { CHALK_DIR, trashChalkFile, parseChalk, renderChalk } from '../../../lib/chalk.js';

const MAX_OPS = 120;
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/**
 * 距离一律**像素**（2026-08-29 改口径）。原来 gap/dx/dy 是格（1 格 24px），配了一层
 * 「大于上限的按像素收编」的垫片 —— 于是同一个字段小数当格、大数当像素，中间那段
 * 静默错 24 倍：真会话里 agent 想左移 120px 写了 dx:-120，实际挪了 2880px，再写
 * dx:7000（这次按像素算）往回捞，四发才收敛（proj_mtdr2xpa 03:09）。
 *
 * agent 读到的每一个位置都是像素（read_board / look_at_board / 落位回执全是），
 * 让它写位移时换算成格，是给一件没有收益的事发一张必错的许可证。格只留在起草图
 * （write_on_board 的 nodes[].at）那种「从零排版面」的场合。
 *
 * 超范围的值**钳住不拒收**（08-27 那条教训留着）：schema 校验是整单拒，一个越界的
 * gap 会陪葬同批全部合法 op —— 代价远大于把它按到上限。
 */

export function makeEditBoardTool({ projectId, sharedRoot, sessionId = null, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  return tool(
    'edit_board',
    EDIT_BOARD_DESC,
    {
      tag: z.string().max(40).optional().describe('Default tag for add_node/add_edge (the group you are editing)'),
      ops: z.array(OP).min(1).max(MAX_OPS),
    },
    handler,
  );
}

/** 端点存在性（add_edge/set_edge 共用；08-28 起 write_on_board 的图内边也用它 ——
 *  两个入口对「悬空边」的容忍度曾不对称）：板上有座位 / zones 命中 / 磁盘上真有这个路径。 */
export async function endpointReal(id, live, zones, sharedRoot) {
  if (live[id]) return true;
  if (zones && zones[id] !== undefined) return true;
  // （doc: 无条件放行分支 08-27 审计拆除：doc:brand/_root 已于 08-24 退役，全仓
  //   无写方；留着它,手滑把 docx: 打成 doc: 就能绕过存在性闸产出悬空线）
  if (!sharedRoot) return false;
  const bare = id.replace(/^(deck|site|docx|text|scribble):/, '');
  if (!bare || bare.includes('..')) return false;
  try { await fs.access(path.join(sharedRoot, bare)); return true; } catch { return false; }
}

function makeHandler({ projectId, sharedRoot, sessionId = null, ctx }) {
  return async ({ tag: defaultTag, ops }, extra) => {
    // 署名按调用者（常驻角色改板时署它的名）——见 mcp/actor.js
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId) return err('No project bound.');
    const board = await readBoard(projectId);
    const known = new Set(Object.keys(board.zones || {}));
    const objects = {}; const bindings = {};      // 增量 patch
    const rolls = {};                              // 卷（收纳器）：tag → {at,by,label}|null
    const follows = {};                            // 跟随规则增量：组tag → {target,side?,label?}|null
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
      if (c && isZone(c)) return c;          // 文件夹卡（刀 G）
      const l = byLid(raw);
      if (l) return l;
      // tag 兜底（2026-08-30）：`ref:"状态板"` / `ref:"#状态板"` 是很自然的写法，
      // 而 tag 本来就是"一片东西的名字"。取包络里最右那件当代表，跟 near 同一条规则。
      const env = tagEnvelope({ objects: live }, raw, (id, e) => estimateSizeOn(board, id, e));
      return env ? env.anchorId : null;
    };
    const report = []; let ok = 0;
    const tagTouched = [];                         // set_tag 这一趟碰过的 [id, tag]（落盘后触发跟随）
    const untag = [];                              // set_tag{tag:''} 要摘的（合并语义表达不了删键，走专用路）
    const setObj = (id, e) => { live[id] = e; objects[id] = e; };
    /**
     * 文件夹（board.zones）也进摆位系统（2026-08-30 刀 G）。
     *
     * 在此之前 agent **完全没有摆文件夹的手**：move 走 `live`（= board.objects），
     * 文件夹住 board.zones，rid() 永远查不到它，报错还是「不在板上」。位置全由前端
     * newStackedZoneRect 一行行码在桌面上，跟纸毫无关系 —— 站主原话「甚至包括
     * 文件夹..都需要 agent 规划之后放置在对应位置上」。
     * 尺寸取 FOLDER_CARD（前端同一个常量，board-kind-sizes 里有 parity 测试钉着）。
     */
    const liveZones = { ...(board.zones || {}) };
    const zonesPatch = {};
    const sheetsPatch = {};                        // replan：纸的版位增改
    const isZone = (id) => Object.prototype.hasOwnProperty.call(liveZones, id);
    const setZone = (id, z) => { liveZones[id] = z; zonesPatch[id] = z; };
    // 落位四件（rectOf / obstaclesNear / placeRel / placeAbs）2026-09-01 迁去
    // edit-board-place.js —— 行数棘轮，切口同 write-on-board-place 那个工厂
    const { rectOf, obstaclesNear, placeRel, placeAbs } =
      makeEditPlacer({ board, live, liveZones, known, sessionId, rid, isZone });
    /** 贴身记号跟随（08-27 shapes 编辑面）：挪一件东西时，圈着它的涂鸦一起走。
     *  except = 这次已经被挪过的 id 集（整组拖时组员别被挪两次）。 */
    const moveHuggers = (nodeId, dx, dy, except = null) => {
      if (!dx && !dy) return;
      for (const [hid, he] of Object.entries(live)) {
        if (he?.hug !== nodeId || he.kind !== 'scribble') continue;
        if (except?.has(hid)) continue;
        setObj(hid, { ...he, x: he.x + dx, y: he.y + dy });
      }
    };

    for (let i = 0; i < ops.length; i += 1) {
      const o = ops[i];
      const fail = (why) => report.push(`✗ #${i + 1} ${o.op}: ${why}`);
      try {
        if (o.op === 'set_text') {
          const id = rid(o.id); const e = id && live[id];
          // 板书正门（08-27）：set_text 也认板书**文件** —— 改字不再要求重画/绕道
          // Edit。笔权按作者判：只有作者本人能改自己的话（接续权闸的同一条纪律，
          // 角色因此第一次拥有了改自己板书的手）。
          if (e && !e.kind && id.startsWith(`${CHALK_DIR}/`)) {
            if ((e.by || 'agent') !== by) { fail(`这条板书是「${e.by || 'agent'}」写的，笔权在它 —— 想让它改，寄 cue（SendMessage）或让用户直接说。`); continue; }
            if (!o.text) { fail('改板书给 text（字号/字体/颜色是画布原生节点的旋钮，板书没有）'); continue; }
            const abs = chalkAbsPath(projectId, id);
            if (!abs) { fail(`${id} 的文件路径解析不了`); continue; }
            // 落盘 + 量高收成一份（lib/chalk-rewrite.js，2026-08-30）：set_vars 做的是
            // 同一件事，抄第二份必然漏掉「用户拖出来的留白留得住」那条 —— 三条语义里
            // 只有它漏了不报错，只是用户的排版悄悄没了。
            let box2;
            try { box2 = await rewriteChalkBody(abs, o.text, e); } catch (ex) {
              fail(ex?.code === 'STATE_TABLE' ? `⛔ ${ex.message}` : `${id} 文件读不到（磁盘上已无此路径？）`); continue;
            }
            setObj(id, { ...e, w: box2.w, h: box2.h }); ok += 1;
            report.push(`· #${i + 1} set_text 重写了板书 ${id} 的正文（线/标注/座位全保留）`);
            continue;
          }
          if (!e || e.kind !== 'text') { fail(`${o.id} 不是文字节点，也不是你的板书文件`); continue; }
          const data = { ...e.data };
          if (o.text) data.t = o.text;
          if (o.format) { if (o.format === 'md') data.format = 'md'; else delete data.format; }
          if (o.size) data.size = o.size; if (o.color) data.color = o.color; if (o.font && TEXT_FONTS.includes(o.font)) data.font = o.font;
          const box = textBox(data.t, data.size || 'md', { md: data.format === 'md' });
          setObj(id, { ...e, data, w: box.w, h: box.h }); ok += 1;
        } else if (o.op === 'move') {
          const id = rid(o.id); const e = id && live[id];
          // 文件夹卡走自己的分支：它只有坐标，没有 by/seat/tag 那一套（刀 G）
          if (!e && id && isZone(id)) {
            const box = rectOf(id);
            let p = null;
            if ('ref' in o.to) { p = placeRel(id, box, o.to); if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; } }
            else if ('x' in o.to) { p = placeAbs(o.to, box); if (!p) { fail(o.to.sheet ? `纸 ${o.to.sheet} 不存在（read_board 看纸的清单）` : '还没有铺过纸 —— 先 open_sheet，或用 {dx,dy}/{ref,side}'); continue; } }
            else { p = { x: box.x + (o.to.dx || 0), y: box.y + (o.to.dy || 0) }; }
            setZone(id, { x: Math.round(p.x), y: Math.round(p.y) });
            ok += 1;
            report.push(`· #${i + 1} move 文件夹「${id}」→ (${Math.round(p.x)},${Math.round(p.y)})${p.pressed?.length ? `（⚠ 压住了 ${p.pressed.slice(0, 3).join('、')}）` : ''}`);
            continue;
          }
          if (!e) { fail(`${o.id} 不在板上`); continue; }
          // seat:'user' 08-28 从「冻结」放开（用户拍板"全部放开试试"）：排位引擎
          // 已经能按用户手感排（inferFlowDir 学票、自动挑侧），硬拒的最大受害者
          // 是用户自己（"帮我挪一下"被 agent 顶回"你自己拖"）。放开但**如实报**：
          // 挪的是他亲手摆的东西，agent 得心里有数、他不认可拖回去就是。
          const wasUser = e.seat === 'user' ? '（原是用户亲手摆的，已挪 —— 他不认可会拖回去）' : '';
          const box = rectOf(id);
          if ('ref' in o.to) {
            const p = placeRel(id, box, o.to);
            if (!p) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            // 贴到谁旁边就归谁那一页（2026-09-01 叠纸刀 1）：「摆在它旁边」在
            // 一摞叠着的纸上只有一种讲得通的意思，就是跟它同一页
            // ⛔ 只有墨认领页（isInk）：产物 / 站点卡不参与叠放，翻到哪一页都看得见
            const refSheet = isInk(id, e) ? live[rid(o.to.ref)]?.sheet : null;
            setObj(id, { ...e, x: Math.round(p.x), y: Math.round(p.y), seat: 'agent', ...(refSheet ? { sheet: refSheet } : {}) });
            moveHuggers(id, Math.round(p.x) - e.x, Math.round(p.y) - e.y);
            report.push(`· #${i + 1} move → (${Math.round(p.x)},${Math.round(p.y)})${p.pressed?.length ? `（⚠ 压住了 ${p.pressed.slice(0, 3).join('、')}）` : ''}${wasUser}`);
          } else if ('x' in o.to) {
            const p = placeAbs(o.to, box);
            if (!p) { fail(o.to.sheet ? `纸 ${o.to.sheet} 不存在（read_board 看纸的清单）` : '还没有铺过纸 —— 先 open_sheet，或用 {dx,dy}/{ref,side}'); continue; }
            // 挪到纸内坐标 = 认领那一页（叠纸刀 1）。⛔ 只有墨认领：产物不参与叠放
            const claim = isInk(id, e) ? p.sheetId : null;
            setObj(id, { ...e, x: p.x, y: p.y, seat: 'agent', ...(claim ? { sheet: claim } : {}) });
            moveHuggers(id, p.x - e.x, p.y - e.y);
            report.push(`· #${i + 1} move → 纸 ${p.sheetId} (${p.x},${p.y})${p.clamped ? '（越界，钳进了版心）' : ''}${wasUser}`);
          } else {
            const nx = Math.round(e.x + o.to.dx); const ny = Math.round(e.y + o.to.dy);
            setObj(id, { ...e, x: nx, y: ny, seat: 'agent' });
            moveHuggers(id, nx - e.x, ny - e.y);
            report.push(`· #${i + 1} move → (${nx},${ny})${wasUser}`);
          }
          ok += 1;
        } else if (o.op === 'move_group') {
          const members = Object.entries(live).filter(([, e]) => e.tag === bareTag(o.tag) && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const bb = { x: Math.min(...members.map(([, e]) => e.x)), y: Math.min(...members.map(([, e]) => e.y)) };
          const rects = members.map(([id]) => rectOf(id));
          const w = Math.max(...rects.map(r => r.x + r.w)) - bb.x; const h = Math.max(...rects.map(r => r.y + r.h)) - bb.y;
          let p; let pressed = [];
          if ('ref' in o.to) {
            const refId = rid(o.to.ref);
            const r = rectOf(refId);
            if (!r) { fail(`参照 ${o.to.ref} 不在板上`); continue; }
            const zone = layerOf(refId, live[refId], known);
            const memberIds = new Set(members.map(([id]) => id));
            p = placeBeside(r, { w, h }, o.to.side, o.to.gap ?? UNIT);
            pressed = overlapIds({ x: p.x, y: p.y, w, h }, obstaclesNear(zone, memberIds));
          } else if ('x' in o.to) {
            const pa = placeAbs(o.to, { w, h });
            if (!pa) { fail(o.to.sheet ? `纸 ${o.to.sheet} 不存在` : '还没有铺过纸 —— 先 open_sheet，或用 {dx,dy}/{ref,side}'); continue; }
            p = pa;
          } else {
            p = { x: bb.x + o.to.dx, y: bb.y + o.to.dy };
          }
          const dx = Math.round(p.x - bb.x); const dy = Math.round(p.y - bb.y);
          // 08-28 放开：user 座随组平移（相对格局原样保留，学 follow 平移跟随的先例）
          // —— 旧行为跳过用户件会把组撕开留一半在原地，那才是最丑的结果。如实报件数。
          const userSeated = members.filter(([, e]) => e.seat === 'user').map(([id]) => id);
          const movedSet = new Set(members.map(([id]) => id));
          for (const [id, e] of members) setObj(id, { ...e, x: e.x + dx, y: e.y + dy, ...(e.seat === 'user' ? {} : { seat: 'agent' }) });
          for (const [id] of members) moveHuggers(id, dx, dy, movedSet);
          if (userSeated.length) report.push(`· #${i + 1} move_group: 含用户亲手摆的 ${userSeated.length} 件（随组平移，相对格局保留）`);
          report.push(`· #${i + 1} move_group #${o.tag} → 组左上 (${Math.round(p.x)},${Math.round(p.y)})${pressed.length ? `（⚠ 压住了 ${pressed.slice(0, 3).join('、')}）` : ''}${p.clamped ? '（越界，钳进了版心）' : ''}`);
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
        } else if (o.op === 'add_shape') {
          // 事后圈重点（08-27 shapes 编辑面）：给**已在板上**的东西补一个手画记号。
          // hug 让它跟着目标走 —— 之前画完的圈是死的，目标一挪就散架。
          const refId = rid(o.around); const r = refId && rectOf(refId);
          if (!r) { fail(`around ${o.around} 不在板上`); continue; }
          const seed = `${refId}:m${stamp()}`;
          let sp; let ent;
          if (o.kind === 'underline') {
            sp = shapePath('underline', { to: { x: Math.max(8, r.w - 4), y: 0 } }, seed);
            ent = { x: Math.round(r.x + 2 - 6), y: Math.round(r.y + r.h - 2 - 6) };
          } else {
            const padPx = o.kind === 'rect' ? 8 : 14;
            let bx = { x: r.x - padPx, y: r.y - padPx, w: r.w + padPx * 2, h: r.h + padPx * 2 };
            if (o.kind === 'circle') { const dmax = Math.max(bx.w, bx.h); bx = { x: bx.x + (bx.w - dmax) / 2, y: bx.y + (bx.h - dmax) / 2, w: dmax, h: dmax }; }
            sp = shapePath(o.kind, { w: bx.w, h: bx.h }, seed);
            ent = { x: Math.round(bx.x - 6), y: Math.round(bx.y - 6) };
          }
          const sid = `scribble:a${stamp()}`;
          const tag2 = o.tag || defaultTag || live[refId]?.tag || null;
          setObj(sid, {
            ...ent, z: 1, w: Math.round(sp.w), h: Math.round(sp.h), kind: 'scribble',
            data: { d: sp.d, color: o.color || 'ink', width: o.width || 2 },
            by, seat: 'agent', hug: refId,
            ...(tag2 ? { tag: tag2 } : {}),
            zone: layerOf(refId, live[refId], known) || '',
          });
          report.push(`· #${i + 1} add_shape ${o.kind} 圈住 ${refId}（id ${sid}，会跟着它走）`);
          ok += 1;
        } else if (o.op === 'set_shape') {
          const id = rid(o.id); const e = id && live[id];
          if (!e || e.kind !== 'scribble') { fail(`${o.id} 不是手画记号（scribble）`); continue; }
          const data = { ...e.data };
          if (o.color) data.color = o.color;
          if (o.width) data.width = o.width;
          setObj(id, { ...e, data }); ok += 1;
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
          const members = Object.entries(live).filter(([, e]) => e.tag === bareTag(o.tag) && Number.isFinite(e?.x) && e.kind !== 'scribble');
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const horizontal = o.layout === 'row';
          const sorted = members.map(([id, e]) => ({ id, e, r: rectOf(id) }))
            .sort((a, b) => (horizontal ? a.r.x - b.r.x || a.r.y - b.r.y : a.r.y - b.r.y || a.r.x - b.r.x));
          // 08-28 放开：user 座也进重排 —— 调 reflow 本来就是明确的"求结构"，
          // 排序按现位置来，用户挑的**顺序**天然保留（他拖到中间的还在中间）。如实报件数。
          const userSeated = sorted.filter(m => m.e.seat === 'user').map(m => m.id);
          const left = Math.min(...sorted.map(m => m.r.x));
          const top = Math.min(...sorted.map(m => m.r.y));
          let cur = horizontal ? left : top;
          for (const m of sorted) {
            const nx = horizontal ? cur : left;
            const ny = horizontal ? top : cur;
            if (nx !== m.e.x || ny !== m.e.y) {
              setObj(m.id, { ...m.e, x: Math.round(nx), y: Math.round(ny) });
              // 圈着这个节点的记号跟着走 —— reflow 之前的病：文字重排、圈留在原地
              moveHuggers(m.id, Math.round(nx) - m.e.x, Math.round(ny) - m.e.y);
            }
            cur += (horizontal ? m.r.w : m.r.h) + 16;
          }
          if (userSeated.length) report.push(`· #${i + 1} reflow: 含用户拖过的 ${userSeated.length} 件（顺序按他摆的保留）`);
          ok += 1;
        } else if (o.op === 'follow') {
          const gTag = bareTag(o.group_tag); const tTag = bareTag(o.target_tag);
          const members = Object.entries(live).filter(([, e]) => e.tag === gTag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.group_tag} 的东西`); continue; }
          // 规则先立下（2026-08-30）：follow 是**一条规则**，不是一条线。目标 tag 现在
          // 空着不是错 —— skill 教的顺序就是「开场画状态板 → 立跟随 → 写第一章」，
          // 而线要求两端此刻都在板上，于是这条最自然的写法过去必炸（全库 5 次 / 4 个
          // 项目）。规则落进 board.follows，第一件带该 tag 的东西一落，applyFollows
          // 顺手把线接上。
          follows[gTag] = { target: tTag, ...(o.side ? { side: o.side } : {}), ...(o.label ? { label: o.label } : {}) };
          const targets = Object.entries(live).filter(([, e]) => e.tag === tTag && Number.isFinite(e?.x));
          if (!targets.length) {
            ok += 1;
            report.push(`· follow：规则立好了 —— #${gTag} 从此跟着 #${tTag} 的最新一件。`
              + `#${tTag} 板上还没有东西，等第一件落下来自动接线并就位（不用再调一次）`);
            continue;
          }
          const from = members.sort((a, b) => a[1].y - b[1].y)[0][0];   // 组里最上面那件当代表
          const to = targets.sort((a, b) => (a[1].y + (a[1].h || 0)) - (b[1].y + (b[1].h || 0))).pop()[0];   // 最下面 = 最新
          if (from === to) { fail('组代表和目标是同一件（group_tag/target_tag 传反了？）'); continue; }
          const existing = Object.entries(liveBindings).find(([, b]) => b.follow === bareTag(o.target_tag) && live[b.from]?.tag === bareTag(o.group_tag));
          const id = existing ? existing[0] : `b:a${stamp()}`;
          const binding = { type: 'annotates', from, to, by, label: o.label || '跟随', follow: bareTag(o.target_tag), ...(o.side ? { followSide: o.side } : {}) };
          bindings[id] = binding; liveBindings[id] = binding; ok += 1;
          // 立规则的同时把组摆到目标旁边：之后的跟随是**平移**（保留相对格局），
          // 基线偏移必须在此刻就有意义 —— 不摆的话组停在原地，平移只是搬运一个
          // 无意义的初始偏移（08-25 平移跟随改造时补）。
          // ⭐ 除非 agent 明说"现在这个位置就是我要的偏移"→ keep_offset（见下）。
          /**
           * `keep_offset: true` = **第一跳也不动它**（2026-08-31 站主提「纯方向相对
           * 且平行的移动，距离不再固定，不主动拉近和拉远」）。
           *
           * 跟随本来就是平移：第二跳起照搬「新目标 − 旧目标」的位移，相对位置一格
           * 不差。唯一会改变距离的是**第一跳** —— 那时还没有"上一个目标"可参照，
           * 只能贴到 side 那一侧定出一个初始偏移。keep_offset 就是说"现在这个位置
           * 就是我要的偏移，别帮我摆"。
           */
          if (o.keep_offset) {
            report.push(`· follow：#${o.group_tag} 原地不动，从此按现在这个相对位置跟着 #${o.target_tag} 的最新一件`);
          } else {
            const r = rectOf(to);
            const memberIds = new Set(members.map(([mid]) => mid));
            const zone = layerOf(to, live[to], known);
            const rects = members.map(([mid]) => rectOf(mid));
            const bb = {
              x: Math.min(...rects.map(x => x.x)), y: Math.min(...rects.map(x => x.y)),
              w: Math.max(...rects.map(x => x.x + x.w)) - Math.min(...rects.map(x => x.x)),
              h: Math.max(...rects.map(x => x.y + x.h)) - Math.min(...rects.map(x => x.y)),
            };
            void zone;
            const pp = placeBeside(r, { w: bb.w, h: bb.h }, o.side || 'right', UNIT);
            const mdx = Math.round(pp.x - bb.x); const mdy = Math.round(pp.y - bb.y);
            if (mdx || mdy) for (const [mid, me] of members) setObj(mid, { ...me, x: me.x + mdx, y: me.y + mdy, seat: 'agent' });
            report.push(`· follow：#${o.group_tag} 已摆到目标旁并从此跟着 #${o.target_tag} 的最新一件（之后每一跳都是平移，相对位置保留）`);
          }
        } else if (o.op === 'set_tag') {
          /**
           * 给**已经在板上的任何东西**打分组标签（2026-08-31 站主提：「我期望 agent
           * 可以为所有内容（包括图 站点 docx 等）设置 follow」）。
           *
           * 在这之前 tag 只能在**造东西那一刻**给（write_on_board.tag / add_node /
           * add_shape / add_edge / 板书 frontmatter）。产物不是这么来的 —— 图是
           * generate_image 生的、站点是 publish_site 出的、docx 是 build_docx 打的，
           * 落板时一律没有 tag。而 follow 的两端（跟随组 group_tag、目标 target_tag）
           * **都是按 tag 找成员**，所以"给图片设 follow"以前根本无从下手。
           */
          const tag = bareTag(o.tag || '');
          const hit = []; const miss = [];
          for (const raw of o.ids) {
            const id = rid(raw);
            const e = id && live[id];
            if (!e) { miss.push(raw); continue; }
            if (tag) setObj(id, { ...e, tag });
            else { const n = { ...e }; delete n.tag; live[id] = n; untag.push(id); }
            hit.push(id);
          }
          if (!hit.length) { fail(`一件都不在板上：${miss.join('、')}`); continue; }
          ok += 1;
          tagTouched.push(...hit.map(id => [id, tag]));
          report.push(`· #${i + 1} set_tag：${hit.length} 件${tag ? ` → #${tag}` : ' 去掉了标签'}`
            + `${miss.length ? `（${miss.length} 件不在板上：${miss.slice(0, 3).join('、')}）` : ''}`);
        } else if (o.op === 'unfollow') {
          const gTag = bareTag(o.group_tag);
          const hits = Object.entries(liveBindings).filter(([, b]) => b.follow && live[b.from]?.tag === gTag);
          const hadRule = !!board.follows?.[gTag];
          if (!hits.length && !hadRule) { fail(`#${o.group_tag} 没有跟随线`); continue; }
          for (const [id] of hits) { bindings[id] = null; delete liveBindings[id]; }
          follows[gTag] = null;   // 规则也撤 —— 只删线的话下一件落下来它又长回来
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
        } else if (o.op === 'roll') {
          // 收卷（2026-08-27 收纳器）：只立状态位，成员座位一件不动 —— 前端把这组
          // 藏进一张卷卡，展开即归位。视觉/渲染/read_board 三头减负，地皮照旧占着
          //（落位引擎仍把它们当障碍，所以永远不会有新东西压进卷里）。
          const members = Object.entries(live).filter(([, e]) => e?.tag === o.tag && Number.isFinite(e?.x));
          if (!members.length) { fail(`没有 #${o.tag} 的东西，没得收`); continue; }
          if (board.rolls?.[o.tag] && !rolls[o.tag]) {
            report.push(`· #${i + 1} roll：#${o.tag} 本来就收着（${members.length} 件）`); ok += 1; continue;
          }
          rolls[o.tag] = { at: new Date().toISOString(), by, ...(o.label ? { label: o.label } : {}) };
          report.push(`· #${i + 1} roll：#${o.tag} 收进卷里（${members.length} 件，座位和文件都在，卷卡单击可展开）`);
          ok += 1;
        } else if (o.op === 'unroll') {
          if (!board.rolls?.[o.tag] && rolls[o.tag] === undefined) { fail(`#${o.tag} 没收着`); continue; }
          rolls[o.tag] = null;
          report.push(`· #${i + 1} unroll：#${o.tag} 展开，全部归位`);
          ok += 1;
        } else if (o.op === 'feature') {
          const id = rid(o.id) || normalizeCanvasId(o.id);
          if (!id) { fail(`${o.id} 不合法`); continue; }
          heroPatch = id; ok += 1;
        } else if (o.op === 'unfeature') {
          heroPatch = null; ok += 1;
        } else if (o.op === 'transform_group') {
          // 整组缩放/旋转（2026-08-30，拆件见 lib/board-transform.js）：涂鸦真变形，
          // 文字/卡只换座（字号没有"转 30°"的渲染语义，硬转是藏问题）
          if (!o.scale && !o.rotate) { fail('transform_group 要 scale 或 rotate（都不给等于没变）'); continue; }
          const gTag2 = bareTag(o.tag);
          const members = Object.entries(live)
            .filter(([, e]) => e?.tag === gTag2 && Number.isFinite(e?.x))
            .map(([id, e]) => ({ id, entry: e, ...estimateSizeOn(board, id, e) }));
          if (!members.length) { fail(`没有 #${o.tag} 的东西`); continue; }
          const r = transformGroup(members, { scale: o.scale || 1, rotate: o.rotate || 0 });
          for (const [id, e] of Object.entries(r.patch)) setObj(id, e);
          report.push(`· transform_group #${o.tag}：绕组心 (${r.center.x},${r.center.y}) ${o.scale ? `缩放 ${o.scale}×` : ''}${o.rotate ? ` 旋转 ${o.rotate}°` : ''} —— ${r.inked} 件涂鸦真变形${r.seated ? `，${r.seated} 件（文字/卡）只挪了位没变形` : ''}`);
          ok += 1;
        } else if (o.op === 'replan') {
          // 补版位/调版位（刀⑧ 2026-08-30，拆件见 sheet-replan.js）
          const r = applyReplan({ board, sheetsPatch, sessionId, op: o });
          if (r.error) { fail(r.error); continue; }
          sheetsPatch[r.sheetId] = r.entry;
          report.push(r.report);
          ok += 1;
        } else if (o.op === 'show' || o.op === 'chalk_edit') {
          // 不改板、只改看的人那一侧的两个动作 → edit-board-ui-ops.js
          const r = await applyUiOp(o, { board, ctx, sharedRoot });
          if (r.error) { fail(r.error); continue; }
          report.push(r.report);
          ok += 1;
        }
      } catch (e) { fail(String(e?.message || e).slice(0, 120)); }
    }
    if (!ok) return err(`没有一条操作成功：\n${report.join('\n')}`);
    if (Object.keys(objects).length || Object.keys(bindings).length || Object.keys(rolls).length || Object.keys(follows).length || Object.keys(zonesPatch).length || Object.keys(sheetsPatch).length || heroPatch !== undefined) {
      await patchBoard(projectId, {
        objects, bindings,
        ...(Object.keys(zonesPatch).length ? { zones: zonesPatch } : {}),
        ...(Object.keys(sheetsPatch).length ? { sheets: sheetsPatch } : {}),
        ...(Object.keys(rolls).length ? { rolls } : {}),
        ...(Object.keys(follows).length ? { follows } : {}),
        ...(heroPatch !== undefined ? { hero: heroPatch } : {}),
      });
    }
    /**
     * 打完标签就是"这个 tag 有新成员落板"—— 跟 write_on_board 落一条带 tag 的板书
     * 是同一件事，跟随线该在这一刻重指并挪组（2026-08-31）。
     *
     * ⛔ 在这之前 applyFollows 只挂在三处：write_on_board / write_on_board(flow) /
     * board-seater。产物（图 / 站点 / docx）走的是别的路，**永远触发不了跟随** ——
     * 「follow 是所有组件都可用吗」的答案原来是"数据层是、触发层不是"。
     * fail-soft：跟随失败绝不连累这次编辑本身。
     */
    for (const [id, tag] of tagTouched) {
      if (!tag) continue;
      try { await applyFollows(projectId, { tag, newId: id }); } catch { /* */ }
    }
    // 摘标签走专用路（patchBoard 是合并语义，补丁里"没有这个键"≠"删掉这个键"）
    if (untag.length) { try { await clearTags(projectId, untag); } catch { /* fail-soft */ } }
    // 软删进 .nd/trash/（08-25：删掉的板书要捞得回来，别裸 unlink）
    for (const abs of chalkUnlinks) await trashChalkFile(sharedRoot, abs);
    try { ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `改了黑板（${ok} 处）` }); } catch { /* */ }
    return { content: [{ type: 'text', text: `Applied ${ok}/${ops.length} op(s).${report.length ? `\n${report.join('\n')}` : ''}` }] };
  };
}
