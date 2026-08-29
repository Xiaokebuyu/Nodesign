/**
 * _probe-real-card-load.mjs —— 用真会话的毒卡直接喂 CLI（2026-08-28）
 *
 * 把 proj_mtd1tap1_etjw 那张派不动的 rp-cheng-wan.md **原样**放进夹具工作区
 * （会话启动前就位 = 最宽松的加载条件），第一回合就派。
 * 认 → 卡没毒，回去查环境；不认 → 毒在卡内容里，接着二分。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CARD_SRC = '/home/wangang-dev/nodesign-exp-data/projects-data/proj_mtd1tap1_etjw/shared/.claude/agents/rp-cheng-wan.md';
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-real-card-'));
fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
fs.copyFileSync(CARD_SRC, path.join(WS, '.claude', 'agents', 'rp-cheng-wan.md'));

const pending = []; let notify = null; let closed = false;
const push = (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } };
async function* input() { while (!closed) { if (pending.length) { yield pending.shift(); continue; } await new Promise((r) => { notify = r; setTimeout(r, 300); }); } }

const q = query({
  prompt: input(),
  options: {
    cwd: WS,
    model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    maxTurns: 10,
    systemPrompt: '你是探针主代理。严格照用户说的做。工具报错时把报错原文一字不差转述，不要重试。',
    agents: {
      'vision-checker': { description: '看图的（探针替身）', prompt: '你看图。', tools: [] },
    },
    stderr: (d) => { const s = String(d).trim(); if (/agent|yaml|frontmatter|parse/i.test(s)) console.log('[stderr]', s.slice(0, 300)); },
  },
});

let verdict = 'timeout'; let detail = '';
push('派一个前台子代理 Agent(subagent_type:"rp-cheng-wan")，prompt:"用一句话自我介绍"。把它的回答或报错原文转述给我。');
const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content) {
      if (b.type !== 'tool_result') continue;
      const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      if (/not found/i.test(txt)) { verdict = 'not-found'; detail = txt.slice(0, 200); }
      else if (/程晚|运营|同事|我是/.test(txt)) { verdict = 'ok'; detail = txt.slice(0, 160); }
    }
  }
  if (m.type === 'result') { if (verdict !== 'timeout') { closed = true; break; } }
  if (Date.now() - t0 > 120000) { closed = true; break; }
}
console.log(`真卡加载：${verdict}`);
console.log(detail.replace(/\n/g, ' '));
process.exit(0);
