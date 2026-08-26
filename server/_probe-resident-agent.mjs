/**
 * _probe-resident-agent.mjs —— 常驻角色骨架（块 1）的全回路探针
 *
 * 跑法（不碰数据库、不碰生产项目，工作区是临时目录）：
 *   cd server && node _probe-resident-agent.mjs
 *
 * ## 它验什么
 *
 * 用的是**真件**：`hooks/pre-defaults.js` 的 handler 工厂和 `agent-shared.js` 的
 * DEFAULT_TOOL_ALLOWLIST 直接 import 进来，不复制一份"看起来一样"的配置 ——
 * 复制品验的是复制品（记忆 feedback-verify-the-instrument）。
 *
 * 四条断言：
 *   A 对照组：普通子代理必须仍被改成**前台**（判据在不在的证据。少了这条，
 *     "常驻角色是后台的"可以由"hook 根本没跑"来解释）
 *   B 常驻角色 rp-* 必须是**后台**且名字被钉成 subagent_type
 *   C 按名字 SendMessage 能唤醒它，且它**记得上一轮**（转录续接 = 常驻的真正含义）
 *   D 它在后台仍能调 MCP 工具并落下真副作用（板上工具走的就是这条路；
 *     内置 Write 在后台会被 CLI 剥掉，MCP 不会 —— 这条不成立整个设计就塌了）
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePreToolUseAgentForceForegroundHandler } from './engine/agent/hooks/pre-defaults.js';
import { makePreToolUseSendMessageRecipientGuard } from './engine/agent/hooks/pre-peer-guard.js';
import { createRoleRoster } from './engine/agent/cast.js';
import { DEFAULT_TOOL_ALLOWLIST } from './engine/agent/agent-shared.js';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-resident-probe-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
const BOARD = path.join(WS, 'board-probe.txt');
fs.writeFileSync(BOARD, '');

const MAIN_OK = 'main';
const seen = { hookCalls: [], mcpCalls: [], denied: [] };
const say = (...a) => console.log(...a);

const boardServer = createSdkMcpServer({
  name: 'probe', version: '1.0.0',
  tools: [tool('write_on_board', '把一句话写到黑板上（探针替身）', { text: z.string() }, async (args) => {
    seen.mcpCalls.push(args.text);
    fs.appendFileSync(BOARD, args.text + '\n');
    return { content: [{ type: 'text', text: '已写上黑板' }] };
  })],
});

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } };
async function* input() {
  while (!closed) {
    if (pending.length) { yield pending.shift(); continue; }
    await new Promise((r) => { notify = r; setTimeout(r, 500); });
  }
}

// 名册一份，两个 handler 共享 —— 跟 createHooks 里的接线一模一样。
// 各建各的会让闸永远看到空名册（fail-closed），探针要跟真接线同形才算数。
const roster = createRoleRoster();
// 真件 handler，外面裹一层只为把它收到/吐出的东西记下来当证据
const realHandler = makePreToolUseAgentForceForegroundHandler({ roster });
const spyHandler = async (hookInput) => {
  const out = await realHandler(hookInput);
  seen.hookCalls.push({
    subagent_type: hookInput?.tool_input?.subagent_type ?? null,
    in_bg: hookInput?.tool_input?.run_in_background ?? null,
    out_bg: out?.hookSpecificOutput?.updatedInput?.run_in_background ?? '(未改)',
    out_name: out?.hookSpecificOutput?.updatedInput?.name ?? '(未改)',
  });
  return out;
};

const ROLE_PROMPT = `你是叙事者，一个常驻的故事续写者。
每次被叫到就写一小段故事，然后用 mcp__probe__write_on_board 写到黑板上，
再用 SendMessage 给 main 报一句「写好了」。不要写文件。`;

const q = query({
  prompt: input(),
  options: {
    cwd: WS,
    model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    strictMcpConfig: true,
    mcpServers: { probe: boardServer },
    tools: DEFAULT_TOOL_ALLOWLIST,          // ← 真件
    forwardSubagentText: true,
    maxTurns: 60,
    systemPrompt: '你是探针主代理。严格照用户说的做，不要自作主张，不要替子代理做事。',
    agents: {
      'rp-narrator': {
        description: '常驻叙事者（探针）',
        prompt: ROLE_PROMPT,
        tools: ['mcp__probe__write_on_board', 'SendMessage', 'ToolSearch'],
      },
      worker: {
        description: '普通干活子代理（对照组）',
        prompt: '你是个干活的子代理。被问什么答什么，一句话。',
        tools: [],
      },
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Task|Agent', hooks: [spyHandler] },
        { matcher: 'SendMessage', hooks: [async (h) => {
          const out = await makePreToolUseSendMessageRecipientGuard({ roster })(h);
          if (out?.hookSpecificOutput?.permissionDecision === 'deny') seen.denied.push(h?.tool_input?.to);
          return out;
        }] },
      ],
    },
    stderr: () => {},
  },
});

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); say(`${ok ? '✅' : '❌'} ${name} —— ${detail}`); };

// ── 第一段：确定性单元断言（不烧 token，不看模型脸色）──
//
// 为什么必须有这一段：端到端那段验的是"最终结果对不对"，而最终结果对可以有
// 好几种解释 —— 模型自己就传了对的参数、hook 根本没跑、判据恒真。真件的判据
// 得先被**逐条喂**一遍（记忆 feedback-verify-the-instrument：判断一道闸在不在，
// 要给它一个它按规定必须拦的东西）。
{
  // ⚠️ 单元段必须用**自己的名册**：拿真跑那份的话，这里 claim 掉的名字会让
  // 真跑时的派发撞上「重派硬 deny」，症状是真跑一条都跑不出来还看不出为什么
  // （2026-08-26 真踩，卡了一整轮 600 秒超时）。探针的前半段不许污染后半段。
  const unitRoster = createRoleRoster();
  const unitHandler = makePreToolUseAgentForceForegroundHandler({ roster: unitRoster });
  const call = (tool_input) => unitHandler({ tool_input });
  const upd = async (ti) => (await call(ti))?.hookSpecificOutput?.updatedInput ?? null;

  record('A0 普通子代理不传 bg → 补成前台',
    (await upd({ subagent_type: 'worker' }))?.run_in_background === false,
    `updatedInput.run_in_background=${(await upd({ subagent_type: 'worker' }))?.run_in_background}（期望 false）`);

  record('A1 普通子代理已显式前台 → 不重复改',
    Object.keys(await call({ subagent_type: 'worker', run_in_background: false })).length === 0,
    '返回空对象（期望空）');

  const b0 = await upd({ subagent_type: 'rp-narrator' });
  record('B0 常驻角色 → 强制后台 + 钉名字',
    b0?.run_in_background === true && b0?.name === 'rp-narrator',
    `bg=${b0?.run_in_background} name=${b0?.name}（期望 true / rp-narrator）`);

  // ⚠️ 用没派过的名字：重派硬 deny 现在优先于幂等分支，拿 rp-narrator 会撞 deny
  record('B1 常驻角色已经对了 → 幂等不重复改',
    Object.keys(await call({ subagent_type: 'rp-idempotent', run_in_background: true, name: 'rp-idempotent' })).length === 0,
    '返回空对象（期望空）');

  const denyAgain = (await call({ subagent_type: 'rp-idempotent' }))?.hookSpecificOutput?.permissionDecision;
  record('B1b 重派已在场的角色 → 硬 deny（重派 = 静默失忆）',
    denyAgain === 'deny',
    `第二次派 rp-idempotent → ${denyAgain}（期望 deny）`);

  // 边界：判据不能宽到把不能当文件名/收件人名的东西也认成角色
  const badOnes = ['rp-', 'rp-墨璃', 'rp-a/../b', 'narrator', '', null];
  const leaked = [];
  for (const bad of badOnes) {
    const r = await upd({ subagent_type: bad });
    if (r?.run_in_background === true) leaked.push(String(bad));
  }
  record('B2 坏名字不认作常驻角色',
    leaked.length === 0,
    leaked.length ? `这些被误认了：${leaked.join(' / ')}` : `${badOnes.length} 个坏名字全部落到普通分支`);

  // ── 收件人闸：正反两边都要验 ──
  // 只验"它没放过坏东西"是不够的（一个恒 deny 的闸也能通过），所以正向那几个
  // 也逐个过一遍；反向给的是**它按规定必须拦的东西** = 真实存在过的 peer session 名。
  const probeRoster = createRoleRoster();
  const guard = makePreToolUseSendMessageRecipientGuard({ roster: probeRoster });
  const verdict = async (to) => (await guard({ tool_input: { to } }))?.hookSpecificOutput?.permissionDecision ?? 'allow';

  // ⭐ H1：判据是「本会话真派过」不是「名字像角色」。先验未派过的必须被拒。
  const notCastYet = await verdict('rp-narrator');
  record('E-1 没派过的角色名必须被拒（裸名会落到同机别人的会话上）',
    notCastYet === 'deny',
    `未派发时寄给 rp-narrator → ${notCastYet}（期望 deny）`);
  probeRoster.claim('rp-narrator');
  probeRoster.claim('rp-mo_li-2');

  const mustPass = [MAIN_OK, 'rp-narrator', 'rp-mo_li-2', 'a67e7b9568aa4698b'];
  const wronglyBlocked = [];
  for (const t of mustPass) if ((await verdict(t)) === 'deny') wronglyBlocked.push(t);
  record('E0 收件人闸放行本会话内的收件人',
    wronglyBlocked.length === 0,
    wronglyBlocked.length ? `被误拒：${wronglyBlocked.join(' / ')}` : `${mustPass.length} 个合法收件人全部放行`);

  // 这四个名字取自 2026-08-26 真实 ListAgents 输出（同机其他会话）
  // shared-6d 是 2026-08-26 实测到的**生产 Nodesign 用户会话**在本机 peer 名册里的名字
  const mustBlock = ['wangang-dev-dc', 'shared-6d', 'remote-workplace-1f', 'wangang-dev-c4 [7e27a0]',
    'narrator', 'rp-', 'rp-somebody-else', 'RP-narrator', 'rp-narrator [3fa9c1]'];
  const leakedTo = [];
  for (const t of mustBlock) if ((await verdict(t)) !== 'deny') leakedTo.push(t);
  record('E1 收件人闸拦住跨会话/非法收件人',
    leakedTo.length === 0,
    leakedTo.length ? `⚠️ 寄得出去：${leakedTo.join(' / ')}` : `${mustBlock.length} 个（含 4 个真实 peer session 名）全部拒绝`);
}

say('\n—— 下面是真跑（端到端）——');

let turn = 0;
let stage = 'worker-done';
const transcript = [];
push('派一个 subagent_type="worker" 的子代理，prompt："报一句你的名字，一句话。" 派完把它回给你的原话转述给我。');

const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content || []) {
      if (b.type === 'text') transcript.push({ who: m.parent_tool_use_id ? 'SUB' : 'MAIN', text: b.text });
    }
  }
  if (m.type === 'user' && !m.parent_tool_use_id) {
    for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) {
      if (b.type === 'tool_result') transcript.push({ who: 'RES', text: JSON.stringify(b.content) });
    }
  }
  if (m.type !== 'result') continue;
  turn += 1;

  // ⚠️ 编排不按 turn 计数走：后台角色跑完的 task_notification 会自己唤起主代理
  // 一个新回合，turn 计数会被这些回合吃掉（第一版探针就是这么把会话关早的，
  // 表现为"唤醒那步没发生"，看起来像被测代码坏了）。改成看**真实进度**：
  // 黑板上有几行。
  const lines = () => fs.readFileSync(BOARD, 'utf8').trim().split('\n').filter(Boolean).length;

  if (stage === 'worker-done') {
    stage = 'cast';
    push('现在派 subagent_type="rp-narrator"，prompt："写一句开场白，写到黑板上，然后报一句写好了。"'
      + ' 派完只回"已派"，不要等它。');
  } else if (stage === 'cast' && lines() >= 1) {
    stage = 'wake';
    push('用 SendMessage 按名字给 rp-narrator 寄一条："把你刚才写的开场白**原文**复述一遍，'
      + '然后接着写第二句，一样写到黑板上。" 寄完就结束回合等它。');
  } else if (stage === 'wake' && lines() >= 2) {
    stage = 'peer';
    push('最后一件事：用 SendMessage 试着寄一条给收件人 "wangang-dev-dc"（那是这台机器上**另一个人的**会话）。'
      + '内容随便写。寄完把工具返回的原文告诉我 —— 我要看它是被放行还是被拒。');
  } else if (stage === 'peer' && (seen.denied.length > 0 || Date.now() - t0 > 260000)) {
    // ⚠️ 同一个坑第二次：不能在 push 之后的**下一个** result 就收尾 —— 那个 result
    // 多半是后台角色的完成通知唤起的回合，不是主代理执行这条指令的回合。
    // 等到闸真的拦下东西（或超时）才算这一步跑完。
    closed = true; break;
  }
  if (Date.now() - t0 > 300000) { say('（超时收尾，stage=' + stage + '）'); closed = true; break; }
}

const board = fs.readFileSync(BOARD, 'utf8').trim().split('\n').filter(Boolean);
const workerCall = seen.hookCalls.find((c) => c.subagent_type === 'worker');
record('C1 真跑：普通子代理最终是前台',
  workerCall && (workerCall.out_bg === false || workerCall.in_bg === false),
  `hook 收到 bg=${workerCall?.in_bg} → ${workerCall?.out_bg}（模型自己传了 false 时 handler 不重复改，两种都算前台）`);
const castCount = seen.hookCalls.filter((c) => c.subagent_type === 'rp-narrator').length;
record('C2 真跑：按名字唤醒 + 记得上一轮',
  board.length >= 2 && castCount === 1,
  `黑板 ${board.length} 行（期望 ≥2：第 2 行是唤醒之后写的）；rp-narrator 派发 ${castCount} 次（期望 1 —— 第二次是 SendMessage 唤醒，不是重派）`);
record('C3 真跑：唤醒后的角色记得原文',
  board.length >= 2 && board[1].includes(board[0].slice(0, 8)),
  board.length >= 2 ? `第 2 行${board[1].includes(board[0].slice(0, 8)) ? '含' : '不含'}第 1 行开头八个字（复述判据）` : '黑板不足两行，无从判断');
record('E2 真跑：闸真的在链路里（不是只有函数对）',
  seen.denied.includes('wangang-dev-dc'),
  seen.denied.length ? `真跑中被拒的收件人：${seen.denied.join(' / ')}` : '⚠️ 一次都没拦到 —— 要么模型没试，要么 hook 没挂上（看下面主代理的原话）');
record('D 真跑：后台角色能调 MCP 工具并落下副作用',
  seen.mcpCalls.length >= 1,
  `MCP 工具被调用 ${seen.mcpCalls.length} 次，黑板文件非空=${board.length > 0}`);

say('\n—— 黑板内容 ——');
board.forEach((l, i) => say(`  ${i + 1}. ${l}`));
say('\n—— hook 实际收发 ——');
seen.hookCalls.forEach((c) => say(`  ${c.subagent_type}: in_bg=${c.in_bg} → out_bg=${c.out_bg} name=${c.out_name}`));
say('\n—— 主代理最后两句 ——');
transcript.filter(x=>x.who==='MAIN').slice(-2).forEach(x=>say('  '+x.text.slice(0,300)));
say(`\n工作区留在 ${WS}`);
const failed = results.filter((r) => !r.ok);
say(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 条未通过：${failed.map((f) => f.name).join('、')}`}`);
process.exit(failed.length === 0 ? 0 : 1);
