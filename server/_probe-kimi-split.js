/**
 * _probe-kimi-split.js — 调查 Kimi "reasoning_content missing" 续 turn 拒
 *
 * 目标：让 binary-fixup-proxy 的 NODESIGN_DEBUG_KIMI=1 日志吐出实际 outgoing
 * /v1/messages body 的 messages 数组结构，验证 SDK binary 续 turn 时是否把
 * 同 message.id 的多条 JSONL entries merge 回单条 message。
 *
 * 跑：NODESIGN_DEBUG_KIMI=1 node server/_probe-kimi-split.js
 *
 * 验证 brief 设计要点：
 *   - 触发 tool_use（Bash ls）→ tool_result → assistant 续话（multi-step）
 *   - 让 SDK 在同 run 内多次 POST /v1/messages，second POST 包含
 *     [user, assistant(thinking+tool_use), user(tool_result)] —— 看是否拆开
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAgent } from './engine/agent/loop.js';
import { EventBus } from './engine/agent/events.js';
import { _truncateRunsTable, createRun } from './engine/runs/store.js';

async function main() {
  // 临时 workspace（避免污染 projects-data）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesign-probe-'));
  const sessionRoot = path.join(tmpRoot, 'session-1');
  fs.mkdirSync(sessionRoot, { recursive: true });
  console.log(`[probe] tmp workspace: ${sessionRoot}`);

  _truncateRunsTable();
  const run = createRun({
    skillId: 'hello-world',
    brief: '请用 Bash 工具执行 `echo hello` 然后告诉我输出',
  });
  console.log(`[probe] runId=${run.id}`);

  const bus = new EventBus();
  const counters = { 'tool_use': 0, 'tool_result': 0, 'thinking': 0, 'text': 0 };
  bus.subscribe('*', e => {
    if (e.type === 'run.delta.tool_use') counters.tool_use++;
    else if (e.type === 'run.delta.tool_result') counters.tool_result++;
    else if (e.type === 'run.delta.thinking') counters.thinking++;
    else if (e.type === 'run.delta.text') counters.text++;
  });

  try {
    const res = await runAgent({
      runId: run.id,
      skillId: 'hello-world',
      brief: run.brief,
      eventBus: bus,
      sessionId: '00000000-0000-0000-0000-000000000001',  // 任意有效 UUID
      sessionWorkspaceRoot: sessionRoot,
      projectId: 'probe-proj',
    });
    console.log(`[probe] OK turns=${res.snapshot.counters.turns} cost=$${res.snapshot.counters.totalCostUsd}`);
  } catch (err) {
    console.log(`[probe] FAILED: ${err.message}`);
    if (err.code) console.log(`[probe] code: ${err.code}`);
  }
  console.log(`[probe] event counters: ${JSON.stringify(counters)}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('[probe] uncaught:', err);
  process.exit(1);
});
