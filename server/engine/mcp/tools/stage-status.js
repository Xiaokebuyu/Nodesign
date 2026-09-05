/**
 * mcp/tools/stage-status.js —— stage_status：主循环随时看一眼台上演到哪了（2026-09-06，站主问"主循环有这条通路吗"）
 *
 * 之前没有：主 agent 只能自己去 Read 场景/scenes.jsonl（几十 KB 起）和 记忆/INDEX.md。用户回到对话里说
 * "她怎么突然冷淡了""帮我把好感调低点""接下来往哪儿走"，agent 得先知道现在演到哪、状态值多少、记住了什么。
 * 这件是只读的摘要：不起进程、不改任何东西，读的和显示器 hello 是同一份（manager.stageState）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { stageState, ensurePlays } from '../../stage/manager.js';

export function makeStageStatusTool({ projectId }) {
  return tool(
    'stage_status',
    `Read where the story on the stage display currently is: state values, the last few beats,
what it has remembered, trophies earned, triggers fired, which storyline is active, whether the
process is running. Read-only; does not start anything. Use it whenever the user comes back to you
mid-story (to adjust settings, ask what is going on, change direction) so you talk about the actual
current situation instead of what you set up at the start. Beats are the stage's prose; do not
re-narrate them to the user, he has just read them.`,
    {
      title: z.string().max(60).optional().describe('故事的文件夹名（画布上那张卡的标题）。项目里只有一个时可不传'),
      beats: z.number().int().min(0).max(12).default(3).describe('带回最近几段正文（每段截到 600 字）。只要数值和记忆就传 0'),
    },
    async ({ title, beats }) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId) return fail('没有项目上下文。');
      const plays = await ensurePlays(projectId);
      if (!plays.length) return fail('这个项目还没有故事（open_stage 还没调过）。');
      const root = title && plays.includes(title) ? title : (plays.length === 1 ? plays[0] : null);
      if (!root) return fail(`有 ${plays.length} 个故事，指一下 title：${plays.join(' / ')}`);
      const st = await stageState(projectId, root, { limit: 200 });
      if (!st) return fail(`读不到「${root}」。`);
      const cfg = st.config || {};
      const rows = st.scenes || [];
      const stageRows = rows.filter(r => r.by === 'stage');
      const line = (cfg.lines || []).find(l => l.id === cfg.currentLine);
      const state = Object.entries(st.state || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '（还没有状态值）';
      const trophies = (st.trophies || []).map(t => `${t.title}（第 ${t.beat} 段）`).join('、') || '无';
      const fired = (cfg.firedTriggers || []).join('、') || '无';
      const mem = (st.memoryIndex || '').trim().split('\n').filter(l => l.startsWith('- ')).slice(0, 20).join('\n') || '（还没记什么）';
      const tail = stageRows.slice(-Math.max(0, beats)).map((r, i, a) => {
        const n = stageRows.length - a.length + i + 1;
        const t = String(r.text || '');
        return `【第 ${n} 段${r.scene ? ` · ${r.scene}` : ''}${r.speakers?.length ? ` · ${r.speakers.join('/')}` : ''}】\n${t.length > 600 ? `${t.slice(0, 600)}…` : t}${r.choices?.length ? `\n（给玩家的选项：${r.choices.map(c => c.label).join(' / ')}）` : ''}`;
      }).join('\n\n');
      const lastUser = [...rows].reverse().find(r => r.by === 'user');
      const text = [
        `「${cfg.title || root}」· 线路 ${line?.name || '主线'}${(cfg.lines || []).length > 1 ? `（共 ${cfg.lines.length} 条）` : ''} · 共 ${stageRows.length} 段 · 进程${st.running ? (st.busy ? '正在写' : '在跑') : '停着（下一句话自动接上）'}${cfg.opened ? '' : ' · 玩家还没点开始'}`,
        `此刻：${state}`,
        `写法：${cfg.styleNames?.length ? cfg.styleNames.join(' / ') : (cfg.style?.preset || '默认')}${cfg.style?.by === 'agent' ? '（你预选的）' : ''} · 在场：${(cfg.cast || []).map(c => c.name).join('、') || '无'}`,
        `成就：${trophies}　推进已触发：${fired}`,
        `记住的事：\n${mem}`,
        lastUser ? `玩家最后一句：${String(lastUser.text).slice(0, 200)}` : '',
        tail ? `最近的正文：\n${tail}` : '',
        `文件都在 ${root}/ 下：场景/ 是全部记录，记忆/ 是正文，台面.md 与 角色/ 是设定。要改设定用 open_stage 或直接改文件，下一句话到时进程自动重开。`,
      ].filter(Boolean).join('\n\n');
      return { content: [{ type: 'text', text }] };
    },
  );
}
