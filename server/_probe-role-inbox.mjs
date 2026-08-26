/**
 * _probe-role-inbox.mjs —— 收件箱全链路探针（块 4）
 *
 *   cd server && DB_PATH=/tmp/nd-probe.db node _probe-role-inbox.mjs
 *
 * 验的是「用户的话直达角色，主 agent 零参与」这条回路，用真件：真 cast_role、
 * 真 await_user/check_inbox、真 inbox、真 hooks（名册 + 派发闸 + 署名盖章）。
 *
 * 六条断言，第 5 条是这块存在的理由：
 *   1 角色被派出来并真的挂在 await_user 上等
 *   2 用户这句话是**直达**（deliver 回 'waiting'，不是进队列）
 *   3 角色拿到了原话
 *   4 拿到之后它接着干活（写板），不是干等
 *   5 ⭐ 整个来回**主 agent 一个字都没说**
 *   6 没人等的时候投递如实回报 'queued'（不把积压伪装成送达）
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeCastRoleTool } from './engine/mcp/tools/cast-role.js';
import { makeAwaitUserTool, makeCheckInboxTool } from './engine/mcp/tools/role-inbox.js';
import { createHooks } from './engine/agent/hooks.js';
import { createRoleRoster } from './engine/agent/cast.js';
import { deliver, isWaiting, _resetInboxes } from './engine/agent/inbox.js';
import { registerQuerySession, attachSessionQuery } from './engine/runs/active-runs.js';
import { AsyncQueue } from './lib/async-queue.js';

const PID = 'probe-inbox-project';
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-inbox-probe-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
_resetInboxes();

const results = [];
const say = (...a) => console.log(...a);
const record = (n, ok, d) => { results.push({ n, ok }); say(`${ok ? '✅' : '❌'} ${n} —— ${d}`); };

const board = [];
const roster = createRoleRoster();
// 探针要模拟回合推进：真实 session-loop 每个回合换 runId，派发闸靠它判断
// "这个角色是不是本回合刚造的"。ctx 一份，MCP 工具和 hook 共用。
const ctx = {
  emit() {}, runId: 'run-1', sessionId: PID, projectId: PID,
  counters: { turns: 0 }, snapshot: () => ({}), addCharge() {},
};
let turnNo = 1;
const stub = (name, fn) => tool(name, `${name}（探针替身）`, { text: z.string().optional() },
  async (args) => { fn?.(args); return { content: [{ type: 'text', text: 'ok' }] }; });

const server = createSdkMcpServer({
  name: 'nodesign', version: '0.1.0',
  tools: [
    makeCastRoleTool({ workspaceRoot: WS, sessionId: PID, ctx, roster }),
    makeAwaitUserTool({ projectId: PID }),
    makeCheckInboxTool({ projectId: PID }),
    stub('write_on_board', (a) => board.push(a.text || '')),
    stub('read_board'),
  ],
});

// ⚠️ 必须用真 AsyncQueue 并注册会话：cast_role 造完角色会用 pushUnclaimedMessage
// 推一条「可以派了」的系统消息制造下一个回合，而那条路只认注册过的会话，
// 且要推进**同一条**输入流。用探针自己的 push 机制 = 那条消息推不出去，
// 验的就是「没接上的假通过」（2026-08-26 真踩过一次）。
const inputQueue = new AsyncQueue();
const push = (t) => inputQueue.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' });
registerQuerySession(PID, { abortController: new AbortController(), inputQueue });

const mainSaid = [];
const roleSaid = [];
const trace = [];   // 诊断：谁调了什么、拿回什么（断链时不靠猜）

const q = query({
  prompt: inputQueue,
  options: {
    cwd: WS, model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    settingSources: ['project'], strictMcpConfig: true,
    mcpServers: { nodesign: server },
    tools: ['Task', 'TaskOutput', 'SendMessage', 'ToolSearch'],
    forwardSubagentText: true, maxTurns: 60,
    systemPrompt: '你是探针主代理（GM）。照用户说的做，派完角色就别插手，不要替角色说话。',
    // ⚠️ 接**生产的 createHooks**，不手拼 matcher：手拼的通配 matcher 比生产宽松，
    // 于是探针 6/6 全绿而生产链路整条是死的（2026-08-26 真踩：盖章 matcher 漏了
    // await_user/check_inbox，byOf 落回 'agent'，收件箱守卫回一句「你是主控」）。
    // 记忆里那条「假配置比真服务端宽松 = 比没有更坏」说的就是这个。
    hooks: createHooks({ ctx, workspaceRoot: WS, sharedRoot: WS, sessionId: PID, projectId: PID, roleRoster: roster }),
    stderr: () => {},
  },
});

push('用 cast_role 造一个角色：id="moli"，name="墨璃"，duty="讲故事的叙事者"，'
  + 'persona 写：「你是墨璃，一个沉静的叙事者。工作方式：写一小段故事，用 mcp__nodesign__write_on_board 写到板上，'
  + '然后调 await_user（seconds 传 60）等用户的下一句，等到了就照他说的接着写、再写一块板。」'
  + '造完派它上场（subagent_type="rp-moli"），'
  + 'prompt 写「写一句开场白上板，然后等用户」。派完只回"已派"，之后不要再插手。');

attachSessionQuery(PID, q);
const t0 = Date.now();
let deliveredResult = null;
let mainWordsAtDelivery = 0;
let userLine = '让主角推开那扇门。';

(async () => {
  // 等角色挂上 await_user，再模拟用户在画布上回话
  while (Date.now() - t0 < 180000) {
    if (isWaiting(PID, 'rp-moli')) {
      mainWordsAtDelivery = mainSaid.join('').length;
      deliveredResult = deliver(PID, 'rp-moli', { text: userLine, about: '开场白', from: 'user' });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
})();

// ⚠️ 断言收进 finish()，由 watchdog 驱动：角色挂在 await_user 上时 query 的输出流
// 没有新消息，`for await` 会一直阻塞，循环里的 break 一次都轮不到检查
// （2026-08-26 真踩两次：一次 124 超时，一次只留一句 Terminated）。
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  record('1 角色被派出来并真的挂在 await_user 上等', deliveredResult !== null,
    deliveredResult ? '探针观察到 isWaiting=true 后才投递' : '⚠️ 一直没等到它挂上（它可能没被派出来，或没调 await_user）');
  record('2 用户这句话是直达（不是进队列）', deliveredResult?.delivered === 'waiting',
    `deliver 回 ${deliveredResult?.delivered || '(没投)'}（期望 waiting）`);
  record('3 角色拿到了原话', roleSaid.join(' ').includes('门') || board.join(' ').includes('门'),
    (board[1] || roleSaid[roleSaid.length - 1] || '(角色没再说话)').slice(0, 110));
  record('4 拿到之后接着干活（写了第二块板）', board.length >= 2,
    `板上 ${board.length} 块：${board.map((b) => String(b).slice(0, 26)).join(' | ')}`);
  const mainWordsAfter = mainSaid.join('').length;
  record('5 ⭐ 这个来回主 agent 一个字都没说', deliveredResult !== null && mainWordsAfter === mainWordsAtDelivery,
    `投递时主 agent 已说 ${mainWordsAtDelivery} 字，收尾时 ${mainWordsAfter} 字`);
  const q2 = deliver(PID, 'rp-nobody-home', { text: '没人听', from: 'user' });
  record('6 没人等的时候如实回报 queued', q2.delivered === 'queued',
    `deliver 回 ${q2.delivered}（期望 queued —— 不把积压伪装成送达）`);

  say('\n—— 消息流 ——');
  trace.slice(0, 30).forEach((l) => say(`  ${l}`));
  say(`\n工作区 ${WS}`);
  const failed = results.filter((r) => !r.ok);
  say(`\n${failed.length ? `${failed.length} 条未通过：${failed.map((f) => f.n).join('、')}` : '全部通过'}`);
  process.exit(failed.length ? 1 : 0);
}

setInterval(() => {
  if ((board.length >= 2 && deliveredResult) || Date.now() - t0 > 150000) { inputQueue.close?.(); finish(); }
}, 500);

for await (const m of q) {
  if (m.type === 'result') {
    turnNo += 1; ctx.runId = `run-${turnNo}`;
    trace.push(`[回合 ${turnNo} 开始]`);
    if (turnNo === 2) {
      // 二分探测：这条由探针自己推。跟 cast_role 用的是同一条 inputQueue，
      // 区别只在调用者 —— 醒了就说明队列本身通，问题在 pushUnclaimedMessage 那侧。
      trace.push('[探针自己推了一条]');
      push('现在派 subagent_type="rp-moli" 上场（写一句开场白上板，然后 await_user 等用户）。');
    }
  }
  if (m.type === 'assistant') {
    const tag = m.parent_tool_use_id ? '角色' : '主控';
    const who = m.parent_tool_use_id ? roleSaid : mainSaid;
    for (const b of m.message.content || []) {
      if (b.type === 'text') { who.push(b.text); trace.push(`${tag} 说：${b.text.slice(0, 70)}`); }
      if (b.type === 'tool_use') trace.push(`${tag} 调 ${b.name} ${JSON.stringify(b.input).slice(0, 100)}`);
    }
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        trace.push(`  → ${String(t).slice(0, 120)}`);
      }
    }
  }
}
finish();
