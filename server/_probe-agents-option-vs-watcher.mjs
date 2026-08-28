/**
 * _probe-agents-option-vs-watcher.mjs —— 「options.agents 是否杀死角色目录热扫描」对照实验（2026-08-28）
 *
 * 跑法：cd server && node _probe-agents-option-vs-watcher.mjs
 *
 * ## 背景：真会话事故 proj_mtd1tap1_etjw
 *
 * 同一天、同一套代码：哥杀场 12:58 cast → 13:07 派成；时停场 14:39 cast →
 * 14:50/14:58/15:07 跨多个回合全部 `Agent type not found`。生产与 08-26 探针的
 * 唯一已知配置差：生产传了 `agents: createAgents(...)`（干活代理三件套），
 * 08-26 验通「隔回合可派」的 _probe-cast-role.mjs **没传**。
 *
 * ## 三个变体（一次跑完）
 *
 *   A 传 options.agents + 角色文件**会话中途**落盘 → 下一回合派   ← 生产条件
 *   B 不传 options.agents + 同样中途落盘 → 下一回合派           ← 08-26 探针条件（对照组）
 *   C 传 options.agents + 角色文件**会话启动前**就在 → 第一回合派 ← 预注册条件
 *
 * 判读表：
 *   A败 B成 → 实锤 options.agents 杀热扫描（生产 cast_role 从上线起就是死的，
 *             此前的"成功"全是进程重启带来的初始扫描）；C 的结果决定演员位方案要不要绕它
 *   A成 B成 → options.agents 无罪，回去查环境（watcher 竞态/inotify）
 *   B败     → 探针本身坏了或 CLI 行为变了，先修判据
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const say = (...a) => console.log(...a);
const ROLE_MD = [
  '---', 'name: rp-probe', 'description: "探针角色"', 'tools: ', 'model: inherit', '---', '',
  '你是探针角色。被问什么答什么，一句话，句尾带暗号「青鸟」。', '',
].join('\n');

async function runVariant({ label, withAgentsOption, fileBeforeStart }) {
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), `nd-agents-ab-${label}-`));
  fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
  if (fileBeforeStart) fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-probe.md'), ROLE_MD);

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
      maxTurns: 30,
      systemPrompt: '你是探针主代理。严格照用户说的做。工具报错时把报错原文一字不差转述给我，不要重试。',
      ...(withAgentsOption ? { agents: {
        // 模拟生产 createAgents：几个跟角色无关的干活代理
        'vision-checker': { description: '看图的（探针替身）', prompt: '你看图。', tools: [] },
        'ds-extractor': { description: '抽取器（探针替身）', prompt: '你抽取。', tools: [] },
      } } : {}),
      stderr: () => {},
    },
  });

  let verdict = null;   // 'ok' | 'not-found' | 'other'
  let detail = '';
  let stage = fileBeforeStart ? 'dispatch' : 'warmup';
  push(fileBeforeStart
    ? '派一个前台子代理 Agent(subagent_type:"rp-probe")，prompt:"你叫什么？"。把它的回答或报错原文转述给我。'
    : '回一句"好"，别的什么都不要做。');
  const t0 = Date.now();

  for await (const m of q) {
    // 从 tool_result 里直接判死活，不信模型转述
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type !== 'tool_result') continue;
        const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        if (/not found/i.test(txt) && /rp-probe/.test(txt)) { verdict = 'not-found'; detail = txt.slice(0, 160); }
        else if (/青鸟/.test(txt)) { verdict = 'ok'; detail = txt.slice(0, 120); }
      }
    }
    if (m.type !== 'result') continue;
    if (verdict) { closed = true; break; }
    if (stage === 'warmup') {
      stage = 'drop-file';
      // 会话中途落盘（= cast_role 干的事），给 watcher 的 awaitWriteFinish 留足量级
      fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-probe.md'), ROLE_MD);
      await new Promise((r) => setTimeout(r, 4000));
      push('派一个前台子代理 Agent(subagent_type:"rp-probe")，prompt:"你叫什么？"。把它的回答或报错原文转述给我。');
      stage = 'dispatch';
    } else if (Date.now() - t0 > 150000) { verdict = 'other'; detail = '超时'; closed = true; break; }
  }
  say(`  [${label}] ${verdict}  ${detail.replace(/\n/g, ' ')}`);
  return verdict;
}

say('A：传 options.agents，文件中途落盘（=生产条件）');
const A = await runVariant({ label: 'A', withAgentsOption: true, fileBeforeStart: false });
say('B：不传 options.agents，文件中途落盘（=08-26 探针条件）');
const B = await runVariant({ label: 'B', withAgentsOption: false, fileBeforeStart: false });
say('C：传 options.agents，文件启动前就在（=预注册条件）');
const C = await runVariant({ label: 'C', withAgentsOption: true, fileBeforeStart: true });

say('\n—— 判读 ——');
say(`A（生产条件）  ：${A}`);
say(`B（探针条件）  ：${B}`);
say(`C（预注册条件）：${C}`);
if (A === 'not-found' && B === 'ok') say('→ 实锤：options.agents 杀死了角色目录热扫描。');
if (A === 'ok' && B === 'ok') say('→ options.agents 无罪，回去查环境（watcher 竞态 / inotify / 时序）。');
if (B !== 'ok') say('→ 对照组都不成立，先修探针或怀疑 CLI 行为变了。');
process.exit(0);
