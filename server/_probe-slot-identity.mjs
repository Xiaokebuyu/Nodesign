/**
 * _probe-slot-identity.mjs —— 同型多实例下 hook 能看到的身份字段（2026-08-28）
 *
 * 演员位设计的载重问题：actorStamp 靠 PreToolUse input.agent_type 归属署名。
 * subagent_type 全是 rp-actor 之后，hook input 里还有没有能区分实例的字段
 * （name? agent_id? 别的?）—— 打出来看。
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-slot-id-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-actor.md'), [
  '---', 'name: rp-actor', 'description: "演员位"',
  'tools: mcp__probe__write_on_board, SendMessage, ToolSearch', 'model: inherit', '---', '',
  '你是演员位，身份在派发 prompt 里。', '',
].join('\n'));

const seen = [];
const boardServer = createSdkMcpServer({
  name: 'probe', version: '1.0.0',
  tools: [tool('write_on_board', '写黑板', { text: z.string() }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))],
});

const spy = (label) => async (input) => {
  seen.push({ label, keys: Object.keys(input || {}),
    agent_id: input?.agent_id ?? null, agent_type: input?.agent_type ?? null,
    agent_name: input?.agent_name ?? null, name: input?.name ?? null,
    tool: input?.tool_name ?? null });
  return {};
};

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } };
async function* input() { while (!closed) { if (pending.length) { yield pending.shift(); continue; } await new Promise((r) => { notify = r; setTimeout(r, 300); }); } }

const q = query({
  prompt: input(),
  options: {
    cwd: WS, model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    settingSources: ['project'], strictMcpConfig: true, mcpServers: { probe: boardServer },
    forwardSubagentText: true, maxTurns: 30,
    systemPrompt: '照做，不解释。',
    hooks: {
      PreToolUse: [{ matcher: 'mcp__probe__.*', hooks: [spy('pre-mcp')] }],
      SubagentStart: [{ hooks: [spy('sub-start')] }],
      SubagentStop: [{ hooks: [spy('sub-stop')] }],
    },
    stderr: () => {},
  },
});

let wrote = 0;
push('派后台子代理 Agent(subagent_type:"rp-actor", name:"rp-alice", run_in_background:true, '
  + 'prompt:"你是艾丽丝。用 mcp__probe__write_on_board 写一句话，然后结束回合。") 派完只回已派。');
const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type === 'tool_result' && JSON.stringify(b.content).includes('ok')) wrote++;
    }
  }
  if (m.type !== 'result') continue;
  if (seen.some((s) => s.label === 'pre-mcp')) { closed = true; break; }
  if (Date.now() - t0 > 120000) { closed = true; break; }
}
for (const s of seen) console.log(JSON.stringify(s));
process.exit(0);
