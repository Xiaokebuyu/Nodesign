/**
 * _probe-wake-latency.mjs —— 「收工型角色」的叫醒延迟实测（2026-08-28）
 *
 * 跑法：cd server && node _probe-wake-latency.mjs
 *
 * ## 验什么
 *
 * 用户提案：角色不挂 await_user，说完就收回合；要它说话时 GM 用 SendMessage 叫醒。
 * 这个形态的可用性取决于一个数：**从 GM 发出 SendMessage 到角色的话落上黑板要多久**。
 *
 * 三个计时点（全部取自 hook / MCP handler，不看模型的自述）：
 *   L0 冷启动：Agent 派发（PreToolUse 时刻）→ 第一句落板
 *   L1 第一次叫醒：SendMessage（PreToolUse 时刻）→ 台词落板
 *   L2 第二次叫醒：同上（转录长了一点，看有没有变慢）
 *
 * 对照背景（08-27 ⑳ 探针）：SendMessage 寄给**挂在 await_user 上**的角色迟到 ~300s
 * （要等那次 wait 超时返回才投得进），deliver（收件箱直投）即刻。这一发量的是
 * 第三种状态：**收了回合**的角色被 SendMessage 复活的速度。
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-wake-latency-probe-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
const BOARD = path.join(WS, 'board-probe.txt');
fs.writeFileSync(BOARD, '');
const say = (...a) => console.log(...a);

fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-actor.md'), [
  '---',
  'name: rp-actor',
  'description: "通用演员位：身份由派发 prompt 里的角色卡决定"',
  'tools: mcp__probe__write_on_board, SendMessage, ToolSearch',
  'model: inherit',
  '---',
  '',
  '你是一个演员位。你的全部身份在这次派发的 prompt（角色卡）里。',
  '每次被叫到：把要说的写上黑板，然后**立刻结束回合**。不要等待，不要多写。',
  '',
].join('\n'));

const marks = [];               // { ev, t }
const mark = (ev) => marks.push({ ev, t: Date.now() });

const boardServer = createSdkMcpServer({
  name: 'probe', version: '1.0.0',
  tools: [tool('write_on_board', '把一句话写到黑板上（探针替身）', { who: z.string(), text: z.string() }, async (args) => {
    mark(`board:${fs.readFileSync(BOARD, 'utf8').split('\n').filter(Boolean).length + 1}`);
    fs.appendFileSync(BOARD, `${args.who}: ${args.text}\n`);
    return { content: [{ type: 'text', text: '已写上黑板' }] };
  })],
});

const timeHook = async (input) => {
  const t = input?.tool_input;
  if (t?.subagent_type === 'rp-actor') mark('spawn');
  if (typeof t?.to === 'string' && t.to.startsWith('rp-')) mark(`send:${t.to}`);
  return {};
};

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } };
async function* input() {
  while (!closed) {
    if (pending.length) { yield pending.shift(); continue; }
    await new Promise((r) => { notify = r; setTimeout(r, 300); });
  }
}

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
    forwardSubagentText: true,
    maxTurns: 80,
    systemPrompt: '你是探针主代理。严格照用户说的做，收到指令立刻执行，不要解释。',
    hooks: { PreToolUse: [{ matcher: 'Task|Agent|SendMessage', hooks: [timeHook] }] },
    stderr: () => {},
  },
});

const boardLines = () => fs.readFileSync(BOARD, 'utf8').trim().split('\n').filter(Boolean);
let stage = 'spawn';
push('派一个后台子代理：Agent(subagent_type:"rp-actor", name:"rp-elle", run_in_background:true, '
  + 'prompt:"角色卡：你是艾拉，夜班电台主播。用 mcp__probe__write_on_board（who: 艾拉）写一句自我介绍，然后立刻结束回合。")'
  + ' 派完只回"已派"，不要等它。');

const t0 = Date.now();
for await (const m of q) {
  if (m.type !== 'result') continue;
  const n = boardLines().length;
  if (stage === 'spawn' && n >= 1) {
    stage = 'wake1';
    push('用 SendMessage 寄给 rp-elle：「说一句关于今晚天气的台词，写上黑板，然后结束回合。」寄完只回"已寄"。');
  } else if (stage === 'wake1' && n >= 2) {
    stage = 'wake2';
    push('再用 SendMessage 寄给 rp-elle：「说一句你要放的下一首歌，写上黑板，然后结束回合。」寄完只回"已寄"。');
  } else if (stage === 'wake2' && n >= 3) {
    closed = true; break;
  }
  if (Date.now() - t0 > 240000) { say('（超时收尾，stage=' + stage + '，黑板 ' + n + ' 行）'); closed = true; break; }
}

const board = boardLines();
say('—— 黑板 ——');
board.forEach((l, i) => say(`  ${i + 1}. ${l}`));
say('\n—— 原始计时点 ——');
marks.forEach((x) => say(`  +${((x.t - t0) / 1000).toFixed(1)}s  ${x.ev}`));

const at = (ev, k = 0) => marks.filter((x) => x.ev === ev)[k]?.t ?? null;
const d = (a, b) => (a && b ? ((b - a) / 1000).toFixed(1) + 's' : '（缺计时点）');
const sends = marks.filter((x) => x.ev.startsWith('send:'));
say('\n—— 延迟 ——');
say(`  L0 冷启动（派发→第一句落板）：${d(at('spawn'), at('board:1'))}`);
say(`  L1 第一次叫醒（SendMessage→落板）：${d(sends[0]?.t, at('board:2'))}`);
say(`  L2 第二次叫醒（SendMessage→落板）：${d(sends[1]?.t, at('board:3'))}`);
say(`\n工作区留在 ${WS}`);
process.exit(board.length >= 3 ? 0 : 1);
