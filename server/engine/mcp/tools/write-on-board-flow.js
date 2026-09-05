/**
 * mcp/tools/write-on-board-flow.js —— flow:true 的机器拆段（2026-08-30 刀⑦ 拆件；
 * 2026-09-05 意图层：第一段按 place/near/reply_to 落，后面的一段接一段往下接楼）
 *
 * 语义：一整篇现成长文按段落边界拆成一串卡大小的板书，用 flow 线串起来。
 * 没有纸就没有「装不下」：一串要多长就多长，返回里只报串了几条、落在哪。
 */
import { flowChunks } from '../../../lib/chalk-flow.js';
import { textBox } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { renderChalk, chalkFileName, writeChalkFile } from '../../../lib/chalk.js';
import { patchBoard } from '../../../projects/board-store.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { describePlacement } from '../../../lib/board-place.js';
import { Events } from '../../agent/events.js';

export async function maybeFlowWrite({
  projectId, sharedRoot, sessionId, by, ctx, args, body, wUnits, zone,
  parentId, replyRect, anchorId, placeRect, placeId, groupRect, groupTag, b2, obstaclesOf,
  placeNote, vpRect, column, stamp,
}) {
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  if (args.ink === 'hand') return err("flow 拆的是板书链，ink:'hand' 没有文件本体接不了链 —— 去掉其中一个。");
  if (args.open_lane) return err('flow 跟 open_lane 分两步：先 open_lane 落线头，再 {tag, chain:true, flow:true} 续长文。');
  const chunks = flowChunks(body, { wUnits, size: args.size || 'md', maxH: CARD_MAX_H });
  if (chunks.length <= 1) return null;   // 体积本来就小，正常单条路径

  let live = b2;
  const objects = {}; const bindings = {};
  const written = [];
  let prevRel = parentId; let prevRect = replyRect;
  let first = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const cBox = textBox(chunks[i], args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });
    const obs = obstaclesOf(live, zone);
    // 第一段按意图落，之后每段接在上一段正下方
    const p = placeNote(live, {
      box: cBox, anchorRect: i === 0 ? placeRect : null, side: i === 0 ? (args.place?.side || null) : null,
      groupRect: i === 0 ? groupRect : null, replyRect: prevRect, obstacles: obs, vpRect, column,
    });
    if (i === 0) first = p;
    const content = renderChalk({
      body: chunks[i], by, anchor: i === 0 ? anchorId : null,
      replyTo: prevRel, tag: args.tag || null, sessionId: sessionId || null,
    });
    const rel = await writeChalkFile(sharedRoot, chalkFileName(chunks[i]), content);
    const entry = {
      x: Math.round(p.x), y: Math.round(p.y), z: 1, w: cBox.w, h: cBox.h,
      zone, by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
    };
    objects[rel] = entry;
    if (i === 0 && anchorId) {
      const type = args.relation || 'annotates';
      const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
      bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}), ...(args.say ? { label: args.say } : {}) };
    }
    if (prevRel) bindings[`b:a${stamp()}`] = { type: 'flow', from: prevRel, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}), ...(i === 0 && args.say && !anchorId ? { label: args.say } : {}) };
    live = { ...live, objects: { ...(live.objects || {}), [rel]: entry } };
    written.push({ rel, rect: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } });
    prevRel = rel; prevRect = written[written.length - 1].rect;
  }
  if (!written.length) return err('⛔ 一条都没放下。');
  await patchBoard(projectId, { objects, bindings });
  if (args.tag) { try { await applyFollows(projectId, { tag: args.tag, newId: written[written.length - 1].rel }); } catch { /* */ } }
  const xs = written.map((w) => w.rect.x); const ys = written.map((w) => w.rect.y);
  const bbox = {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...written.map((w) => w.rect.x + w.rect.w)) - Math.min(...xs),
    h: Math.max(...written.map((w) => w.rect.y + w.rect.h)) - Math.min(...ys),
  };
  try {
    ctx?.emit?.({ type: 'board.updated', sessionId: null, summary: `写了一串板书（${written.length} 条）` });
    ctx?.emit?.(Events.boardFocus(bbox, { tag: args.tag || null, layer: zone, soft: true, chalk: written[0].rel, actor: by !== 'agent' ? by : null }));
  } catch { /* fail-soft */ }
  const lines = [
    `Flowed into ${written.length} chained notes, the first ${describePlacement(first, { anchorId: placeId || anchorId, groupTag })}, the rest threaded straight down:`,
    ...written.map((w) => `  ${w.rel}`),
    'A board note explains one thing — next time write the points yourself as separate notes, or put real content in an artifact.',
    'The user can annotate any of them to reply; answer with reply_to.',
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
