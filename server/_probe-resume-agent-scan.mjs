/**
 * _probe-resume-agent-scan.mjs —— resume 的进程认不认「两个进程之间」落盘的角色文件（2026-08-28）
 *
 * 统一理论（来自三场真会话时序 + A/B/C 探针）：
 *   角色文件只在两个时刻被看见 —— ①会话**创建**时就在盘上（初始快照）
 *   ②写入时**当时活着**的进程（chokidar 事件）。resume 出来的新进程对
 *   「上一进程死后才写的文件」可能永久失明。
 *
 * 两个变体钉死它：
 *   D 进程1 起会话（目录空）→ 进程1 结束 → 落盘角色文件 → 进程2 resume → 派
 *      理论预测：NOT-FOUND（就是生产 not found 的最小复现）
 *   E 角色文件先落盘 → 进程1 起会话 → 结束 → 进程2 resume → 派
 *      理论预测：ok（创建时快照里有它）
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

function mkInput() {
  const pending = []; let notify = null; let closed = false;
  return {
    push: (t) => { pending.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); if (notify) { notify(); notify = null; } },
    close: () => { closed = true; if (notify) { notify(); notify = null; } },
    gen: (async function* () {
      while (!closed) {
        if (pending.length) { yield pending.shift(); continue; }
        await new Promise((r) => { notify = r; setTimeout(r, 300); });
      }
    }),
  };
}

const baseOptions = (WS) => ({
  cwd: WS,
  model: process.env.NODESIGN_MODEL || 'claude-sonnet-5',
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  settingSources: ['project'],
  maxTurns: 10,
  systemPrompt: '你是探针主代理。严格照用户说的做。工具报错时把报错原文一字不差转述，不要重试。',
  agents: { 'vision-checker': { description: '看图的（探针替身）', prompt: '你看图。', tools: [] } },
  stderr: () => {},
});

async function turn1(WS) {
  const io = mkInput();
  const q = query({ prompt: io.gen, options: baseOptions(WS) });
  io.push('回一句"好"，别的什么都不要做。');
  let sid = null;
  try {
    for await (const m of q) {
      if (m.session_id) sid = m.session_id;
      if (m.type === 'result') io.close();   // 关输入流让 CLI 自然退出，别 break 制造 abort
    }
  } catch (e) { if (e?.errorClass !== 'aborted' && !/aborted/i.test(String(e))) throw e; }
  return sid;
}

async function turn2Resume(WS, sid) {
  const io = mkInput();
  const q = query({ prompt: io.gen, options: { ...baseOptions(WS), resume: sid } });
  io.push('派一个前台子代理 Agent(subagent_type:"rp-probe")，prompt:"你叫什么？"。把它的回答或报错原文转述给我。');
  let verdict = 'timeout'; let detail = '';
  const t0 = Date.now();
  try {
    for await (const m of q) {
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          if (/not found/i.test(txt) && /rp-probe/.test(txt)) { verdict = 'not-found'; detail = txt.slice(0, 140); }
          else if (/青鸟/.test(txt)) { verdict = 'ok'; detail = txt.slice(0, 100); }
        }
      }
      if (m.type === 'result' && verdict !== 'timeout') io.close();
      if (Date.now() - t0 > 120000) io.close();
    }
  } catch (e) { if (e?.errorClass !== 'aborted' && !/aborted/i.test(String(e))) throw e; }
  return { verdict, detail };
}

// D：会话创建后（进程1 已死）才落盘 → resume 派
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-resume-D-'));
  fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
  const sid = await turn1(WS);
  fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-probe.md'), ROLE_MD);
  await new Promise((r) => setTimeout(r, 2000));
  const d = await turn2Resume(WS, sid);
  say(`D（进程间落盘 + resume 派）：${d.verdict}  ${d.detail.replace(/\n/g, ' ')}`);
}

// E：创建前就落盘 → 同样两进程 → resume 派（对照：排除 "resume 本身不认任何文件角色"）
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-resume-E-'));
  fs.mkdirSync(path.join(WS, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(WS, '.claude', 'agents', 'rp-probe.md'), ROLE_MD);
  const sid = await turn1(WS);
  const e = await turn2Resume(WS, sid);
  say(`E（创建前落盘 + resume 派）：${e.verdict}  ${e.detail.replace(/\n/g, ' ')}`);
}
process.exit(0);
