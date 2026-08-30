/**
 * mcp/tools/write-on-board.js —— write_on_board 统一入口（2026-08-25 范式重做②；
 * 2026-08-29 纸范式刀 2：落位从启发式引擎换成纸）
 *
 * 总纲（站主拍板）：**一条板书 = 单节点图，是统一模型的退化情形。** 写字入口只有
 * 这一个；本体选什么不由 agent 选、不由入口分，由一条服务端判据自动定 ——
 * **这一次落板的件数（nodes + shapes 合计；text 简写 = 1 件）**：
 *
 *   件数 = 1（一句话）           件数 ≥ 2（一张图）
 *   本体   notes/板书/*.md 真文件   画布原生 text:/scribble: + data.lid
 *   tag    不打（可显式传并组）      必有，缺省自动 sk-<stamp>
 *   staging false                  true（finish 或回合末落定）
 *
 * ## 落位 = 纸（2026-08-29）
 *
 * 旧回路「模糊锚点 + 机器启发式找洞」退役（环搜/挑侧/走廊/学走向全删 —— ㉚ 五刀
 * 证明那一层的坑修不完）。新回路：
 *   - at:{x,y} = **当前纸的版心局部像素**（agent 精确摆放，钳进版心、钳了如实报）
 *   - reply_to/chain = 接楼：正下方（压住跳过），纸写满自动翻下一张
 *   - 什么都不给 = 纸内按阅读序往下排；**排不下就拒收**（08-29 刀 F 起不再替它翻页）
 *   - near = 画线的语义（annotates/flow），不再驱动落位；near+side 显式给时按
 *     精确贴放（题注在上方这类语义要求）
 * 没铺过纸时第一笔自动铺一张（对准用户视口）。文件夹层没有纸：reply/near 照常，
 * at 礼貌拒收。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { byOf } from '../actor.js';
import { readBoard, patchBoard, TEXT_FONTS } from '../../../projects/board-store.js';
import { TAG_RE } from '../../../projects/board-sanitize.js';
import { estimateSizeOn } from '../../../lib/board-kind-sizes.js';
import { layerOf, normalizeCanvasId } from '../../../lib/canvas-id.js';
import { endpointReal } from './edit-board.js';
import { BINDING_TYPE_IDS } from '../../../lib/binding-types.js';
import { UNIT, SKETCH_FIT, SKETCH_MAX, textBox, layoutNodes, resolveTemplate, bboxOrZero, fitFor, capacityOf } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { innerRect } from '../../../lib/board-sheets.js';
import { obstaclesIn } from '../../../lib/board-obstacles.js';
import { makeSheetPlacer } from './write-on-board-place.js';
import { openSheetFor } from './open-sheet.js';
import { buildSketchShapes, SKETCH_COLORS as COLORS } from '../../../lib/sketch-shapes.js';
import { makeAnchorResolver } from '../../../lib/board-anchor.js';
import { getViewpoint } from '../../../projects/viewpoint-store.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../../lib/chalk.js';
import { maybeFlowWrite } from './write-on-board-flow.js';
import { ROLE_SLUG_RE } from '../../agent/cast.js';
import { WRITE_SCHEMA as SCHEMA } from './write-on-board-schema.js';
import { roleDefaultAnchor } from './write-on-board-role-anchor.js';
import { seatArtifacts } from '../../runs/board-seater.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { Events } from '../../agent/events.js';
import { learnedChalkWidth } from '../../../lib/chalk-size-pref.js';

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${(seq++ % 1000).toString(36)}`;

/** md 侦测：正文带 markdown 记号却标 plain 会把 **加粗** 原样吐出来（ldx 案） */
const looksLikeMd = (t) => /(\*\*|__|^#{1,4}\s|^\s*[-*]\s|\|.+\||```|\$[^$]+\$|\[.+\]\(.+\))/m.test(t);


const DESCRIPTION = `Write on the board — the ONE way to put words and pictures on the canvas.
The board is the conversation; the sidebar is the log.

Work happens on SHEETS (open_sheet lays one — a screenful of paper). One thought =
one call. What you pass decides what lands:
- {text} → a single Markdown note. It is a real file (${CHALK_DIR}/…md) you can
  Read/Grep/Edit later. near = what it is about (annotates line). reply_to = thread
  under another note; chain:true = auto-thread onto your latest note of the same tag.
- {nodes, shapes, edges, …} → a whole sketch in one call (comparison table, flow,
  mind map, detective board linking real artifacts). You describe STRUCTURE on a grid
  (1 cell = ${UNIT}px); the server does pixels and hand-drawn shapes. The sketch gets a
  #tag (read/select/erase as a group) and lands as STAGING until commit or turn end.
Placement — sheet coordinates, no guessing:
- at:{x,y} = pixels from the current sheet's top-left writable corner. You OWN the
  layout inside a sheet — place precisely, side by side, wherever reads best.
- no at = flows top-to-bottom on the current sheet; a full sheet turns the page
  automatically. reply_to lands right below the note it answers.
- New topic/chapter → open_sheet first, so each sheet reads as one page.
Threads are tags: {tag, chain:true} continues a line of thought; fork with
{tag:"新名", open_lane:"<id>"} (a fresh sheet is laid for it).
Node text carrying markdown marks defaults to format md (KaTeX $…$ and \`\`\`mermaid fences work).
Readability: user reads at 75–100% zoom — body text md/lg; one sketch fits one sheet.
To change what is already on the board use edit_board — do not redraw.
Keep the chat reply to one line pointing here.`;

export function makeWriteOnBoardTool({ projectId, sharedRoot, sessionId, ctx }) {
  const handler = makeHandler({ projectId, sharedRoot, sessionId, ctx });
  return tool('write_on_board', DESCRIPTION, SCHEMA, handler);
}

function makeHandler({ projectId, sharedRoot, sessionId, ctx }) {
  return async function handler(args, extra) {
    // 署名：主 agent → 'agent'，常驻角色 → 它的 slug。权威是 harness 在派发时盖的章
    // （agent/actor-trail.js），不是角色文件里的自称 —— 那份文件模型能改。
    const by = byOf(extra);
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (!projectId || !sharedRoot) return err('No project bound.');

    const nodesIn = args.nodes || [];
    const shapesIn = args.shapes || [];
    const edgesIn = args.edges || [];
    const hasSketch = nodesIn.length || shapesIn.length;
    if (args.text && hasSketch) {
      return err('text 是"单节点图"的简写，跟 nodes/shapes 二选一：一句话给 text，一张图把它写成一个 node。');
    }
    if (!args.text && !hasSketch) {
      return err('空手不上板：给 text（一句话）或 nodes/shapes（一张图）。只想画线用 edit_board 的 add_edge。');
    }
    // 单节点图 = 一句话（统一模型的退化情形）：转文件本体那条路，语义字段全保
    if (!args.text && !args.title && nodesIn.length === 1 && !shapesIn.length && !edgesIn.length) {
      const n = nodesIn[0];
      // ⚠️ extra 必须往下传：署名是从 extra 里的 toolUseId 查回来的，
      // 这条自递归漏了它的话，角色用 `nodes:[一件]` 写的板会静默署成 'agent'。
      return handler({
        text: n.text, near: args.near, reply_to: args.reply_to, at: args.at, sheet: args.sheet,
        side: args.side, relation: args.relation, chain: args.chain, tag: args.tag, size: n.size, width: n.w,
      }, extra);
    }

    let board = await readBoard(projectId);
    const known = new Set(Object.keys(board.zones || {}));
    // 这一层上谁占着地方（含文件夹卡/卷卡/精灵身位，见 lib/board-obstacles.js）
    const obstaclesOf = (b, zone) => obstaclesIn(b, zone);
    const vp = getViewpoint(projectId);
    const fit = fitFor(vp);
    // 车道封顶（08-28）：触屏档一件不许超过一屏宽。**板书和草图两条路都要过它** ——
    // 只封一条的下场是真会话里量到的：草图乖乖 336，板书照旧 432（判据在 device-lane）。
    // ⛔ 要传 wUnits 不能事后夹 w：textBox 按宽度回推行数算高度，只夹宽＝文字溢出框外且不报错。
    const capUnits = fit.column ? Math.max(4, Math.floor(fit.w / UNIT)) : null;
    const capW = (u) => (capUnits ? Math.min(u || capUnits, capUnits) : u);
    const vpRectFor = (zone) => (vp && (vp.layer || '') === (zone || '') && vp.camera) ? vp.camera : null;
    const visibleIn = (rect, vpRect) => !!vpRect && !(rect.x + rect.w < vpRect.x || vpRect.x + vpRect.w < rect.x
      || rect.y + rect.h < vpRect.y || vpRect.y + vpRect.h < rect.y);

    // 锚点解析（真 id > tag 包络 > 救援入座）本体在 lib/board-anchor.js（棘轮拆件）
    const resolveAnchor = makeAnchorResolver({ projectId, known, readBoard, seatArtifacts });
    // 纸上落位三分支（棘轮拆件，见 write-on-board-place.js）
    const { placeOnSheets, placeInZone, describeSpot, resolveSlot, placeInSlot, describeSheetFull } = makeSheetPlacer({ projectId, sessionId, by });

    // ───────────────────────── 件数 = 1：板书（文件本体） ─────────────────────────
    if (args.text) {
      let body = String(args.text).trim();
      if (!body) return err('空话不上板。');
      // 控件围栏自愈（08-28 泉此方案）：角色把 nd:controls 写成裸文本开头 —— 语义无歧义
      // （正文以 nd:controls 起头且全文无围栏），替它补上，渲染层只认 ```nd:controls
      if (/^nd:controls\s*\n/.test(body) && !body.includes('```')) {
        body = '```nd:controls\n' + body.replace(/^nd:controls\s*\n/, '') + '\n```';
      }
      // 手写字（ink:'hand'，08-27 收编 create_on_board）：线程语义长在板书文件上
      if (args.ink === 'hand' && (args.chain || args.open_lane || args.reply_to)) {
        return err("ink:'hand' 是画布手写字（无文件本体），接不进线程 —— 要 chain/open_lane/reply_to 就用默认的 chalk。");
      }
      // ── 开新线（open_lane）：模型声明拓扑，机器给这条线铺自己的纸 ──
      if (args.open_lane) {
        if (!args.tag) return err('open_lane 要配 tag：tag 就是这条线的名字，后续用 {tag, chain:true} 续。');
        if (args.reply_to || args.chain || args.at || args.near) {
          return err('open_lane 是开新线，跟 reply_to/chain/at/near 互斥 —— 岔出点直接写在 open_lane 里。');
        }
        if (board.lanes?.[args.tag]) {
          return err(`线 #${args.tag} 已经开过了（read_board 的「线的清单」那一节看得到）。接着写用 {tag:"${args.tag}", chain:true}；真要另起炉灶，换个名字。`);
        }
      }
      // chain：接在同 tag 最新一条**自己写的**板书后面（chapter 线程不再手抄路径）。
      // 接续权（2026-08-27 编排）：chain 是「续写我的线程」，永远不跨作者 ——
      // GM 的章节线和每个角色的叙事线各自延各自的，中间插了别人的话也不串线。
      let replyToRaw = args.reply_to || null;
      if (!replyToRaw && args.chain) {
        const chalks = Object.entries(board.objects)
          .filter(([id, e]) => id.startsWith(`${CHALK_DIR}/`) && Number.isFinite(e?.x)
            && (!args.tag || e.tag === args.tag) && (e.by || 'agent') === by)
          .map(([id]) => id).sort();
        if (chalks.length) replyToRaw = chalks[chalks.length - 1];
      }
      // 角色缺省锚（08-28；专线优先、「这一拍」其次，拆件见 write-on-board-role-anchor.js）
      let nearRaw = args.near || null;
      if (args.ink !== 'hand' && !replyToRaw && !nearRaw && !args.at && !args.open_lane
        && ROLE_SLUG_RE.test(by)) {
        const d = await roleDefaultAnchor({ board, by, sharedRoot });
        if (d.replyTo) {
          replyToRaw = d.replyTo;
          if (d.tag && !args.tag) args.tag = d.tag;   // 进线就着线的 tag，下一条才续得上
        }
      }

      // 版位（08-29 刀 E）：解析要在算宽度之前 —— 一块地多宽，写进去的就多宽
      let slotInfo = null;
      if (args.slot) {
        slotInfo = resolveSlot(board, { slotName: args.slot, sheetName: args.sheet || null });
        if (slotInfo.error) return err(slotInfo.message);
      }
      const em = (l) => [...l].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 1 : 0.62), 0);
      const longest = Math.max(...body.split('\n').map(em));
      // 宽度三档回落（2026-08-28）：模型点名 > 用户调出来的偏好 > 按正文估。
      // 中间那档是「模仿用户」：他拖宽过板书就说明这个版心读着舒服，下一拍照做，
      // 别让他反复调同一件事。判据是前端拖手柄盖的 sized:'user' 章，模型盖不出。
      const wUnits = slotInfo
        ? Math.max(4, Math.floor(slotInfo.rect.w / UNIT))
        : capW(args.width || learnedChalkWidth(board)
          || (longest <= 12 ? null : Math.max(12, Math.min(18, Math.ceil(longest * 16 / 24) + 1))));
      let box = textBox(body, args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });
      // 占位（刀⑧ 2026-08-30）：agent 先声明框的高度、再往里流内容 —— 容量检查、
      // 落位、流式预览全按预约框算。内容更高时按真身来（框不许对内容撒谎）。
      if (!args.flow && Number.isFinite(args.h) && args.h > box.h) {
        box = { ...box, h: Math.round(args.h), reserved: true };
      }

      let zone = '';
      let anchorId = null; let parentId = null;
      let replyRect = null; let anchorRect = null;
      let b2 = board;   // 救援入座后换新板（新座要进压上判定）
      // 开新线：岔出点解析（fresh = 无岔出点）
      let laneFrom = null;   // {id, rect} | 'fresh'
      if (args.open_lane) {
        if (args.open_lane === 'fresh') {
          laneFrom = 'fresh';
        } else {
          const a = await resolveAnchor(args.open_lane, board);
          if (!a) {
            return err(`open_lane 的岔出点 ${args.open_lane} 不在板上（read_board 看一眼现在都有谁）。全新话题用 open_lane:'fresh'。`);
          }
          laneFrom = { id: a.anchorId, rect: a.rect };
          zone = a.zone; if (a.board) b2 = a.board;
          // 分支线：岔出点 → 新线头（flow 读序），跟 near 的画线机制共用
          anchorId = a.anchorId; anchorRect = a.rect;
        }
      }
      if (replyToRaw) {
        const pid2 = normalizeCanvasId(replyToRaw);
        const e = pid2 ? board.objects?.[pid2] : null;
        if (!e || !Number.isFinite(e.x)) return err(`reply_to ${replyToRaw} 不在板上（read_board 里看不到就接不上）。`);
        // 接续权（2026-08-27 编排）：角色的话头只有它自己和用户能接。主控接上去
        // 就是代笔/插嘴的物理形态 —— 这条按板上对象的**作者**判，不看内容不看场。
        // 角色之间可以互接（那就是对话），角色接主控的旁白也行。
        if (by === 'agent' && typeof e.by === 'string' && ROLE_SLUG_RE.test(e.by)) {
          return err(`这条是「${e.by}」的话，你不接在它下面。想让它接着说：把 cue 寄给它`
            + `（SendMessage）或让用户直接跟它说；你自己的旁白/场记另起一条（near 指过去就行）。`);
        }
        parentId = pid2; zone = layerOf(pid2, e, known);
        replyRect = { x: e.x, y: e.y, ...estimateSizeOn(board, pid2, e) };
      }
      if (nearRaw) {
        const a = await resolveAnchor(nearRaw, board);
        if (!a && !parentId && !args.at) {
          return err(`锚点 ${nearRaw} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件（read_board 看一眼现在都有谁）。`);
        }
        if (a) { anchorId = a.anchorId; anchorRect = a.rect; if (!parentId) zone = a.zone; if (a.board) b2 = a.board; }
      }

      const obstacles = obstaclesOf(b2, zone);
      const vpRect = vpRectFor(zone);

      // ── flow（刀⑦ 2026-08-30）：长文由机器按段拆成一串卡大小的板书（拆件见
      // write-on-board-flow.js）。返回 null = 用不上（守卫不过/一块就装下），走正常路。
      if (args.flow && args.text) {
        const fr = await maybeFlowWrite({
          projectId, sharedRoot, sessionId, by, ctx, args, body, wUnits, zone,
          slotInfo, parentId, replyRect, anchorId, b2, obstaclesOf,
          placeInSlot, placeOnSheets, describeSheetFull, stamp,
        });
        if (fr) return fr;
      }


      // 卡高上限（08-29 刀 E）：没规划版面时也不许写出一根柱子。执行点在工具层
      // 不在渲染层 —— 折叠/裁切都是替它把问题藏起来，它下一条还会照写。
      if (!slotInfo && box.h > CARD_MAX_H) {
        const c = capacityOf(box.w, CARD_MAX_H);
        return err([
          `⛔ Too long for one card: this needs ${box.h}px, a card holds ${CARD_MAX_H}px (~${c.lines} lines / ~${c.cjk} CJK chars at ${box.w}px wide).`,
          '   Nothing was written. Split it YOUR way: carve a few blocks (open_sheet{plan} / edit_board',
          '   replan — omit at to stack them) and fill one note each, or chain:true a few short notes.',
          '   Lazy fallback: flow:true lets the machine split at paragraph breaks.',
        ].join('\n'));
      }
      let placed;
      if (slotInfo) {
        // 装不下就拒收：什么都不写，把还剩多少报回去让它分块重排（站主拍板）
        const p = placeInSlot(b2, { rect: slotInfo.rect, sheet: slotInfo.sheet, slotName: args.slot, box, obstacles });
        if (p.full) return err(p.message);
        placed = p;
      } else if (zone) {
        if (args.at) return err('at 是纸内坐标，文件夹层没有纸 —— 在文件夹里用 reply_to/near 落位。');
        placed = placeInZone({ box, replyRect, anchorRect, side: args.side || null, obstacles });
      } else if (laneFrom) {
        // 一条线 = 它自己的一叠纸：铺一张以 tag 命名的纸，这条落在纸头
        const opened = await openSheetFor(projectId, {
          sessionId, by, title: args.tag,
          name: TAG_RE.test(args.tag) && !board.sheets?.[args.tag] ? args.tag : null,
        });
        const inner = innerRect(opened);
        placed = { x: inner.x, y: inner.y, resolution: 'lane-open', sheetId: opened.id, opened, pressed: [] };
        b2 = { ...b2, sheets: { ...(b2.sheets || {}), [opened.id]: { x: opened.x, y: opened.y, w: opened.w, h: opened.h, at: opened.at, by } } };
      } else {
        placed = await placeOnSheets(b2, {
          box, at: args.at || null, sheetName: args.sheet || null,
          replyRect, anchorRect, side: args.side || null, obstacles,
        });
        // 纸排满了：不替它翻页，让它自己规划下一页（刀 F，站主"每张纸规划一次"）
        if (placed.sheetFull) return err(describeSheetFull(b2, placed.sheetFull));
        if (placed.opened) b2 = { ...b2, sheets: { ...(b2.sheets || {}), [placed.opened.id]: { x: placed.opened.x, y: placed.opened.y, w: placed.opened.w, h: placed.opened.h, at: placed.opened.at, by } } };
      }

      // ── 手写字本体（ink:'hand'）：画布原生 text 节点，不落文件 ──
      if (args.ink === 'hand') {
        const hid = `text:a${stamp()}`;
        const data = {
          t: body, ...(looksLikeMd(body) ? { format: 'md' } : {}),
          font: TEXT_FONTS.includes(args.font) ? args.font : 'kai',
          size: args.size || 'md', ...(COLORS.includes(args.color) ? { color: args.color } : {}),
        };
        const hObjects = { [hid]: {
          x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
          kind: 'text', data, zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
        } };
        const hBindings = {};
        if (anchorId) {
          const type = args.relation || 'annotates';
          const [from, to] = type === 'flow' ? [anchorId, hid] : [hid, anchorId];
          hBindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
        }
        await patchBoard(projectId, { objects: hObjects, bindings: hBindings });
        const hRect = { x: Math.round(placed.x), y: Math.round(placed.y), w: box.w, h: box.h };
        try {
          ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: '写了一段手写字' });
          ctx?.emit?.(Events.boardFocus(hRect, { tag: args.tag || null, layer: zone, soft: true, actor: by !== 'agent' ? by : null }));
        } catch { /* fail-soft */ }
        return { content: [{ type: 'text', text:
          `Wrote handwritten note ${hid} at (${hRect.x},${hRect.y}) ${hRect.w}x${hRect.h} — ${describeSpot(b2, placed)}.` }] };
      }

      const fileName = chalkFileName(body);
      const content = renderChalk({ body, by, anchor: anchorId, replyTo: parentId, tag: args.tag || null, sessionId: sessionId || null });
      const rel = await writeChalkFile(sharedRoot, fileName, content);

      const objects = { [rel]: {
        x: Math.round(placed.x), y: Math.round(placed.y), z: 1, w: box.w, h: box.h,
        zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
      } };
      const bindings = {};
      if (anchorId) {
        const type = args.relation || (laneFrom ? 'flow' : 'annotates');
        // flow 是读序（旧 → 新）：锚在前板书在后；其余语义都是"这条说的是它"
        const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
        bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
      }
      if (parentId) bindings[`b:a${stamp()}`] = { type: 'flow', from: parentId, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}) };
      await patchBoard(projectId, {
        objects, bindings,
        // 线注册表照旧登记（read_board 的线清单/角色专线都靠它）：登记点 = 这条线的纸
        ...(laneFrom ? { lanes: { [args.tag]: {
          x: Math.round(placed.x), y: Math.round(placed.y), w: box.w,
          ...(laneFrom !== 'fresh' && laneFrom?.id ? { parent: laneFrom.id } : {}),
        } } } : {}),
      });
      // 跟随线：这个 tag 有人跟着（状态板之类）就自动重锚挪组（fail-soft）
      if (args.tag) { try { await applyFollows(projectId, { tag: args.tag, newId: rel }); } catch { /* */ } }

      const rect = { x: Math.round(placed.x), y: Math.round(placed.y), w: box.w, h: box.h };
      try {
        ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: parentId ? '回了一条板书' : '写了一条板书' });
        ctx?.emit?.(Events.boardFocus(rect, { tag: args.tag || null, layer: zone, soft: true, chalk: rel, actor: by !== 'agent' ? by : null }));
      } catch { /* fail-soft */ }
      const lines = [
        `Wrote board note ${rel} at (${rect.x},${rect.y}) ${rect.w}x${rect.h} — ${describeSpot(b2, placed)}.`,
        `Visible in the user's viewport: ${visibleIn(rect, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
      ];
      // 余量随手报（2026-08-30 容量线）：下一条要不要拆、还塞不塞得下，
      // 最有用的时机就是刚写完这一刻 —— 别让它再去翻状态块或者赌一发。
      if (slotInfo) {
        const freeH = Math.max(0, Math.round(slotInfo.rect.y + slotInfo.rect.h - (rect.y + rect.h) - UNIT));
        const c = capacityOf(slotInfo.rect.w, freeH);
        lines.push(`Slot "${args.slot}" now has ~${c.lines} lines (~${c.cjk} CJK chars, ${freeH}px) left${freeH < 60 ? ' — next note of any size goes elsewhere or flow it' : ''}.`);
      }
      if (box.reserved) lines.push(`Box height reserved at ${box.h}px (content measured shorter — the box keeps your planned size).`);
      // 折叠如实报（08-29 占位契约刀 B）：卡高封顶到 CARD_MAX_H，超出的折在卡里。
      // ⚠ 旧判据 `box.h > SKETCH_FIT.h*0.6`（720px）封顶之后永远不成立 —— 换成真话。
      if (box.capped) {
        lines.push(`⚠ Too long for one card: it shows ${box.h}px of ~${box.fullH}px — the rest is folded (the reader must click to unfold). Split it into several notes (chain:true keeps them threaded), or start a fresh sheet.`);
      }
      // 收卷提醒（2026-08-27 收纳器）：落进收着的组 = 用户看不见这条新话
      {
        const rolledInto = [args.tag, board.objects?.[parentId]?.tag, board.objects?.[anchorId]?.tag]
          .find(t => t && b2.rolls?.[t]);
        if (rolledInto) lines.push(`⚠ #${rolledInto} 这条线收着卷（用户看不见里面）——这条也进了卷。要让用户看见，先 edit_board unroll{tag:"${rolledInto}"}。`);
      }
      if (laneFrom) {
        lines.push(`Opened lane #${args.tag}${laneFrom !== 'fresh' ? ` branching from ${laneFrom.id}` : ''} on its own sheet`
          + ` — continue it with {tag:"${args.tag}", chain:true}; read_board lists lanes and sheets.`);
      }
      lines.push('The user can annotate it to reply; answer with reply_to (or chain:true on the same tag).');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ───────────────────────── 件数 ≥ 2：一张图（画布原生） ─────────────────────────
    // 单个形状（比如一个圈、一条下划线）是"记号"：画布原生，但不强打 tag、不进草稿态
    const soloMark = !args.title && !nodesIn.length && shapesIn.length === 1;
    const tag = args.tag || (soloMark ? null : `sk-${stamp()}`);
    const staging = args.staging !== false && !soloMark;

    const localIds = new Set();
    const nodes = [];
    if (args.title) {
      nodes.push({ key: '__title', text: `## ${args.title}`, format: 'md', size: 'md', font: 'kai', color: 'ink', at: null, w: null });
    }
    for (const n of nodesIn) {
      if (localIds.has(n.id)) return err(`节点 id 重复：${n.id}`);
      localIds.add(n.id);
      const size = (n.size === 'sm' && n.text.length > 40) ? 'md' : (n.size || 'md');
      // 缺省 format 按内容侦测：带 markdown 记号标 plain 会把 **加粗** 吐成星号（ldx 案）
      const format = n.format || (looksLikeMd(n.text) ? 'md' : 'plain');
      nodes.push({ key: n.id, text: n.text, format, size, font: n.font || 'pen', color: n.color || 'ink', at: n.at || null, w: n.w || null });
    }
    for (const n of nodes) {
      const box = textBox(n.text, n.size, { md: n.format === 'md', wUnits: capW(n.w) });
      n.w = box.w; n.h = box.h;
    }
    const titleNode = nodes.find(n => n.key === '__title');
    // 图内边（两端都是本图节点）：布局的结构输入 + 零线大图的提醒判据
    const nodeKeys = new Set(nodes.map(n => n.key));
    const innerEdges = edgesIn.filter(e => nodeKeys.has(e.from) && nodeKeys.has(e.to) && e.from !== e.to);
    const tpl = resolveTemplate(nodes.filter(n => n !== titleNode), { template: args.layout || 'auto', edges: innerEdges, column: fit.column });
    // 节点级拉力（08-27 产物锚 v2）：节点 ↔ 板上已有产物的边，给布局一个方向 ——
    // 连着谁就排向谁那一侧（flow 层内排序 / mindmap 环位都吃它）
    const pull = new Map();
    for (const e of edgesIn) {
      for (const [self, other] of [[e.from, e.to], [e.to, e.from]]) {
        if (!nodeKeys.has(self) || nodeKeys.has(other)) continue;
        const cid = normalizeCanvasId(other);
        const ext = cid ? board.objects?.[cid] : null;
        if (!ext || !Number.isFinite(ext.x)) continue;
        const s = estimateSizeOn(board, cid, ext);
        const c = { x: ext.x + s.w / 2, y: ext.y + s.h / 2 };
        const cur = pull.get(self);
        pull.set(self, cur ? { x: (cur.x + c.x) / 2, y: (cur.y + c.y) / 2 } : c);
      }
    }
    if (tpl === 'free') {
      // free 的合同：每个节点都要 at。缺 at 静默排成一列是 ldx 那晚两次重画的病根 —— 明拒，报名单。
      const missing = nodes.filter(n => n !== titleNode && !n.at).map(n => n.key);
      if (missing.length) {
        return err(`layout free 要求每个节点都带 at（网格坐标），缺：${missing.join(', ')}。给它们补 at，或者去掉 layout:'free' 用模板排。`);
      }
    }
    const layoutInput = titleNode && tpl === 'mindmap' ? nodes.filter(n => n !== titleNode) : nodes;
    let pos = layoutNodes(layoutInput, { template: tpl, cols: args.cols, edges: innerEdges, pull });
    const seatTitle = () => {
      if (titleNode && !pos.has('__title')) {
        const bb = bboxOrZero([...pos.entries()].map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      } else if (titleNode && tpl === 'free' && !titleNode.at) {
        const bb = bboxOrZero([...pos.entries()].filter(([k]) => k !== '__title').map(([k, p]) => ({ x: p.x, y: p.y, ...nodes.find(n => n.key === k) })));
        pos.set('__title', { x: bb.x, y: bb.y - titleNode.h - 12 });
      }
    };
    seatTitle();
    const rectOfNode = (key) => { const n = nodes.find(x => x.key === key); const p = pos.get(key); return n && p ? { x: p.x, y: p.y, w: n.w, h: n.h } : null; };

    // ── 形状（局部像素）：构建本体在 lib/sketch-shapes.js（08-27 棘轮拆件） ──
    const built = buildSketchShapes(shapesIn, { rectOfNode, isTaken: (id) => localIds.has(id), tag });
    if (built.error) return err(built.error);
    const shapes = built.shapes;
    // ── 线：端点校验跟 edit_board add_edge 同一道闸（endpointReal） ──
    const idOf = new Map();
    for (const n of nodes) idOf.set(n.key, `text:a${stamp()}`);
    for (const sh of shapes) idOf.set(sh.key, `scribble:a${stamp()}`);
    const resolveEnd = async (raw) => {
      if (idOf.has(raw)) return idOf.get(raw);
      const cid = normalizeCanvasId(raw);
      if (!cid) return null;
      return (await endpointReal(cid, board.objects || {}, board.zones, sharedRoot)) ? cid : null;
    };
    const bindings = {};
    const badEdges = [];
    for (const e of edgesIn) {
      const from = await resolveEnd(e.from); const to = await resolveEnd(e.to);
      if (!from || !to || from === to) { badEdges.push(`${e.from}→${e.to}`); continue; }
      bindings[`b:a${stamp()}`] = {
        type: e.type || 'link', from, to, by, material: e.material || 'pencil',
        ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}), ...(e.label ? { label: e.label } : {}),
      };
    }

    // ── 宏观落位：纸（sheet 局部 at / 顺排 / near+side 贴放） ──
    const local = bboxOrZero([
      ...nodes.map(n => ({ ...pos.get(n.key), w: n.w, h: n.h })),
      ...shapes.map(sh => sh.rect),
    ]);
    // 巨图不再硬拒（08-25 用户拍板移除上限）：照落，返回里强提醒拆分
    const oversized = local.w > SKETCH_MAX.w || local.h > SKETCH_MAX.h;
    let zone = '';
    let anchorRect = null;
    let sketchBase = board;
    if (args.near) {
      const a = await resolveAnchor(args.near, board);
      if (!a && !args.at) return err(`锚点 ${args.near} 不在板上：既没有座位、不是任何 tag，磁盘上也没有这个文件（read_board 看一眼现在都有谁）。`);
      if (a) {
        zone = a.zone;
        if (a.board) sketchBase = a.board;
        const e = sketchBase.objects[a.anchorId];
        anchorRect = { x: a.rect.x, y: a.rect.y, ...estimateSizeOn(sketchBase, a.anchorId, e) };
        if (a.rect.w > anchorRect.w) anchorRect = a.rect;   // tag 包络比单卡大就用包络
      }
    }
    const obstacles = obstaclesOf(sketchBase, zone);
    const vpRect = vpRectFor(zone);
    const sketchBox = { w: local.w + 24, h: local.h + 24 };
    let placed;
    if (zone) {
      if (args.at) return err('at 是纸内坐标，文件夹层没有纸 —— 在文件夹里用 near 落位。');
      placed = placeInZone({ box: sketchBox, replyRect: null, anchorRect, side: args.side || null, obstacles });
    } else if (args.slot) {
      // 草图也能进规划好的块（2026-08-29 刀 F 补）。⛔ 之前 slot 只有板书那条路认，
      // 而状态板/对照表这类东西正是走草图写的 —— 真会话 proj_mtfhey1x 里 agent
      // 规划了 aside 却一个字没进去，它想用也用不了，只能拿 at 手摆到别处。
      const si = resolveSlot(sketchBase, { slotName: args.slot, sheetName: args.sheet || null });
      if (si.error) return err(si.message);
      const p = placeInSlot(sketchBase, { rect: si.rect, sheet: si.sheet, slotName: args.slot, box: sketchBox, obstacles });
      if (p.full) return err(p.message);
      placed = p;
    } else {
      placed = await placeOnSheets(sketchBase, {
        box: sketchBox, at: args.at || null, sheetName: args.sheet || null,
        replyRect: null, anchorRect, side: args.side || null, obstacles,
      });
      if (placed.sheetFull) return err(describeSheetFull(sketchBase, placed.sheetFull));
      if (placed.opened) sketchBase = { ...sketchBase, sheets: { ...(sketchBase.sheets || {}), [placed.opened.id]: { x: placed.opened.x, y: placed.opened.y, w: placed.opened.w, h: placed.opened.h, at: placed.opened.at, by } } };
    }
    const ox = placed.x - local.x + 12; const oy = placed.y - local.y + 12;
    // mindmap 的方位重排要**真实图心**（落位前算不出，单锚时质心还会退化）——
    // 环形 bbox 不随槽位变，落位定了再按世界方位二次布局，落位本身不漂
    if (tpl === 'mindmap' && pull.size) {
      pos = layoutNodes(layoutInput, { template: 'mindmap', cols: args.cols, edges: innerEdges, pull, pullOrigin: { x: ox, y: oy } });
      seatTitle();
    }

    // ── 落盘 ──
    const objects = {};
    const common = { z: 1, zone, by, seat: 'agent', ...(tag ? { tag } : {}), ...(staging ? { staging: true } : {}) };
    for (const n of nodes) {
      const p = pos.get(n.key);
      objects[idOf.get(n.key)] = {
        x: Math.round(p.x + ox), y: Math.round(p.y + oy), w: n.w, h: n.h, kind: 'text',
        data: { t: n.text, ...(n.format === 'md' ? { format: 'md' } : {}), font: TEXT_FONTS.includes(n.font) ? n.font : 'pen', size: n.size, color: n.color, lid: n.key },
        ...common,
      };
    }
    for (const sh of shapes) {
      objects[idOf.get(sh.key)] = { x: Math.round(sh.rect.x + ox), y: Math.round(sh.rect.y + oy), w: Math.round(sh.rect.w), h: Math.round(sh.rect.h), kind: 'scribble', data: { d: sh.d, color: sh.color, width: sh.width }, ...(sh.hug && idOf.get(sh.hug) ? { hug: idOf.get(sh.hug) } : {}), ...common };
    }
    const saved = await patchBoard(projectId, { objects, bindings });
    const landed = Object.keys(objects).filter(id => saved.objects?.[id]).length;
    if (!landed) return err('草图被 board 拒了（内容或字段不合法）。');
    if (tag && nodes.length) { try { await applyFollows(projectId, { tag, newId: idOf.get(nodes[0].key) }); } catch { /* */ } }
    const world = { x: Math.round(local.x + ox), y: Math.round(local.y + oy), w: Math.round(local.w), h: Math.round(local.h) };
    try {
      ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: tag ? `画了一张草图 #${tag}` : '画了一个记号' });
      ctx?.emit?.(Events.boardFocus(world, { tag: tag || null, layer: zone, actor: by !== 'agent' ? by : null }));
    } catch { /* fail-soft */ }
    const lines = [
      `Sketch${tag ? ` #${tag}` : ''} landed${staging ? ' as STAGING (半透明)' : ''}: ${nodes.length} nodes, ${shapes.length} shapes, ${Object.keys(bindings).length} lines; layout ${tpl}; at world (${world.x},${world.y}) ${world.w}x${world.h} — ${describeSpot(sketchBase, placed)}.`,
      `ids: ${[...idOf].map(([k, v]) => `${k}=${v}`).join(', ')}`,
      `Visible in the user's viewport: ${visibleIn(world, vpRect) ? 'yes' : (vpRect ? 'no (outside their view — mention where it is)' : 'unknown (no viewpoint yet)')}.`,
    ];
    if (oversized) lines.push(`⚠ 这张图 ${Math.round(local.w)}x${Math.round(local.h)} 世界像素，远超一张纸（建议 ≤${SKETCH_MAX.w}x${SKETCH_MAX.h}）——用户要拖着镜头看。下次拆成几张 tag 图用线连。`);
    // 零线大图提醒（08-27 用户报「草草一堆文字摊在那儿」）：软提醒不硬拒 ——
    // 但要说清楚这不是风格问题，是版面语言缺了一半
    if (nodesIn.length >= 3 && !innerEdges.length) {
      lines.push(`⚠ ${nodesIn.length} 件 0 线 —— 这是摊了一堆字，不是一张图。线是版面的语言：`
        + `补 edges（谁连谁、什么关系，布局会按结构分层摆）；这些如果本是一条思路，`
        + `改走 {tag, chain:true} 让它长成线。`);
    }
    if (badEdges.length) lines.push(`Skipped ${badEdges.length} edge(s) with unknown endpoints: ${badEdges.slice(0, 6).join(', ')}`);
    // 触屏档宽是硬约束（横向滑动没人受得了），所以话要说在宽上
    if (world.w > fit.w || world.h > fit.h) lines.push(fit.column
      ? `⚠ Too big for a ${fit.lane} screen (${fit.screen.w}x${fit.screen.h}px). Keep each sketch ≤${fit.w} wide — anything wider means sideways scrolling. Stack the next one below, don't put it to the side.`
      : `⚠ Bigger than one sheet${fit.screen ? ` (user's screen ${fit.screen.w}x${fit.screen.h}px → ${fit.w}x${fit.h} world px fits)` : ` (${fit.w}x${fit.h} fits)`} — split into two tagged sketches next time.`);
    if (vp?.zoom && vp.zoom < 0.75) lines.push(`User's zoom is ${vp.zoom} (<0.75): keep nodes md/lg and say in one line that there is a sketch on the board.`);
    lines.push(staging
      ? `Next: look_at_board {tag:"${tag}"} to check it, then edit_board {ops:[{op:"commit",tag:"${tag}"}]} (or it commits at turn end).`
      : `Next: look_at_board ${tag ? `{tag:"${tag}"}` : '{around: one of the ids}'} to check it.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  };
}
