/**
 * _probe-streaminput.js — Phase 0 spike for SDK streamInput multi-turn behavior
 *
 * Goal: validate that a single SDK query() handle can serve multiple turns when
 * fed an AsyncIterable that yields user messages on demand. Specifically:
 *
 *   1. Push turn 1 user message → wait result → query stays alive
 *   2. Verify control method (getContextUsage) works between turns
 *   3. Push turn 2 user message → wait result
 *   4. Verify turn 2 references turn 1 (conversation context preserved)
 *   5. Close input stream → query ends naturally
 *
 * If all PASS: streamInput is the right architecture for the refactor.
 * If FAIL: alternative is forkSession + jsonl truncate (see plan file).
 *
 * Run:
 *   NODESIGN_DEBUG_KIMI=1 node --env-file-if-exists=.env server/_probe-streaminput.js
 *
 * Dependencies on real env: NODESIGN_GATEWAY_URL / NODESIGN_GATEWAY_KEY (or
 * ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY) — same as runAgent.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getOrStartProxy } from './lib/binary-fixup-proxy.js';

/**
 * AsyncQueue — supports push() + async pull via Symbol.asyncIterator + close().
 * Will become server/lib/async-queue.js in Phase 1; inlined here for spike.
 */
class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) throw new Error('AsyncQueue: push after close');
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }
  close() {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift(), done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  return() {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}

const TURN_1_TOKEN = 'result_one_42';
const TURN_2_TOKEN = 'result_two_99';

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodesign-probe-si-'));
  console.log(`[probe] cwd: ${tmpRoot}`);

  const realGatewayUrl = process.env.NODESIGN_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL;
  let baseUrlForBinary = realGatewayUrl;
  if (realGatewayUrl) {
    try {
      const proxy = await getOrStartProxy(realGatewayUrl);
      baseUrlForBinary = proxy.baseUrl;
      console.log(`[probe] binary-fixup-proxy on ${baseUrlForBinary}`);
    } catch (err) {
      console.warn(`[probe] proxy start failed, fallback direct: ${err.message}`);
    }
  }

  const model = process.env.NODESIGN_PROBE_MODEL || 'kimi-k2.6';
  const inputQueue = new AsyncQueue();

  const q = query({
    prompt: inputQueue,
    options: {
      cwd: tmpRoot,
      model,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrlForBinary,
        ANTHROPIC_API_KEY: process.env.NODESIGN_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'nodesign-probe-si/0.0.1',
        ...(model && /^kimi-k2\.6/i.test(model) ? {
          ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k2.5',
        } : {}),
      },
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      maxTurns: 8,
      thinking: { type: 'enabled', budgetTokens: 4096 },
      effort: 'medium',
    },
  });

  // turn 1
  console.log(`\n[probe] >>> push turn 1`);
  inputQueue.push({
    type: 'user',
    message: {
      role: 'user',
      content: `Use the Bash tool to run \`echo "${TURN_1_TOKEN}"\` and tell me the exact text it printed.`,
    },
    parent_tool_use_id: null,
  });

  let turnCount = 0;
  let turn1Final = '';
  let turn2Final = '';
  let getContextUsageOk = null;
  let interruptOk = null;

  for await (const msg of q) {
    if (msg.type === 'result') {
      turnCount++;
      console.log(`[probe] <<< result turn=${turnCount} subtype=${msg.subtype} terminal=${msg.terminal_reason || '-'}`);
      const text = msg.result || '';
      console.log(`[probe]     final (${text.length}ch): ${text.slice(0, 240).replace(/\n/g, ' ⏎ ')}`);

      if (turnCount === 1) {
        turn1Final = text;

        // probe: control method between turns
        try {
          const usage = await q.getContextUsage();
          getContextUsageOk = !!usage;
          console.log(`[probe] getContextUsage between turns: ${getContextUsageOk ? 'PASS' : 'FAIL'} ${JSON.stringify(usage).slice(0, 160)}`);
        } catch (err) {
          getContextUsageOk = false;
          console.log(`[probe] getContextUsage failed: ${err.message}`);
        }

        // push turn 2
        console.log(`\n[probe] >>> push turn 2 (references turn 1)`);
        inputQueue.push({
          type: 'user',
          message: {
            role: 'user',
            content: `Now use Bash to run \`echo "${TURN_2_TOKEN}"\` and report BOTH outputs (this one and the previous one from your last reply). It is critical that you mention the previous token verbatim.`,
          },
          parent_tool_use_id: null,
        });
      } else if (turnCount === 2) {
        turn2Final = text;
        // close stream → query should end naturally
        console.log(`\n[probe] closing input stream`);
        inputQueue.close();
      }
    } else if (msg.type === 'assistant') {
      const blocks = msg.message?.content || [];
      const kinds = blocks.map((b) => b.type).join(',');
      const stop = msg.message?.stop_reason || '-';
      console.log(`[probe] assistant blocks=[${kinds}] stop=${stop}`);
    } else if (msg.type === 'system') {
      // skip noisy system messages
    }
  }

  // verify
  console.log(`\n[probe] ===================== VERIFY =====================`);
  const v1 = turn1Final.includes(TURN_1_TOKEN);
  const v2 = turn2Final.includes(TURN_2_TOKEN);
  const v3 = turn2Final.includes(TURN_1_TOKEN);
  const v4 = turnCount === 2;
  const v5 = getContextUsageOk === true;

  const pf = (b) => b ? 'PASS' : 'FAIL';
  console.log(`[probe] [${pf(v1)}] turn 1 mentions ${TURN_1_TOKEN}`);
  console.log(`[probe] [${pf(v2)}] turn 2 mentions ${TURN_2_TOKEN}`);
  console.log(`[probe] [${pf(v3)}] turn 2 references turn 1 (${TURN_1_TOKEN} appears)`);
  console.log(`[probe] [${pf(v4)}] both turns completed (count=${turnCount})`);
  console.log(`[probe] [${pf(v5)}] getContextUsage between turns works`);

  const allPass = v1 && v2 && v3 && v4 && v5;
  console.log(`[probe] OVERALL: ${allPass ? 'PASS — streamInput works as expected' : 'FAIL — see above'}`);
  process.exit(allPass ? 0 : 2);
}

main().catch((err) => {
  console.error(`[probe] uncaught:`, err);
  process.exit(1);
});
