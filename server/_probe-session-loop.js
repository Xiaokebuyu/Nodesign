/**
 * _probe-session-loop.js — Phase 1.2 验证 runSession + active-runs querySession API
 *
 * 跟 _probe-streaminput.js 区别：那个测 raw SDK，这个测 NoDesign 包装层。
 *
 * 跑：node --env-file-if-exists=.env server/_probe-session-loop.js
 * 通过条件：跑出 turns=2 + turn 2 引用 turn 1 token + run.done event 收到
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runSession } from './engine/agent/session-loop.js';
import { EventBus } from './engine/agent/events.js';
import { createRun, _truncateRunsTable } from './engine/runs/store.js';
import { AsyncQueue } from './lib/async-queue.js';
import { pushUserMessage, closeQuerySession } from './engine/runs/active-runs.js';

const TURN_1_TOKEN = 'sl_turn1_alpha';
const TURN_2_TOKEN = 'sl_turn2_beta';

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesign-probe-sl-'));
  const sessionRoot = path.join(tmpRoot, 'sessions', '00000000-0000-0000-0000-000000000abc');
  fs.mkdirSync(path.join(sessionRoot, '.claude', 'projects'), { recursive: true });
  console.log(`[probe-sl] sessionRoot: ${sessionRoot}`);

  _truncateRunsTable();
  const sessionId = '00000000-0000-0000-0000-000000000abc';
  const projectId = 'probe-sl-proj';

  const bus = new EventBus();

  // 收集 events
  const events = { start: 0, done: 0, cancelled: 0, error: 0 };
  const finalTexts = [];
  bus.subscribe('*', (e) => {
    if (e.type === 'run.start') events.start++;
    if (e.type === 'run.done') {
      events.done++;
      finalTexts.push(e.finalText || '');
    }
    if (e.type === 'run.cancelled') events.cancelled++;
    if (e.type === 'run.error') events.error++;
  });

  // 起 runSession（背景跑）
  const inputQueue = new AsyncQueue();
  const sessionPromise = runSession({
    sessionId,
    projectId,
    sessionWorkspaceRoot: sessionRoot,
    eventBus: bus,
    inputQueue,
    skillId: 'hello-world',
  }).catch((err) => {
    console.error('[probe-sl] runSession threw:', err.message);
    throw err;
  });

  // 等 SDK 启动稳定一下（没办法显式等 query handle ready，用 short timeout）
  await new Promise((r) => setTimeout(r, 1500));

  // turn 1
  const run1 = createRun({ skillId: 'hello-world', brief: 'turn 1', projectId });
  console.log(`[probe-sl] >>> turn 1 runId=${run1.id.slice(0, 12)}`);
  const ok1 = pushUserMessage(sessionId, run1.id, {
    type: 'user',
    message: {
      role: 'user',
      content: `Use Bash to run \`echo "${TURN_1_TOKEN}"\` and tell me the exact output.`,
    },
    parent_tool_use_id: null,
  });
  if (!ok1) throw new Error('pushUserMessage turn 1 failed');

  // 等 turn 1 done
  await waitForEvent(bus, (e) => e.type === 'run.done' && e.runId === run1.id, 90000);
  console.log(`[probe-sl] <<< turn 1 done — final length=${finalTexts[0]?.length || 0}`);

  // turn 2
  const run2 = createRun({ skillId: 'hello-world', brief: 'turn 2', projectId });
  console.log(`[probe-sl] >>> turn 2 runId=${run2.id.slice(0, 12)} (references turn 1)`);
  const ok2 = pushUserMessage(sessionId, run2.id, {
    type: 'user',
    message: {
      role: 'user',
      content: `Now run \`echo "${TURN_2_TOKEN}"\` and report BOTH this output and the previous one (mention "${TURN_1_TOKEN}" verbatim).`,
    },
    parent_tool_use_id: null,
  });
  if (!ok2) throw new Error('pushUserMessage turn 2 failed');

  await waitForEvent(bus, (e) => e.type === 'run.done' && e.runId === run2.id, 90000);
  console.log(`[probe-sl] <<< turn 2 done — final length=${finalTexts[1]?.length || 0}`);

  // close session
  console.log(`[probe-sl] closing session`);
  closeQuerySession(sessionId, 'probe_done');
  await sessionPromise.catch(() => { /* close 后可能 throw，忽略 */ });

  // verify
  console.log(`\n[probe-sl] ===================== VERIFY =====================`);
  console.log(`[probe-sl] events: start=${events.start} done=${events.done} cancelled=${events.cancelled} error=${events.error}`);
  console.log(`[probe-sl] turn1 final (240ch): ${finalTexts[0]?.slice(0, 240).replace(/\n/g, ' ⏎ ')}`);
  console.log(`[probe-sl] turn2 final (240ch): ${finalTexts[1]?.slice(0, 240).replace(/\n/g, ' ⏎ ')}`);

  const pf = (b) => b ? 'PASS' : 'FAIL';
  const v1 = (finalTexts[0] || '').includes(TURN_1_TOKEN);
  const v2 = (finalTexts[1] || '').includes(TURN_2_TOKEN);
  const v3 = (finalTexts[1] || '').includes(TURN_1_TOKEN);
  const v4 = events.start === 2;
  const v5 = events.done === 2;
  console.log(`[probe-sl] [${pf(v1)}] turn 1 final mentions ${TURN_1_TOKEN}`);
  console.log(`[probe-sl] [${pf(v2)}] turn 2 final mentions ${TURN_2_TOKEN}`);
  console.log(`[probe-sl] [${pf(v3)}] turn 2 final mentions ${TURN_1_TOKEN} (context preserved)`);
  console.log(`[probe-sl] [${pf(v4)}] run.start emitted twice (per-turn)`);
  console.log(`[probe-sl] [${pf(v5)}] run.done emitted twice`);

  const allPass = v1 && v2 && v3 && v4 && v5;
  console.log(`[probe-sl] OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
  process.exit(allPass ? 0 : 2);
}

function waitForEvent(bus, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`waitForEvent timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = bus.subscribe('*', (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(e);
      }
    });
  });
}

main().catch((err) => {
  console.error('[probe-sl] uncaught:', err);
  process.exit(1);
});
