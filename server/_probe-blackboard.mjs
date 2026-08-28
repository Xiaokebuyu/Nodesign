/**
 * _probe-blackboard.mjs —— 黑板工具真数据冒烟（2026-08-23）
 *   node --env-file=.env server/_probe-blackboard.mjs <projectId> [--keep]
 * 直接调 MCP 工具 handler：read_board → write_on_board(图) → read_board{tag} → look_at_board{tag}
 * → edit_board commit → look_at_board。截图落 ~/claude-report-file/blackboard/。
 * 不带 --keep 时最后把草图擦掉（edit_board erase_group），board.json 回原样。
 * （08-28 别名收摊：sketch_on_board/finish_sketch 已下线，探针改走现役入口。）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeReadBoardTool } from './engine/mcp/tools/read-board.js';
import { makeEditBoardTool as makeEditSketchTool } from './engine/mcp/tools/edit-board.js';
import { makeWriteOnBoardTool } from './engine/mcp/tools/write-on-board.js';
import { getSharedDir } from './projects/workspace.js';
import { makeLookAtBoardTool } from './engine/mcp/tools/look-at-board.js';
import { makeReadUserViewTool } from './engine/mcp/tools/read-user-view.js';
import { readBoard } from './projects/board-store.js';

const projectId = process.argv[2];
const keep = process.argv.includes('--keep');
if (!projectId) { console.error('usage: node --env-file=.env server/_probe-blackboard.mjs <projectId> [--keep]'); process.exit(1); }
const OUT = path.join(os.homedir(), 'claude-report-file', 'blackboard');
fs.mkdirSync(OUT, { recursive: true });
const ctx = { counters: { turns: 1 }, emit: (e) => console.log('  [emit]', e.type, e.summary || '') };
const txt = (r) => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const img = (r, name) => {
  const im = r.content.find(c => c.type === 'image');
  if (!im) return null;
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(im.data, 'base64'));
  return p;
};

const read = makeReadBoardTool({ projectId });
const edit = makeEditSketchTool({ projectId, ctx });
const write = makeWriteOnBoardTool({ projectId, sharedRoot: getSharedDir(projectId), sessionId: null, ctx });
const look = makeLookAtBoardTool({ projectId, ctx });
const view = makeReadUserViewTool({ projectId });

const before = await readBoard(projectId);
console.log('== read_board (before) ==\n' + txt(await read.handler({}, {})));
console.log('\n== read_user_view ==\n' + txt(await view.handler({}, {})));

// 锚到板上第一件有座位的产物
const anchor = Object.entries(before.objects).find(([id, e]) => !e.kind && Number.isFinite(e.x))?.[0] || null;
console.log('\nanchor =', anchor);

const tag = `probe-${Date.now().toString(36)}`;
const r1 = await write.handler({
  title: '黑板冒烟：三个方向',
  tag,
  near: anchor || undefined,
  layout: 'mindmap',
  nodes: [
    { id: 'c', text: '**核心问题**\n\n下一步做什么？', format: 'md', size: 'lg', font: 'kai' },
    { id: 'a', text: '方向 A：扩产物类型', font: 'pen' },
    { id: 'b', text: '方向 B：移动端\n（上次没过关）', font: 'pen', color: 'red' },
    { id: 'd', text: '方向 C：公式 $E=mc^2$ 与表格\n\n| 项 | 值 |\n|---|---|\n| 成本 | 低 |\n| 风险 | 中 |', format: 'md', size: 'sm' },
    { id: 'm', text: '```mermaid\nflowchart LR\n  A[想法] --> B[草图] --> C[看一眼] --> D[落定]\n```', format: 'md', size: 'sm', w: 14 },
  ],
  shapes: [
    { kind: 'circle', around: 'c', color: 'brass' },
    { kind: 'underline', around: 'b', color: 'red' },
    { kind: 'rect', around: 'd', color: 'pencil' },
  ],
  edges: [
    { from: 'c', to: 'a', type: 'link', material: 'pencil' },
    { from: 'c', to: 'b', type: 'link', material: 'pencil', label: '先放放' },
    { from: 'c', to: 'd', type: 'link', material: 'ink' },
    { from: 'c', to: 'm', type: 'flow', material: 'pencil' },
    ...(anchor ? [{ from: 'a', to: anchor, type: 'ref', material: 'yarn', label: '证物' }] : []),
  ],
}, {});
console.log('\n== write_on_board(图) ==\n' + txt(r1), r1.isError ? '(ERROR)' : '');

console.log('\n== read_board {tag} ==\n' + txt(await read.handler({ tag }, {})));

console.log('\n== look_at_board {tag} (staging) ==');
const t0 = Date.now();
const l1 = await look.handler({ tag }, {});
console.log(txt(l1), l1.isError ? '(ERROR)' : '', `${Date.now() - t0}ms`, img(l1, `${tag}-staging.png`) || '(no image)');

// 取 id 做编辑
const ids = Object.fromEntries(txt(r1).split('\n').find(l => l.startsWith('ids:')).slice(5).split(', ').map(kv => kv.split('=')));
const r2 = await edit.handler({ tag, ops: [
  { op: 'set_text', id: ids.a, text: '方向 A：扩产物类型（改过字了）', color: 'brass' },
  { op: 'move', id: ids.b, to: { ref: ids.d, side: 'below', gap: 1 } },
  { op: 'add_node', id: 'n1', text: '新加的支：先做黑板', at: { ref: ids.a, side: 'right', gap: 2 } },
  { op: 'add_edge', from: 'n1', to: ids.a, type: 'flow', material: 'pencil' },
  { op: 'remove', id: ids.s2 },
  { op: 'move', id: 'no-such-id', to: { dx: 1, dy: 1 } },
] }, {});
console.log('\n== edit_board ==\n' + txt(r2), r2.isError ? '(ERROR)' : '');
const l1b = await look.handler({ tag }, {});
console.log('look (edited):', img(l1b, `${tag}-edited.png`) || txt(l1b));

console.log('\n== edit_board commit ==\n' + txt(await edit.handler({ ops: [{ op: 'commit', tag }] }, {})));
const l2 = await look.handler({ tag }, {});
console.log('look (committed):', txt(l2).slice(0, 80), img(l2, `${tag}-committed.png`) || '(no image)');
const l3 = await look.handler({}, {});
console.log('look (overview):', img(l3, `${tag}-overview.png`) || '(no image)');

// ── 板书：贴着产物写一条 + 回一条（线程）──
const w1 = await write.handler({ text: '**这一版改了什么**\n\n- 暗底换成纸本\n- 标题字重降一档\n\n看右上角那块留白够不够？', near: anchor || undefined, tag }, {});
console.log('\n== write_on_board (near) ==\n' + txt(w1), w1.isError ? '(ERROR)' : '');
const p1 = /board note (\S+) at/.exec(txt(w1))?.[1];
const w2 = p1 ? await write.handler({ text: '补一句：留白是故意的，给第二版的标注留位置。', reply_to: p1, tag }, {}) : null;
if (w2) console.log('== write_on_board (reply_to) ==\n' + txt(w2), w2.isError ? '(ERROR)' : '');
console.log('\n== read_board {tag} (with chalk) ==\n' + txt(await read.handler({ tag }, {})).split('\n').filter(l => /板书|notes\/板书|组 /.test(l)).join('\n'));
const l4 = await look.handler({ tag }, {});
console.log('look (chalk):', img(l4, `${tag}-chalk.png`) || txt(l4));

if (!keep) {
  // 擦组连板书文件一起删（removeByTag 管），下面对账 objects 数该回原样
  console.log('\n== erase ==\n' + txt(await edit.handler({ ops: [{ op: 'erase_group', tag }] }, {})));
  const after = await readBoard(projectId);
  console.log('objects before/after:', Object.keys(before.objects).length, Object.keys(after.objects).length,
    'bindings:', Object.keys(before.bindings).length, Object.keys(after.bindings).length);
} else console.log(`\n(kept) tag=${tag}`);
