/**
 * engine/_smoke.js — 底层骨架的烟雾测试
 *
 * 验证三件事：
 *   1. runs 表能正确创建、状态转移
 *   2. workspace 沙盒能 create / write / read / list
 *   3. 越界路径被拦截
 *
 * 跑：node server/engine/_smoke.js
 *
 * 不依赖 KIMI_API_KEY、不依赖 npm install playwright（只需要 better-sqlite3）。
 */

import {
  createRun,
  getRun,
  listRuns,
  markRunStarted,
  markRunSucceeded,
  markRunFailed,
  mergeRunMetadata,
  _truncateRunsTable,
} from './runs/store.js';

import {
  ensureWorkspace,
  writeFile,
  readFile,
  listDir,
  exists,
  safeResolve,
  removeRun,
} from './runtime/workspace.js';

const log = (s) => console.log(`  ${s}`);
const ok = (s) => console.log(`  ✅ ${s}`);
const fail = (s, e) => { console.error(`  ❌ ${s}`, e); process.exit(1); };

async function main() {
  console.log('\n[smoke] engine 底层骨架\n');

  // ── 0. 清空（防止上次残留）──
  _truncateRunsTable();

  // ── 1. createRun ──
  console.log('1) createRun');
  const run = createRun({ skillId: 'deskskill-engine', brief: '做一个介绍 Nodesign 的 deck' });
  if (!run.id || run.status !== 'pending') fail('createRun 后状态不对', run);
  ok(`run ${run.id} created, status=${run.status}`);

  // ── 2. 状态转移 ──
  console.log('2) 状态转移');
  let r = markRunStarted(run.id);
  if (r.status !== 'running' || !r.startedAt) fail('markRunStarted 失败', r);
  ok(`pending → running, started_at=${r.startedAt}`);

  // 重复 start 应该抛
  try {
    markRunStarted(run.id);
    fail('重复 markRunStarted 没抛错');
  } catch (e) {
    ok(`重复 start 正确抛错: ${e.message}`);
  }

  r = mergeRunMetadata(run.id, { roundCount: 3, tokenUsage: { input: 1234, output: 567 } });
  if (r.metadata.roundCount !== 3) fail('mergeRunMetadata 失败', r.metadata);
  ok(`metadata 合并成功: ${JSON.stringify(r.metadata)}`);

  // ── 3. workspace 操作 ──
  console.log('3) workspace 沙盒');
  const wsRoot = await ensureWorkspace(run.id);
  ok(`ensureWorkspace → ${wsRoot}`);

  await writeFile(run.id, 'deck.html', '<html><body>Hello Nodesign</body></html>');
  await writeFile(run.id, 'design-notes.md', '# 设计决策\n\n用极简风格');
  await writeFile(run.id, 'assets/logo.svg', '<svg/>'); // 嵌套目录自动 mkdir
  ok('writeFile × 3（含嵌套目录）');

  const html = await readFile(run.id, 'deck.html');
  if (!html.includes('Hello Nodesign')) fail('readFile 内容不对', html);
  ok('readFile 内容正确');

  const root = await listDir(run.id, '.');
  const names = root.map(e => e.name).sort();
  if (!names.includes('deck.html') || !names.includes('design-notes.md') || !names.includes('assets')) {
    fail('listDir 缺文件', names);
  }
  ok(`listDir → [${names.join(', ')}]`);

  const assets = await listDir(run.id, 'assets');
  if (assets[0]?.name !== 'logo.svg') fail('listDir assets 错', assets);
  ok(`listDir assets/ → [${assets.map(e => e.name).join(', ')}]`);

  if (!(await exists(run.id, 'deck.html'))) fail('exists 应为 true');
  if (await exists(run.id, 'nope.txt')) fail('exists 应为 false');
  ok('exists 正确');

  // ── 4. 越界拦截 ──
  console.log('4) 越界拦截');
  const evilPaths = [
    '../etc/passwd',
    '../../node_modules/anything',
    '/etc/passwd',
    '',
    '.',
    './../escape',
  ];
  for (const p of evilPaths) {
    let blocked = false;
    try { safeResolve(run.id, p); } catch { blocked = true; }
    if (!blocked) fail(`越界路径未被拦截: ${JSON.stringify(p)}`);
  }
  ok(`越界拦截 × ${evilPaths.length}（含空串、绝对路径、.. 跳出、自身）`);

  // ── 5. 终态 ──
  console.log('5) 终态 + 失败路径');
  r = markRunSucceeded(run.id, { artifactPath: 'deck.html' });
  if (r.status !== 'succeeded' || r.artifactPath !== 'deck.html') fail('markRunSucceeded 失败', r);
  ok(`running → succeeded, artifact=${r.artifactPath}`);

  // 已终态再 start 应抛
  try {
    markRunStarted(run.id);
    fail('终态后 markRunStarted 没抛错');
  } catch (e) {
    ok(`终态后 start 正确抛错: ${e.message}`);
  }

  // ── 6. 失败路径独立验证 ──
  const r2 = createRun({ skillId: 'deskskill-engine', brief: 'failing run' });
  markRunStarted(r2.id);
  const failed = markRunFailed(r2.id, 'kimi 503');
  if (failed.status !== 'failed' || failed.error !== 'kimi 503') fail('markRunFailed 失败', failed);
  ok(`独立失败路径: ${failed.id} → failed, error=${failed.error}`);

  // ── 7. listRuns ──
  console.log('7) listRuns');
  const all = listRuns({ limit: 10 });
  if (all.length !== 2) fail(`期望 2 条，实际 ${all.length}`, all);
  const succeeded = listRuns({ status: 'succeeded' });
  const failedList = listRuns({ status: 'failed' });
  if (succeeded.length !== 1 || failedList.length !== 1) fail('按 status 过滤不对');
  ok(`listRuns 全部 ${all.length}, succeeded ${succeeded.length}, failed ${failedList.length}`);

  // ── 8. 清理 ──
  console.log('8) 清理');
  await removeRun(run.id);
  await removeRun(r2.id);
  ok('removeRun 完成（rm -rf）');

  console.log('\n✅ 全部通过\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ smoke 抛异常:', err);
  process.exit(1);
});
