/**
 * mcp/tools/write-on-board-flow.js —— write_on_board 的 flow 档（2026-08-30 刀⑦，
 * 行数棘轮拆件：主文件只留一个入口）。
 *
 * 「剩 15 行 vs 我这段几行」这道算术模型做不准也不该做（proj_mtfpehm3 真会话
 * 14 发 board_batch 挂 6 发全是容量拒收）。flow 把它拿走：整段内容按段落边界
 * 拆成一串 ≤ 一张卡高的小板书，链着往纸里排。
 *
 * ⭐ 2026-09-01 刀 2 之后这不再是「懒人兜底」，而是**长文的正路** ——
 * 一张卡装不下的正文自动走这里（write-on-board.js 那个入口），拆出来的段按栏排、
 * 排满自动翻页。站主原话：「模型在纸张中只需要输入内容，然后由机械层自动排版切层」。
 */

import { flowChunks } from '../../../lib/chalk-flow.js';
import { textBox } from '../../../lib/sketch-layout.js';
import { CARD_MAX_H } from '../../../lib/screen.js';
import { renderChalk, chalkFileName, writeChalkFile } from '../../../lib/chalk.js';
import { patchBoard } from '../../../projects/board-store.js';
import { applyFollows } from '../../../lib/board-follow.js';
import { Events } from '../../agent/events.js';

/**
 * flow 写入。返回工具结果；**返回 null = 用不上 flow**（守卫不过 / 一块就装下），
 * 调用方接着走正常单条路径。
 */
export async function maybeFlowWrite({
  projectId, sharedRoot, sessionId, by, ctx, args, body, wUnits, zone,
  parentId, replyRect, anchorId, b2, obstaclesFor,
  placeOnSheets, describeSheetFull, stamp,
}) {
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  if (args.ink === 'hand') return err("flow 拆的是板书链，ink:'hand' 没有文件本体接不了链 —— 去掉其中一个。");
  if (args.open_lane) return err('flow 跟 open_lane 分两步：先 open_lane 落线头，再 {tag, chain:true, flow:true} 续长文。');
  if (zone) return err('flow 排的是纸，文件夹层没有纸 —— 在文件夹里逐条写。');
  const chunks = flowChunks(body, { wUnits, size: args.size || 'md', maxH: CARD_MAX_H });
  if (chunks.length <= 1) return null;   // 体积本来就小，正常单条路径

  let live = b2;
  const objects = {}; const bindings = {};
  const written = [];
  let prevRel = parentId; let prevRect = replyRect;
  let leftover = 0; let fullMsg = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const cBox = textBox(chunks[i], args.size === 'sm' ? 'md' : (args.size || 'md'), { md: true, wUnits });
    // 障碍按**这一段要落的那一页**算（2026-09-01 叠纸刀 2）：一条 flow 链可能跨页
    const obs = obstaclesFor(live, '', { sheetName: args.sheet || null });
    const p = await placeOnSheets(live, {
      box: cBox, at: (i === 0 && args.at) ? args.at : null, sheetName: args.sheet || null,
      replyRect: prevRect, anchorRect: null, side: null, obstacles: obs,
    });
    if (p.sheetFull) { leftover = chunks.length - i; fullMsg = describeSheetFull(live, p.sheetFull); break; }
    // 铺了第一张纸、或者机器翻了一页：本地副本要跟上，后面几段才排得对
    for (const o of [p.opened, p.turned]) {
      if (o) live = { ...live, sheets: { ...(live.sheets || {}), [o.id]: { x: o.x, y: o.y, w: o.w, h: o.h, at: o.at, by, ...(o.colW ? { colW: o.colW } : {}), ...(o.stack ? { stack: o.stack } : {}) } } };
    }
    const content = renderChalk({
      body: chunks[i], by, anchor: i === 0 ? anchorId : null,
      replyTo: prevRel, tag: args.tag || null, sessionId: sessionId || null,
    });
    const rel = await writeChalkFile(sharedRoot, chalkFileName(chunks[i]), content);
    const entry = {
      x: Math.round(p.x), y: Math.round(p.y), z: 1, w: cBox.w, h: cBox.h,
      zone: '', by, seat: 'agent', ...(args.tag ? { tag: args.tag } : {}),
      // 认领这一页（2026-09-01 叠纸刀 1）：一条链可能跨页，每段各认各的
      ...(p.sheetId ? { sheet: p.sheetId } : {}),
    };
    objects[rel] = entry;
    if (i === 0 && anchorId) {
      const type = args.relation || 'annotates';
      const [from, to] = type === 'flow' ? [anchorId, rel] : [rel, anchorId];
      bindings[`b:a${stamp()}`] = { type, from, to, by, ...(args.tag ? { tag: args.tag } : {}) };
    }
    if (prevRel) bindings[`b:a${stamp()}`] = { type: 'flow', from: prevRel, to: rel, by, material: 'pencil', ...(args.tag ? { tag: args.tag } : {}) };
    live = { ...live, objects: { ...(live.objects || {}), [rel]: entry } };
    written.push({ rel, sheetId: p.sheetId || null, rect: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } });
    prevRel = rel; prevRect = written[written.length - 1].rect;
  }
  /**
   * 一条都没放下 —— **退回单条路，别在这儿报错**（2026-09-01 刀 2）。
   *
   * 会走到这里只有一种情形：纸小到连一块卡都装不下（贴产物的小说明纸），
   * 而且机器已经替它翻过一页了。这时候整条拒收就是把内容丢掉，而调用方那边
   * 有一条更好的路：照原样落一条，溢出到暂存架，报文当场要 agent 安置。
   */
  if (!written.length) return null;
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
    ctx?.emit?.(Events.boardFocus(bbox, { tag: args.tag || null, layer: '', soft: true, chalk: written[0].rel, actor: by !== 'agent' ? by : null }));
  } catch { /* fail-soft */ }
  const pages = [...new Set(written.map((w) => w.sheetId).filter(Boolean))];
  const lines = [
    `The machine split this into ${written.length} chained notes and laid them out${pages.length > 1 ? ` across ${pages.length} pages (${pages.join(' → ')})` : ''}:`,
    ...written.map((w) => `  ${w.rel} at (${w.rect.x},${w.rect.y}) ${w.rect.w}x${w.rect.h}`),
  ];
  if (leftover) {
    const rest = chunks.slice(chunks.length - leftover);
    const restH = rest.reduce((n, t) => n + textBox(t, 'md', { md: true, wUnits }).h, 0);
    lines.push(`⚠ ${leftover} paragraph(s) did NOT fit (from 「${[...rest[0]].slice(0, 16).join('')}…」, ~${Math.ceil(restH / 26)} lines). They were returned untouched — nothing was squeezed or dropped.`);
    if (fullMsg) lines.push(fullMsg.split('\n')[0]);
    lines.push(`Continue them yourself: write the REST again with {flow:true, chain:true${args.tag ? `, tag:"${args.tag}"` : ''}} — chain threads it onto ${written[written.length - 1].rel}.`);
  }
  lines.push('The user can annotate any of them to reply; answer with reply_to.');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
