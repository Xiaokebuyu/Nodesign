/**
 * server/lib/board-graph-export.js —— 连接图导出（2026-08-23 黑板）
 *
 * 真相是 board.json（节点 + 线 + 位置 + 标签），由它派生三种形态：
 *   json     结构原样（给程序 / 备份）
 *   mermaid  flowchart 文本（给别的工具吃；位置丢掉，语义留着）
 *   svg      一张能看的图：卡片画成带名字的方框、手写字照排、涂鸦照路径、线照语义
 *            —— 这是**导出保真度**的渲染，不是画布本体（画布本体只有前端那一份）
 * 可按 #tag 只导一组。带产物的 zip 另议（zip 要搬文件，是交付层的事）。
 */
import { BINDING_TYPES } from './binding-types.js';
import { estimateSizeOn } from './board-kind-sizes.js';
import { layerOf } from './canvas-id.js';
import { describeEndpoint } from './board-relations.js';

function pick(board, { tag = null, layer = '' } = {}) {
  const known = new Set(Object.keys(board.zones || {}));
  const nodes = [];
  for (const [id, e] of Object.entries(board.objects || {})) {
    if (!Number.isFinite(e?.x)) continue;
    if (layerOf(id, e, known) !== layer) continue;
    if (tag && e.tag !== tag) continue;
    const sz = estimateSizeOn(board, id, e);
    nodes.push({
      id, kind: e.kind || kindOfId(id), x: e.x, y: e.y, w: sz.w, h: sz.h,
      ...(e.kind === 'text' ? { text: e.data?.t || '', format: e.data?.format || 'plain', font: e.data?.font, size: e.data?.size, color: e.data?.color } : {}),
      ...(e.kind === 'scribble' ? { d: e.data?.d || '', color: e.data?.color, width: e.data?.width } : {}),
      ...(e.tag ? { tag: e.tag } : {}), ...(e.staging ? { staging: true } : {}), ...(e.by ? { by: e.by } : {}),
    });
  }
  const ids = new Set(nodes.map(n => n.id));
  const edges = [];
  for (const [id, b] of Object.entries(board.bindings || {})) {
    if (!ids.has(b.from) || !ids.has(b.to)) continue;
    if (tag && b.tag !== tag && !(ids.has(b.from) && ids.has(b.to))) continue;
    edges.push({ id, type: b.type, from: b.from, to: b.to, ...(b.label ? { label: b.label } : {}), material: b.material || 'ink', ...(b.by ? { by: b.by } : {}), ...(b.tag ? { tag: b.tag } : {}) });
  }
  return { nodes, edges };
}

function kindOfId(id) {
  const m = /^(deck|site|docx|doc):/.exec(id);
  if (m) return m[1];
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(id)) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(id)) return 'video';
  if (/\.(md|txt)$/i.test(id)) return 'note';
  return 'file';
}

export function exportGraph(board, { format = 'json', tag = null, layer = '' } = {}) {
  const g = pick(board, { tag, layer });
  if (format === 'json') return { mime: 'application/json', body: JSON.stringify({ version: 1, tag, layer, ...g }, null, 2) };
  if (format === 'mermaid') return { mime: 'text/plain; charset=utf-8', body: toMermaid(g, board) };
  if (format === 'svg') return { mime: 'image/svg+xml; charset=utf-8', body: toSvg(g, board) };
  throw Object.assign(new Error('unknown format'), { status: 400 });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nodeTitle(n, board) {
  if (n.kind === 'text') return String(n.text || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (n.kind === 'scribble') return '（涂鸦）';
  return describeEndpoint(n.id, board, { withId: false }).replace(/（[a-z]+）$/, '');   // 给人看的图：不带 id（09-17 摘要改印 id 之后分开）
}

export function toMermaid(g, board) {
  const key = new Map(g.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ['flowchart LR'];
  for (const n of g.nodes) {
    if (n.kind === 'scribble') continue;
    const t = nodeTitle(n, board).replace(/["[\]{}()|]/g, ' ').trim() || n.id;
    const shape = n.kind === 'text' ? `("${t}")` : `["${t}"]`;
    lines.push(`  ${key.get(n.id)}${shape}`);
  }
  for (const e of g.edges) {
    const t = BINDING_TYPES[e.type];
    const word = (e.label || t?.label || e.type).replace(/["|]/g, ' ');
    const arrow = t?.directed ? `-- ${word} -->` : `--- ${word} ---`;
    if (!key.has(e.from) || !key.has(e.to)) continue;
    lines.push(`  ${key.get(e.from)} ${arrow} ${key.get(e.to)}`);
  }
  return lines.join('\n') + '\n';
}

const PAPER = { paper: '#F0EADB', ink: '#2B2117', ink2: '#5F5142', pencil: '#A39882', red: '#A8362B', brass: '#b08c4f', card: '#FFFEF6' };
const INK = { ink: PAPER.ink, red: PAPER.red, pencil: PAPER.pencil, brass: PAPER.brass };
const SIZE_PX = { sm: 13, md: 16, lg: 22, xl: 30 };

function edgePoint(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }; const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x; const dy = bc.y - ac.y;
  const pt = (r, c, ddx, ddy) => {
    const tx = ddx === 0 ? Infinity : (r.w / 2) / Math.abs(ddx); const ty = ddy === 0 ? Infinity : (r.h / 2) / Math.abs(ddy);
    const t = Math.min(tx, ty); return { x: c.x + ddx * t, y: c.y + ddy * t };
  };
  return { from: pt(a, ac, dx, dy), to: pt(b, bc, -dx, -dy) };
}

export function toSvg(g, board, { hrefOf = null } = {}) {
  if (!g.nodes.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="35" font-size="14">（空）</text></svg>';
  const PAD = 40;
  const x0 = Math.min(...g.nodes.map(n => n.x)) - PAD; const y0 = Math.min(...g.nodes.map(n => n.y)) - PAD;
  const x1 = Math.max(...g.nodes.map(n => n.x + n.w)) + PAD; const y1 = Math.max(...g.nodes.map(n => n.y + n.h)) + PAD;
  const W = Math.round(x1 - x0); const H = Math.round(y1 - y0);
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${x0} ${y0} ${W} ${H}" font-family="'Kaiti SC','KaiTi','STKaiti',serif">`);
  out.push(`<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="${PAPER.paper}"/>`);
  out.push('<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M 1 1 L 9 5 L 1 9 z" fill="context-stroke"/></marker><marker id="dot" markerWidth="8" markerHeight="8" refX="4" refY="4" markerUnits="userSpaceOnUse"><circle cx="4" cy="4" r="3" fill="context-stroke"/></marker></defs>');
  // 线在物件下面
  for (const e of g.edges) {
    const a = byId.get(e.from); const b = byId.get(e.to); if (!a || !b) continue;
    const p = edgePoint(a, b);
    const dx = p.to.x - p.from.x; const dy = p.to.y - p.from.y; const dist = Math.hypot(dx, dy) || 1;
    const yarn = e.material === 'yarn';
    const lift = yarn ? 0 : Math.min(dist * 0.14, 46);
    const cx = (p.from.x + p.to.x) / 2 + (yarn ? 0 : (-dy / dist) * lift);
    const cy = (p.from.y + p.to.y) / 2 + (yarn ? Math.min(dist * 0.11, 56) : (dx / dist) * lift);
    const t = BINDING_TYPES[e.type];
    const stroke = yarn ? PAPER.red : (e.type === 'contrast' ? PAPER.brass : e.type === 'ref' ? PAPER.pencil : e.type === 'derives-from' ? PAPER.ink : PAPER.ink2);
    const width = yarn ? 2.6 : e.type === 'derives-from' ? 2.4 : e.type === 'annotates' ? 1.4 : 2;
    const dash = !yarn && e.type === 'annotates' ? ' stroke-dasharray="3 4"' : !yarn && e.type === 'ref' ? ' stroke-dasharray="1 5"' : '';
    const marker = yarn ? '' : (t?.directed ? ' marker-end="url(#arrow)"' : (e.type === 'link' ? ' marker-end="url(#dot)" marker-start="url(#dot)"' : ''));
    out.push(`<path d="M ${p.from.x} ${p.from.y} Q ${cx} ${cy} ${p.to.x} ${p.to.y}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${dash}${marker}/>`);
    if (yarn) for (const q of [p.from, p.to]) out.push(`<circle cx="${q.x}" cy="${q.y}" r="4.6" fill="${PAPER.red}" stroke="${PAPER.ink}" stroke-width="0.8"/>`);
    const word = e.label || (e.type !== 'annotates' ? t?.label : null);
    if (word) {
      const mx = 0.25 * p.from.x + 0.5 * cx + 0.25 * p.to.x; const my = 0.25 * p.from.y + 0.5 * cy + 0.25 * p.to.y;
      out.push(`<text x="${mx}" y="${my}" font-size="11" text-anchor="middle" dominant-baseline="middle" fill="${PAPER.ink2}" stroke="${PAPER.paper}" stroke-width="4" paint-order="stroke">${esc(word)}</text>`);
    }
  }
  for (const n of g.nodes) {
    const op = n.staging ? ' opacity="0.55"' : '';
    if (n.kind === 'scribble') {
      out.push(`<g transform="translate(${n.x} ${n.y})"${op}><path d="${esc(n.d)}" fill="none" stroke="${INK[n.color] || PAPER.ink}" stroke-width="${n.width || 2}" stroke-linecap="round" stroke-linejoin="round"/></g>`);
      continue;
    }
    if (n.kind === 'text') {
      const px = SIZE_PX[n.size] || 16; const fill = INK[n.color] || PAPER.ink;
      const lines = String(n.text || '').split('\n').slice(0, 24);
      out.push(`<g transform="translate(${n.x + 6} ${n.y + 4})"${op}>` + lines.map((l, i) => `<text x="0" y="${Math.round((i + 0.85) * px * 1.6)}" font-size="${px}" fill="${fill}">${esc(l.replace(/^#+\s*/, '').replace(/\*\*/g, ''))}</text>`).join('') + '</g>');
      continue;
    }
    const title = nodeTitle(n, board);
    const href = hrefOf ? hrefOf(n) : null;
    out.push(`${href ? `<a href="${esc(href)}">` : ''}<g${op}><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${PAPER.card}" stroke="rgba(43,33,23,0.18)"/>`
      + `<text x="${n.x + 12}" y="${n.y + 20}" font-size="13" fill="${PAPER.ink}">${esc(title)}</text>`
      + `<text x="${n.x + 12}" y="${n.y + n.h - 10}" font-size="10" fill="${PAPER.pencil}">${esc(n.kind)}</text></g>${href ? '</a>' : ''}`);
  }
  out.push('</svg>');
  return out.join('\n');
}

/* ── 带产物的 zip（2026-08-23）────────────────────────────────────────────
 * 真相仍是 board.json；zip 里：board/graph.json + graph.svg（卡片可点，链到 zip 里的文件）+
 * graph.mmd + index.html（内嵌 svg 的静态重放页）+ 节点指向的产物文件（走 export-collect
 * 同一套寻址：站点整目录、deck 的 html、图片、板书 .md…）。画布原生的手写字/涂鸦没有文件，
 * 它们的内容都在 graph.json/svg 里。
 */
export async function exportGraphZip(board, { workspaceRoot, tag = null, layer = '', projectName = '画布' } = {}) {
  const [{ default: JSZip }, { collectCards }, fsm] = await Promise.all([
    import('jszip'), import('./export-collect.js'), import('node:fs/promises'),
  ]);
  const g = pick(board, { tag, layer });
  const fileIds = g.nodes.filter(n => n.kind !== 'text' && n.kind !== 'scribble').map(n => n.id);
  const { bundles, skipped } = await collectCards({ workspaceRoot, cardIds: fileIds });
  const zip = new JSZip();
  const relOfNode = new Map();
  for (const b of bundles) {
    for (const f of [...(b.files || []), ...(b.assets || [])]) {
      try { zip.file(f.rel, await fsm.readFile(f.abs)); } catch { /* 读不到就跳，写进 manifest */ }
    }
  }
  // collectCard 不回 cardId：按顺序对齐（collectCards 按 cardIds 顺序 push，跳过的在 skipped）
  const skippedIds = new Set(skipped.map(s => s.cardId));
  let bi = 0;
  for (const id of fileIds) {
    if (skippedIds.has(id)) continue;
    const b = bundles[bi++]; if (!b) break;
    relOfNode.set(id, b.files?.[0]?.rel || b.assets?.[0]?.rel || null);
  }
  const hrefOf = (n) => { const r = relOfNode.get(n.id); return r ? `../${r.split('/').map(encodeURIComponent).join('/')}` : null; };
  const svg = toSvg(g, board, { hrefOf });
  zip.file('board/graph.json', JSON.stringify({ version: 1, tag, layer, ...g, files: Object.fromEntries(relOfNode), skipped }, null, 2));
  zip.file('board/graph.svg', svg);
  zip.file('board/graph.mmd', toMermaid(g, board));
  zip.file('index.html', `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(projectName)} · 画布</title>
<style>html,body{margin:0;background:#F0EADB;font-family:'Kaiti SC','KaiTi',serif}header{padding:12px 20px;color:#2B2117;font-size:14px}main{overflow:auto;padding:0 20px 20px}svg{max-width:100%;height:auto;display:block}a:hover rect{stroke:#b08c4f;stroke-width:2}</style></head>
<body><header>${esc(projectName)} · 画布导出${tag ? ` · #${esc(tag)}` : ''} · ${g.nodes.length} 件 ${g.edges.length} 线 · 点卡片打开文件</header><main>${svg.replace(/\.\.\//g, '')}</main></body></html>`);
  return { zip, skipped, count: { nodes: g.nodes.length, edges: g.edges.length, files: relOfNode.size } };
}
