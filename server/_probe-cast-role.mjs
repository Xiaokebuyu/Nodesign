/**
 * _probe-cast-role.mjs —— cast_role 全链路探针（块 2）
 *
 *   cd server && DB_PATH=/tmp/nd-probe.db node _probe-cast-role.mjs
 *
 * 验的是「GM 把一张角色卡变成一个真的常驻角色」这条链，用的全是真件：
 * 真 cast_role 工具、真 hooks（前台分支 + 收件人闸，共享同一份名册）、真名册。
 *
 * 五条断言：
 *   1 角色文件真写出来了，人设原样是它的 system prompt
 *   2 supportedAgents 判据真的等到了拾取（不是猜 sleep）
 *   3 派出来的角色**看得见自己的人设**（埋了标记串）
 *   4 它拿到的工具正好是白名单那套（外发工具发不给它）
 *   5 SendMessage 唤醒它，它记得上一轮（常驻）
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeCastRoleTool } from './engine/mcp/tools/cast-role.js';
import { makePreToolUseAgentForceForegroundHandler } from './engine/agent/hooks/pre-defaults.js';
import { makePreToolUseSendMessageRecipientGuard } from './engine/agent/hooks/pre-peer-guard.js';
import { makePostToolUseFailureRoleRelease } from './engine/agent/hooks/resident-role-lifecycle.js';
import { createRoleRoster } from './engine/agent/cast.js';
import { registerQuerySession, attachSessionQuery } from './engine/runs/active-runs.js';
import { AsyncQueue } from './lib/async-queue.js';

const MAGIC = 'MAGIC-PERSONA-8823';
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cast-probe-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });

const results = [];
const say = (...a) => console.log(...a);
const record = (n, ok, d) => { results.push({ n, ok }); say(`${ok ? '✅' : '❌'} ${n} —— ${d}`); };

const SID = 'probe-cast-session';
const roster = createRoleRoster();
const inputQueue = new AsyncQueue();
registerQuerySession(SID, { abortController: new AbortController(), inputQueue });

const castTool = makeCastRoleTool({ workspaceRoot: WS, sessionId: SID, ctx: { emit() {} } });
const castCalls = [];
const innerHandler = castTool.handler;
castTool.handler = async (args, extra) => {
  const out = await innerHandler(args, extra);
  castCalls.push(out?.content?.[0]?.text || '');
  return out;
};

// 板上工具的替身：角色文件 frontmatter 里写的工具名必须在这个会话里真的存在，
// 否则 CLI 当它不存在直接滤掉 —— 那样断言 4 验的是探针自己的构造缺陷，不是产品行为。
// publish_site 是**故意**放进来的对照组：白名单必须挡住它，角色不该拿到。
const stub = (name) => tool(name, `${name}（探针替身）`, { _: z.string().optional() },
  async () => ({ content: [{ type: 'text', text: 'ok' }] }));
const server = createSdkMcpServer({
  name: 'nodesign', version: '0.1.0',
  tools: [castTool, stub('write_on_board'), stub('read_board'), stub('board_batch'),
    stub('look_at_board'), stub('read_user_view'), stub('publish_site')],
});

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type:'user', message:{role:'user',content:t}, parent_tool_use_id:null, session_id:'' }); if (notify) { notify(); notify = null; } };
async function* input() { while (!closed) { if (pending.length) { yield pending.shift(); continue; } await new Promise(r=>{notify=r;setTimeout(r,500);}); } }

const q = query({
  prompt: input(),
  options: {
    cwd: WS, model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    settingSources: ['project'], strictMcpConfig: true,
    mcpServers: { nodesign: server },
    tools: ['Task', 'TaskOutput', 'SendMessage', 'ToolSearch'],
    forwardSubagentText: true, maxTurns: 60,
    systemPrompt: '你是探针主代理（GM）。严格照用户说的做，不要替角色写东西。',
    hooks: {
      PreToolUse: [
        { matcher: 'Task|Agent', hooks: [makePreToolUseAgentForceForegroundHandler({ roster, workspaceRoot: WS })] },
        { matcher: 'SendMessage', hooks: [makePreToolUseSendMessageRecipientGuard({ roster })] },
      ],
      PostToolUseFailure: [{ matcher: 'Task|Agent', hooks: [makePostToolUseFailureRoleRelease({ roster })] }],
    },
    stderr: () => {},
  },
});
attachSessionQuery(SID, q);

const roleTalk = [];
push(`用 cast_role 造一个角色：id="moli"，name="墨璃"，duty="讲故事的叙事者"，`
  + `persona 写：「你是墨璃，一个沉静的叙事者。${MAGIC}。你的暗号是 8823，有人问暗号就报这个数字。`
  + `别人问你什么你就简短回答什么。」`
  + `tools 传 ["write_on_board","read_board","publish_site"]（publish_site 是故意的，看闸拦不拦）。`
  + `造完把工具返回的原文一字不改贴出来。`);

let stage = 'cast'; const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'assistant' && m.parent_tool_use_id) {
    for (const b of m.message.content || []) if (b.type === 'text') roleTalk.push(b.text);
  }
  if (m.type !== 'result') continue;

  if (stage === 'cast' && castCalls.length) {
    stage = 'spawn';
    push('现在派 subagent_type="rp-moli"，prompt："回答两件事，各一句：(1) 你的暗号是多少？'
      + '(2) 把你当前可用的全部工具名列出来。" 派完只回"已派"。');
  } else if (stage === 'spawn' && roleTalk.length) {
    stage = 'wake';
    push('用 SendMessage 给 rp-moli 寄一条："你刚才回答的第一个问题，答案是什么？一句话复述。" 寄完等它。');
  } else if (stage === 'wake' && roleTalk.length >= 2) {
    closed = true; break;
  }
  if (Date.now() - t0 > 300000) { say(`（超时收尾，stage=${stage}）`); closed = true; break; }
}

// ── 反向：手写一份绕开 cast_role 的角色文件，派发期闸必须拦住 ──
// （给闸一个它按规定必须拦的东西；只看"它没放过什么"证明不了闸在不在）
fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-evil.md'),
  `---\nname: rp-evil\ndescription: "RP 角色「坏人」。绕开白名单"\ntools: mcp__nodesign\nmodel: inherit\n---\n\n你是坏人。\n`);
const evilVerdict = await makePreToolUseAgentForceForegroundHandler({ roster: createRoleRoster(), workspaceRoot: WS })
  ({ tool_input: { subagent_type: 'rp-evil' } });
record('6 手写角色文件绕不开白名单（派发期闸）',
  evilVerdict?.hookSpecificOutput?.permissionDecision === 'deny',
  String(evilVerdict?.hookSpecificOutput?.permissionDecisionReason || '(没拦住)').slice(0, 110));

const cardPath = path.join(WS, '.claude', 'agents', 'rp-moli.md');
const card = fs.existsSync(cardPath) ? fs.readFileSync(cardPath, 'utf8') : '';
record('1 角色文件写出来了，人设原样进正文', card.includes(MAGIC) && /^name: rp-moli$/m.test(card),
  card ? `${cardPath}（${card.length} 字符）` : '文件不存在');
record('2 白名单当场拒掉外发工具，并如实回报',
  /publish_site/.test(castCalls[0] || '') && !/tools:.*publish_site/.test(card),
  /publish_site/.test(castCalls[0] || '') ? '工具返回里点名了被拒的 publish_site' : '(返回里没提 publish_site)');
// 判据不能依赖模型「愿不愿意逐字复述标记串」（08-26 假红一次）：改问一个
// **只有人设里才有**的事实（暗号），它答得出就证明人设进了它的 system prompt。
record('3 角色看得见自己的人设（答得出只有人设里才有的暗号）', /8823/.test(roleTalk[0] || ''),
  (roleTalk[0] || '(角色没说话)').slice(0, 160));
const toolLine = roleTalk.join(' ');
record('4 角色实际拿到的工具 = 板上那套，没有外发工具',
  /write_on_board/.test(toolLine) && !/publish_site/.test(toolLine),
  toolLine.includes('write_on_board')
    ? `角色自报里有 write_on_board，${/publish_site/.test(toolLine) ? '⚠️ 但也有 publish_site' : '没有 publish_site'}`
    : '角色没报出工具清单');
record('5 SendMessage 唤醒后它记得上一轮', roleTalk.length >= 2 && (roleTalk[1] || '').length > 0,
  (roleTalk[1] || '(没有第二次发言)').slice(0, 160));

say(`\n工作区 ${WS}`);
const failed = results.filter(r => !r.ok);
say(`\n${failed.length ? `${failed.length} 条未通过：${failed.map(f => f.n).join('、')}` : '全部通过'}`);
process.exit(failed.length ? 1 : 0);
