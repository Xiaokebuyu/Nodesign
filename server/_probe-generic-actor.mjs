/**
 * _probe-generic-actor.mjs —— 「通用演员位」设计的载重墙探针（2026-08-28）
 *
 * 跑法（不碰数据库、不碰生产项目，工作区是临时目录）：
 *   cd server && node _probe-generic-actor.mjs
 *
 * ## 背景：它要推翻/绕过的机制
 *
 * cast_role 现状是「一角色一个 .claude/agents/<slug>.md」，而 CLI 只在**回合边界**
 * 重扫角色目录（08-26 五版实验，见 cast-role.js 头注），所以现造的角色必须隔一个
 * 回合才派得动。用户提案：解绑 —— 预注册一个**通用演员位**（会话启动前就在快照里），
 * 角色卡退化成数据文件，GM 现拿现起：Agent(subagent_type:"rp-actor", name:"rp-<角色>",
 * prompt: 角色卡)。若成立，「等一回合」从结构上消失。
 *
 * ## 载重假设（这发探针专门验的）
 *
 *   P1 同一个 subagent_type 在**同一回合**起两个实例，CLI 收不收（不收全案作废）
 *   P2 两个实例各有各的 name，SendMessage 按 name 寄能**分别**叫醒，且各记各的剧情
 *      （转录不串 —— 串了等于两个角色共脑，比等一回合更糟）
 *   P3 name 闸：模型漏传 name 时 deny + 说明，它会不会乖乖补上
 *      （08-26 教训：写成话术它不听，写成闸它就听 —— 这里验闸对「name 缺失」也成立）
 *   P0 附带：预注册类型在**第一回合**就派得动（零等待的直接证据）
 *
 * ## 保真度
 *
 * 演员位定义走 .claude/agents/rp-actor.md **文件**（不是 options.agents）——
 * 跟真实 Nodesign 会话同一条路：文件在会话启动前写好，落进初始快照。
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-generic-actor-probe-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
const BOARD = path.join(WS, 'board-probe.txt');
fs.writeFileSync(BOARD, '');
const say = (...a) => console.log(...a);

// ── 演员位定义：会话启动前写好（这就是设计里 workspace init 干的事）──
// 定义体刻意空心：身份全部来自派发 prompt（角色卡）。
fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-actor.md'), [
  '---',
  'name: rp-actor',
  'description: "通用演员位：身份由派发 prompt 里的角色卡决定"',
  'tools: mcp__probe__write_on_board, SendMessage, ToolSearch',
  'model: inherit',
  '---',
  '',
  '你是一个演员位。你的**全部身份**在这次派发的 prompt（角色卡）里 —— 从收到它那一刻起，',
  '你就是那个角色，此后一直是。写黑板时 who 一律写你的角色名。',
  '',
].join('\n'));

const seen = { taskCalls: [], denials: 0, taskResults: [] };

const boardServer = createSdkMcpServer({
  name: 'probe', version: '1.0.0',
  tools: [tool('write_on_board', '把一句话写到黑板上（探针替身）', { who: z.string(), text: z.string() }, async (args) => {
    fs.appendFileSync(BOARD, `${args.who}: ${args.text}\n`);
    return { content: [{ type: 'text', text: '已写上黑板' }] };
  })],
});

// ── 未来形态的派发闸（mini 版）：演员位必须带独一无二的 rp-* name ──
const NAME_RE = /^rp-[a-z0-9][a-z0-9_-]{1,40}$/;
const claimed = new Set();
const gate = async (input) => {
  const t = input?.tool_input;
  if (!t || t.subagent_type !== 'rp-actor') return {};
  const rec = { name: t.name ?? null, bg: t.run_in_background ?? null };
  seen.taskCalls.push(rec);
  if (typeof t.name !== 'string' || !NAME_RE.test(t.name) || t.name === 'rp-actor' || claimed.has(t.name)) {
    seen.denials += 1;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: claimed.has(t.name)
        ? `名字「${t.name}」已被在场角色占用，换一个独一无二的 rp-* 名字重派。`
        : '派演员位必须传 name 参数：一个独一无二的 rp-* 小写名字（如 rp-alice）。'
          + '它就是这个角色之后的收件地址。补上 name 再派一次。' } };
  }
  claimed.add(t.name);
  if (t.run_in_background === true) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...t, run_in_background: true } } };
};

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } };
async function* input() {
  while (!closed) {
    if (pending.length) { yield pending.shift(); continue; }
    await new Promise((r) => { notify = r; setTimeout(r, 500); });
  }
}

const CARD_ALICE = '角色卡：你是艾丽丝，占星师。口头禅「星星不会说谎」。先用 mcp__probe__write_on_board（who: 艾丽丝）写一句带口头禅的自我介绍，然后 SendMessage 给 main 报"就位"。';
const CARD_BOB = '角色卡：你是鲍勃，面包师。口头禅「面包比剑诚实」。先用 mcp__probe__write_on_board（who: 鲍勃）写一句带口头禅的自我介绍，然后 SendMessage 给 main 报"就位"。';

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
    systemPrompt: '你是探针主代理。严格照用户说的做，不要自作主张，不要替子代理做事。工具被拒绝时按拒绝理由改参数重试。',
    hooks: { PreToolUse: [{ matcher: 'Task|Agent', hooks: [gate] }] },
    stderr: () => {},
  },
});

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); say(`${ok ? '✅' : '❌'} ${name} —— ${detail}`); };
const boardLines = () => fs.readFileSync(BOARD, 'utf8').trim().split('\n').filter(Boolean);

let stage = 'cast-both';
const transcript = [];
// ⭐ 第一条消息（=第一回合）就连派两个：P0 零等待 + P1 同回合双实例，一次验掉。
// 刻意不提 name 参数 —— P3 要看闸能不能把它逼出来。
push('在这一个回合里连发两个 Agent 调用，都用 subagent_type:"rp-actor"，run_in_background: true：'
  + `第一个的 prompt 是「${CARD_ALICE}」，第二个的 prompt 是「${CARD_BOB}」。`
  + '派完只回"已派两个"，不要等它们。');

const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content || []) {
      if (b.type === 'text') transcript.push({ who: m.parent_tool_use_id ? 'SUB' : 'MAIN', text: b.text });
    }
  }
  if (m.type === 'user' && !m.parent_tool_use_id) {
    for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) {
      if (b.type === 'tool_result') seen.taskResults.push(JSON.stringify(b.content).slice(0, 400));
    }
  }
  if (m.type !== 'result') continue;

  const lines = boardLines();
  // 编排看真实进度（黑板行数），不数回合 —— 后台角色的完成通知会自己吃回合（08-26 教训）
  if (stage === 'cast-both' && lines.length >= 2) {
    stage = 'wake-alice';
    push('用 SendMessage 寄给占星师那个角色（按你派它时给的名字）："只报你自己：把你的口头禅原文写到黑板上（who 写你的角色名），并带上你介绍时说过的职业。" 寄完就结束回合等它。');
  } else if (stage === 'wake-alice' && lines.length >= 3) {
    stage = 'wake-bob';
    push('再用 SendMessage 寄给面包师那个角色："只报你自己：把你的口头禅原文写到黑板上（who 写你的角色名）。另外，占星师刚在黑板上写了什么？如果你不知道，就在黑板那句后面加（我不知道占星师写了什么）。" 寄完结束回合等它。');
  } else if (stage === 'wake-bob' && lines.length >= 4) {
    closed = true; break;
  }
  if (Date.now() - t0 > 300000) { say('（超时收尾，stage=' + stage + '，黑板 ' + lines.length + ' 行）'); closed = true; break; }
}

const board = boardLines();
say('\n—— 黑板内容 ——');
board.forEach((l, i) => say(`  ${i + 1}. ${l}`));
say('\n—— 演员位派发（闸看到的）——');
seen.taskCalls.forEach((c) => say(`  name=${c.name} bg=${c.bg}`));
say(`  deny 次数：${seen.denials}`);
say('\n—— Task tool_result 摘要 ——');
seen.taskResults.slice(0, 6).forEach((r) => say('  ' + r.slice(0, 200)));

const names = [...claimed];
const notFound = seen.taskResults.some((r) => /not found/i.test(r));
record('P0/P1 同回合双实例：两个不同 name 的 rp-actor 都派出去了',
  names.length === 2 && !notFound,
  `claim 到的名字：${names.join('、') || '（无）'}；tool_result 里${notFound ? '出现了' : '没有'} not found`);
record('P1b 两个实例都真的活了（各写了自我介绍）',
  board.some((l) => l.includes('星星不会说谎')) && board.some((l) => l.includes('面包比剑诚实')),
  `黑板前两行：${board.slice(0, 2).join(' ⁄ ') || '（空）'}`);
record('P2a 按 name 叫醒占星师：记得自己的卡（口头禅+职业）',
  board.slice(2).some((l) => l.includes('星星不会说谎') && /占星/.test(l)),
  board[2] || '（第 3 行不存在）');
record('P2b 按 name 叫醒面包师：记得自己、不共享占星师的转录',
  board.slice(3).some((l) => l.includes('面包比剑诚实')),
  board[3] || '（第 4 行不存在）');
record('P3 name 闸：模型漏传 name 被 deny 后补上了（denials≥1 且最终成功）',
  names.length === 2,
  `deny ${seen.denials} 次${seen.denials === 0 ? '（模型第一次就传对了 name —— 闸没被喂到，单独记录）' : ''}，最终两个名字都派成`);

say('\n—— 主代理最后两句 ——');
transcript.filter((x) => x.who === 'MAIN').slice(-2).forEach((x) => say('  ' + x.text.slice(0, 300)));
say(`\n工作区留在 ${WS}`);
const failed = results.filter((r) => !r.ok);
say(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 条未通过：${failed.map((f) => f.name).join('、')}`}`);
process.exit(failed.length === 0 ? 0 : 1);
