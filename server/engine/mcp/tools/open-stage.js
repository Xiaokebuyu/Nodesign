/**
 * mcp/tools/open-stage.js —— open_stage：把一场戏交给演出进程（2026-09-05）
 *
 * 主 agent 在 RP 里的位置从此是**场务**：问清楚用户想怎么玩、把世界/人物/规矩编成一份
 * 系统提示词（skill `stage-setup` 教怎么写），然后调这一件把它交出去。之后台上每一拍
 * 由演出进程写，用户的话直接进它的队列，主 agent 不再转述、不再代演。
 *
 * 为什么是独立进程不是子代理：子代理没法不吃项目 CLAUDE.md（SDK 强制注入），而 RP 模式
 * 下那份档案是污染；独立会话 settingSources:[] 一刀切干净。细账在 engine/stage/session.js。
 *
 * 一个项目一场戏（stage/ 固定目录）。再调一次 = 换设定重开：写新的 stage.json、
 * 停掉在跑的进程再起，scenes.jsonl 和 memory/ **不清** —— 上一场记住的事照样接回去。
 * 用户要"从头再来"时让他自己删 stage/ 文件夹（画布上那张卡），别替他删。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { startStage, stopStage, getStageRuntime, SKINS } from '../../stage/manager.js';

const castSchema = z.object({
  name: z.string().min(1).max(30).describe('在场者的名字，必须已经有角色卡（cast_role 写的 角色/<名>/角色卡.md）'),
  note: z.string().max(60).optional().describe('名字下面那行小字。不给就用卡 frontmatter 里的 note'),
});

const vitalSchema = z.object({
  key: z.string().min(1).max(30).describe('状态键，演出进程在 write_scene 的 state 里按这个键更新'),
  label: z.string().max(20).optional().describe('面板上显示的名字，不给就用 key'),
  as: z.enum(['bar', 'chips', 'num', 'text']).default('text')
    .describe('bar=进度条（配 max）/ chips=几个格子里亮一个（配 options）/ num=数字（配 unit）/ text=一行字'),
  max: z.number().optional(),
  unit: z.string().max(10).optional(),
  options: z.array(z.string().max(20)).max(8).optional(),
  initial: z.union([z.string().max(60), z.number()]).optional().describe('开场时的值'),
});

export function makeOpenStageTool({ projectId }) {
  return tool(
    'open_stage',
    `Hand a play to the stage process and step back to stage-manager duty.

Two kinds of files make a play (load skill \`stage-setup\` first):
  - the TABLE (\`table\` here → written to stage/台面.md): world, difficulty, how much you
    ghost-write, prose rules, how to act. Everything that belongs to THIS play, not to a person.
  - the CARDS (角色/<名>/角色卡.md, written earlier with cast_role): who each person is, how
    they talk, what they never do, plus their own memory index. Everything that belongs to a PERSON.
The stage process gets table + every cast member's card verbatim as its system prompt, and
nothing else: no project CLAUDE.md, no memory of yours. The user can edit both files on the
canvas; the stage reopens itself on the next line after an edit.

Call this once. From here on the user talks to the stage directly through the display card;
you do not relay, narrate, or act. Calling again rewrites the table and restarts, keeping
scenes and memories. To wipe a play, the user deletes the stage/ folder themselves.`,
    {
      title: z.string().min(1).max(60).describe('这场戏的名字，卡上和显示器顶栏都显示它'),
      table: z.string().min(100).max(40000)
        .describe('台面全文（世界 / 台面规矩 / 怎么演），写进 stage/台面.md。这是冻结区：只放整场不变的东西，人物不在这里 —— 人物在各自的卡上'),
      cast: z.array(castSchema).min(1).max(12).describe('在场者。每个都要先有角色卡；一人=显示器画立绘，多人=画名册'),
      vitals: z.array(vitalSchema).max(8).optional().describe('状态面板显示哪些字段（好感 / 时间 / 体力…）。不需要就别传'),
      skin: z.enum(SKINS).default('paper').describe('显示器皮肤：paper 纸 / jiangnan 江南 / night 夜 / terminal 终端'),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId) return fail('没有项目上下文，open_stage 不可用。');
      try {
        const rt = getStageRuntime(projectId);
        const wasRunning = !!rt?.running;
        if (wasRunning) await stopStage(projectId, 'reopen');
        const st = await startStage(projectId, {
          title: args.title,
          table: args.table,
          cast: args.cast,
          vitals: args.vitals || [],
          skin: args.skin,
        });
        const who = args.cast.map(c => c.name).join(' / ');
        return {
          content: [{
            type: 'text',
            text: `${wasRunning ? '换了台面重开' : '开演了'}：「${args.title}」，在场 ${who}，台面 ${args.table.length} 字，系统提示词共 ${st.promptChars || '?'} 字（台面 + 角色卡 + 记忆索引）。`
              + '\n画布上多了一张演出卡，用户双击就进显示器；他在那里说的每句话直接进演出进程，不经过你。'
              + '\n你现在是场务：别在这里代演、别复述台上的剧情。用户回到这里跟你说话时才是在跟你说话（改设定 / 换玩法 / 问怎么用）。'
              + '\n改人设 = 改角色卡（cast_role 重登或用户在画布上改）；改规矩 = 再调 open_stage 或用户改 stage/台面.md。改完下一句话到时进程自动重开，scenes 和记忆都留着。',
          }],
        };
      } catch (err) {
        return fail(`开不了戏：${err.message}`);
      }
    },
  );
}
