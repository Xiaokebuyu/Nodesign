/**
 * board.json 关系层（bindings）的真跑校验。
 *
 * 走**完整的读改写路径**（patchBoard → 落盘 → 再读回），不是只测纯函数 ——
 * 这一层真正容易出错的地方在合并与清理的时序上，纯函数测不到。
 *
 * 跑法：
 *   PROJECTS_DATA_DIR=$(mktemp -d) node server/projects/_board-bindings-check.mjs
 * 脚本自己会兜底建临时目录，直接 `node` 跑也行。
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// 必须在 import board-store 之前定下数据根：workspace.js 在模块加载时就读它
if (!process.env.PROJECTS_DATA_DIR) {
  process.env.PROJECTS_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-board-'));
}
const DATA_DIR = process.env.PROJECTS_DATA_DIR;

const { readBoard, patchBoard, replaceBoard, MAX_BINDINGS } =
  await import('./board-store.js');
const { BINDING_TYPE_IDS } = await import('../lib/binding-types.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实得 ${a}`);
}

let n = 0;
const nextPid = () => `proj_check_${Date.now().toString(36)}_${n++}`;

// ── 1. 基本读写 ────────────────────────────────────────────────────────
{
  const pid = nextPid();
  const empty = await readBoard(pid);
  eq('空板带 bindings 字段', Object.keys(empty).sort(), ['bindings', 'objects', 'size', 'zones']);
  eq('空板 bindings 是空对象', empty.bindings, {});

  const b = await patchBoard(pid, {
    bindings: { r1: { type: 'derives-from', from: 'a.png', to: 'b.png' } },
  });
  eq('写入一条关系', b.bindings.r1, { type: 'derives-from', from: 'a.png', to: 'b.png' });

  const again = await readBoard(pid);
  eq('落盘后读回一致', again.bindings.r1, b.bindings.r1);
}

// ── 2. 校验规则 ────────────────────────────────────────────────────────
{
  const pid = nextPid();
  const b = await patchBoard(pid, {
    bindings: {
      good: { type: 'annotates', from: 'note.md', to: 'deck:task/x' },
      badType: { type: 'wat', from: 'a', to: 'b' },
      selfLoop: { type: 'flow', from: 'a', to: 'a' },
      noFrom: { type: 'flow', to: 'b' },
      noTo: { type: 'flow', from: 'a' },
      notObject: 'nope',
    },
  });
  eq('只有合法那条留下', Object.keys(b.bindings), ['good']);

  const b2 = await patchBoard(pid, {
    bindings: {
      labeled: { type: 'ref', from: 'a', to: 'b', label: '  取自这张  ', by: 'agent' },
      badBy: { type: 'ref', from: 'c', to: 'd', by: '第三方' },
      emptyLabel: { type: 'ref', from: 'e', to: 'f', label: '   ' },
    },
  });
  eq('label 去空白', b2.bindings.labeled.label, '取自这张');
  eq('by 白名单内保留', b2.bindings.labeled.by, 'agent');
  ok('by 不在白名单就丢字段', !('by' in b2.bindings.badBy));
  ok('空 label 不存字段（渲染时回落词汇表默认词）', !('label' in b2.bindings.emptyLabel));

  const b3 = await patchBoard(pid, {
    bindings: { long: { type: 'flow', from: 'a', to: 'b', label: '很长'.repeat(100) } },
  });
  ok('label 截到 60 字', b3.bindings.long.label.length === 60);
}

// ── 3. 词汇表五种全收 ──────────────────────────────────────────────────
{
  const pid = nextPid();
  const patch = {};
  BINDING_TYPE_IDS.forEach((t, i) => { patch[`t${i}`] = { type: t, from: 'a', to: 'b' }; });
  const b = await patchBoard(pid, { bindings: patch });
  eq('词汇表里每一种都能写进去', Object.keys(b.bindings).length, BINDING_TYPE_IDS.length);
}

// ── 4. 删除端点连带清线 ────────────────────────────────────────────────
{
  const pid = nextPid();
  await patchBoard(pid, {
    objects: { 'a.png': { x: 10, y: 10, z: 1 }, 'b.png': { x: 20, y: 20, z: 1 } },
    zones: { 'task/甲': { x: 0, y: 0, w: 1120, h: 640 } },
    bindings: {
      r1: { type: 'derives-from', from: 'a.png', to: 'b.png' },
      r2: { type: 'ref', from: 'a.png', to: 'task/甲' },
      r3: { type: 'flow', from: 'b.png', to: 'c.png' },
    },
  });

  const afterObj = await patchBoard(pid, { objects: { 'a.png': null } });
  eq('删物件连带清掉它两端的线', Object.keys(afterObj.bindings).sort(), ['r3']);

  const afterZone = await patchBoard(pid, { zones: { 'task/甲': null } });
  eq('删工作区同样清线（r3 与它无关，留着）', Object.keys(afterZone.bindings), ['r3']);
}

// ── 5. 关键回归：稀疏 objects 不能当存在性判据 ─────────────────────────
//
// board.objects 只存被拖过 / pin 过的物件，**没动过的产物压根没有条目**。
// 如果清线时拿"在不在 board.objects 里"当判据，连向这些产物的线会被全灭。
// 这条是设计时差点踩进去的坑，钉在这里。
{
  const pid = nextPid();
  const b = await patchBoard(pid, {
    bindings: { r: { type: 'derives-from', from: '从未摆过.png', to: '也没摆过.png' } },
  });
  eq('两端都不在 objects 里的线照样存活', Object.keys(b.bindings), ['r']);

  // 再跑一次无关的 patch，确认它不会在后续写入中被顺手清掉
  const b2 = await patchBoard(pid, { objects: { 'x.png': { x: 1, y: 1, z: 1 } } });
  eq('后续无关写入也不误删', Object.keys(b2.bindings), ['r']);

  const b3 = await patchBoard(pid, { objects: { 'x.png': null } });
  eq('删的是别的物件，线仍在', Object.keys(b3.bindings), ['r']);
}

// ── 6. 上限 ────────────────────────────────────────────────────────────
{
  const pid = nextPid();
  const patch = {};
  for (let i = 0; i < MAX_BINDINGS + 50; i++) patch[`r${i}`] = { type: 'flow', from: `a${i}`, to: `b${i}` };
  const b = await patchBoard(pid, { bindings: patch });
  ok('不超过 MAX_BINDINGS', Object.keys(b.bindings).length <= MAX_BINDINGS,
    `实得 ${Object.keys(b.bindings).length}`);

  // 已存在的条目即使到顶也应可更新（不然满了之后就改不动线了）
  const someId = Object.keys(b.bindings)[0];
  const b2 = await patchBoard(pid, { bindings: { [someId]: { type: 'contrast', from: 'p', to: 'q' } } });
  eq('到顶后仍可更新已有条目', b2.bindings[someId].type, 'contrast');
}

// ── 7. 老板子（没有 bindings 字段）向后兼容 ────────────────────────────
{
  const pid = nextPid();
  const legacy = await replaceBoard(pid, {
    size: { w: 4000, h: 2600 },
    zones: { z1: { x: 0, y: 0, w: 1120, h: 640 } },
    objects: { 'a.png': { x: 5, y: 5, z: 2 } },
    // 故意不写 bindings，模拟升级前的存量 board.json
  });
  eq('老板子补出空 bindings', legacy.bindings, {});
  const added = await patchBoard(pid, { bindings: { r: { type: 'flow', from: 'a.png', to: 'b.png' } } });
  eq('老板子能直接加线，不用迁移', Object.keys(added.bindings), ['r']);
  eq('原有物件没被动过', added.objects['a.png'], { x: 5, y: 5, z: 2 });
}

// ── 8. 画布原生物件（涂鸦）──────────────────────────────────────────────
{
  const pid = nextPid();
  const b = await patchBoard(pid, {
    objects: {
      's1': { x: 10, y: 10, z: 1, w: 200, h: 120, kind: 'scribble', data: { d: 'M 0 0 L 10 10', color: 'red', width: 3 } },
      // 登记了 kind 但内容非法 → 整条丢弃（留空壳会变成删不掉的幽灵）
      's2': { x: 0, y: 0, z: 1, kind: 'scribble', data: { d: '<script>' } },
      's3': { x: 0, y: 0, z: 1, kind: 'scribble' },
      // 不在白名单里的 kind → 当普通布局收（不带 kind），不是丢弃
      's4': { x: 5, y: 5, z: 1, kind: '木马', data: { d: 'M 0 0' } },
    },
  });
  eq('合法涂鸦落盘', b.objects.s1.data, { d: 'M 0 0 L 10 10', color: 'red', width: 3 });
  eq('涂鸦带 kind 标记', b.objects.s1.kind, 'scribble');
  ok('路径非法整条丢', !b.objects.s2);
  ok('缺 data 整条丢', !b.objects.s3);
  ok('未登记的 kind 不留痕', b.objects.s4 && !('kind' in b.objects.s4));

  const b2 = await patchBoard(pid, {
    objects: { 's5': { x: -400, y: -300, z: 1, kind: 'scribble', data: { d: 'M 1 1' } } },
  });
  ok('画布原生物件可以住负坐标（产物旁边的余白）', b2.objects.s5.x === -400 && b2.objects.s5.y === -300);

  const b3 = await patchBoard(pid, { objects: { 'a.png': { x: -400, y: -300, z: 1 } } });
  ok('磁盘产物仍夹在正区间', b3.objects['a.png'].x === 0 && b3.objects['a.png'].y === 0);

  const b4 = await patchBoard(pid, {
    objects: { 'long': { x: 0, y: 0, z: 1, kind: 'scribble', data: { d: 'M 0 0 ' + 'L 1 1 '.repeat(4000) } } },
  });
  ok('超长路径被截断而不是拒收', b4.objects.long && b4.objects.long.data.d.length <= 8000);

  const b5 = await patchBoard(pid, {
    objects: { 'c': { x: 0, y: 0, z: 1, kind: 'scribble', data: { d: 'M 0 0', color: '紫', width: 999 } } },
  });
  eq('颜色不在词汇表回落 ink', b5.objects.c.data.color, 'ink');
  ok('线宽夹在 1~24', b5.objects.c.data.width === 24);
}

// ── 9. relate_on_board 工具走完整路径 ────────────────────────────────────
{
  const pid = nextPid();
  const { makeRelateOnBoardAlias: makeRelateOnBoardTool } = await import('../engine/mcp/tools/edit-board.js');
  const emitted = [];
  const t = makeRelateOnBoardTool({ projectId: pid, ctx: { emit: (e) => emitted.push(e) } });

  eq('工具名', t.name, 'relate_on_board');

  const r1 = await t.handler({ type: 'derives-from', from: 'v2.html', to: 'v1.html' });
  ok('画一条成功', !r1.isError, JSON.stringify(r1).slice(0, 120));
  const b1 = await readBoard(pid);
  const rows = Object.values(b1.bindings);
  eq('落盘了一条', rows.length, 1);
  eq('作者是 agent', rows[0].by, 'agent');
  eq('类型正确', rows[0].type, 'derives-from');

  // 广播必须是 project 级（sessionId 显式 null），否则别的 tab 看不到
  eq('广播了 board.updated', emitted.length, 1);
  eq('广播是 project 级', emitted[0].sessionId, null);

  const r2 = await t.handler({ type: 'flow', from: 'same', to: 'same' });
  ok('自环被拒且说明原因', r2.isError === true);
  eq('自环没落盘', Object.keys((await readBoard(pid)).bindings).length, 1);

  const r3 = await t.handler({ type: 'contrast', from: 'a', to: 'b', label: '暖 vs 冷' });
  ok('带标签的无向关系', !r3.isError);
  const withLabel = Object.values((await readBoard(pid)).bindings).find(x => x.type === 'contrast');
  eq('标签落盘', withLabel.label, '暖 vs 冷');

  const noProj = makeRelateOnBoardTool({ projectId: null });
  ok('没有项目时明确报错而不是静默失败', (await noProj.handler({ type: 'flow', from: 'a', to: 'b' })).isError === true);
}

// ── 收尾 ───────────────────────────────────────────────────────────────
await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

if (fails.length) {
  console.error(`\n✗ ${fails.length} 条失败 / ${pass + fails.length} 条：`);
  fails.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`✓ board bindings ${pass}/${pass} 条全过`);
