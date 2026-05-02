/**
 * _probe-webfetch.js — 验证 SMALL_FAST_MODEL=haiku-default 失效时 WebFetch 行为
 *
 * brief 让主 agent 用 WebFetch 取一个简单页，看：
 *   1. binary 内部 WebFetch 总结是否真发到 claude-haiku
 *   2. claude-haiku 400 "模型不存在" 后 binary 返给 agent 的是什么
 *      （raw HTML / 空 / 错误）
 *   3. 主 agent 能不能继续工作
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runAgent } from './engine/agent/loop.js';
import { EventBus } from './engine/agent/events.js';
import { _truncateRunsTable, createRun } from './engine/runs/store.js';

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesign-probe-wf-'));
  const sessionRoot = path.join(tmpRoot, 'session-1');
  fs.mkdirSync(sessionRoot, { recursive: true });
  console.log(`[probe] tmp workspace: ${sessionRoot}`);

  _truncateRunsTable();
  const run = createRun({
    skillId: 'hello-world',
    brief: '用 WebFetch 工具取这个页面的内容并告诉我标题和概述（≤80字）：https://example.com',
  });
  console.log(`[probe] runId=${run.id}`);

  const bus = new EventBus();
  const counters = { tool_use: 0, tool_result: 0, tool_error: 0 };
  const toolResults = [];
  const toolUses = [];
  bus.subscribe('*', e => {
    if (e.type === 'run.delta.tool_use') {
      counters.tool_use++;
      toolUses.push({ name: e.name, input: e.input });
    }
    if (e.type === 'run.delta.tool_result') {
      counters.tool_result++;
      if (!e.ok) counters.tool_error++;
      toolResults.push({ ok: e.ok, output: typeof e.output === 'string' ? e.output.slice(0, 400) : e.output });
    }
  });

  try {
    const res = await runAgent({
      runId: run.id,
      skillId: 'hello-world',
      brief: run.brief,
      eventBus: bus,
      sessionId: '00000000-0000-0000-0000-000000000002',
      sessionWorkspaceRoot: sessionRoot,
      projectId: 'probe-wf',
    });
    console.log(`[probe] OK turns=${res.snapshot.counters.turns} cost=$${res.snapshot.counters.totalCostUsd}`);
    console.log(`[probe] finalText (first 400ch):`, res.finalText?.slice(0, 400));
  } catch (err) {
    console.log(`[probe] FAILED: ${err.message?.slice(0, 200)}`);
  }
  console.log(`[probe] tool_use:${counters.tool_use} tool_result:${counters.tool_result} tool_error:${counters.tool_error}`);
  console.log(`[probe] tool_uses:`, JSON.stringify(toolUses, null, 2).slice(0, 600));
  console.log(`[probe] tool_results:`, JSON.stringify(toolResults, null, 2).slice(0, 1200));
}

main().then(() => process.exit(0)).catch(err => {
  console.error('[probe] uncaught:', err);
  process.exit(1);
});
