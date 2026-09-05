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
 * 一场戏一个文件夹（按标题起名，见 engine/stage/play.js）。同名再调一次 = 换设定重开：
 * 重写台面 / 规则、停掉在跑的进程再起，场景和记忆**不清** —— 上一场记住的事照样接回去。
 * 用户要"从头再来"时让他自己删那个文件夹（画布上那张卡），别替他删。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { startStage, stopStage, getStageRuntime, createPlay, SKINS } from '../../stage/manager.js';
import { validateCondition } from '../../stage/rules.js';

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

const achievementSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('英文 id'),
  title: z.string().min(1).max(30).describe('奖杯名，玩家看的'),
  desc: z.string().max(80).optional().describe('一句话说明'),
  when: z.string().min(3).max(200).describe('条件：键 比较符 值，用 and / or 连，比如 "好感 >= 60 and 表白状态 == 1"。键来自 vitals 与 write_scene 的 state，另有机器补的 拍数'),
  tier: z.enum(['bronze', 'silver', 'gold', 'platinum']).default('bronze'),
  hidden: z.boolean().default(false).describe('达成前不显示名字'),
});
const triggerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  when: z.string().min(3).max(200).describe('条件写法同成就'),
  note: z.string().min(1).max(300).describe('阈值到了要递给演出进程的场务纸条，比如 "好感过 60，按卡上的分阶段人设进熟稔期，这一拍起可以让她主动开口"'),
  once: z.boolean().default(true).describe('只触发一次（默认）还是每次成立都递'),
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
      achievements: z.array(achievementSchema).max(40).optional()
        .describe('奖杯。阈值按用户选的难度定（爽档 40 就给"她笑了"，严酷档要 80）。事件型的靠 state 里的标志位：牵手 == 1'),
      triggers: z.array(triggerSchema).max(20).optional()
        .describe('剧情推进：从酒馆卡的分阶段规则翻过来 —— 关键数值到了阈值，机器递纸条给演出进程，它这一拍照着推'),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId) return fail('没有项目上下文，open_stage 不可用。');
      try {
        for (const r of [...(args.achievements || []), ...(args.triggers || [])]) {
          const bad = validateCondition(r.when);
          if (bad) return fail(`规则「${r.id}」的条件不合法：${bad}`);
        }
        const root = await createPlay(projectId, {
          title: args.title, table: args.table, cast: args.cast, vitals: args.vitals || [], skin: args.skin,
          rules: (args.achievements || args.triggers) ? { achievements: args.achievements || [], triggers: args.triggers || [] } : null,
        });
        const rt = getStageRuntime(projectId, root);
        const wasRunning = !!rt?.running;
        if (wasRunning) await stopStage(projectId, root, 'reopen');
        const st = await startStage(projectId, root);
        const who = args.cast.map(c => c.name).join(' / ');
        return {
          content: [{
            type: 'text',
            text: `${wasRunning ? '换了台面重开' : '开演了'}：「${args.title}」→ 文件夹 ${root}/，在场 ${who}，台面 ${args.table.length} 字，系统提示词共 ${st.promptChars || '?'} 字（台面 + 角色卡 + 记忆索引）`
              + `${args.achievements?.length ? `，${args.achievements.length} 枚奖杯` : ''}${args.triggers?.length ? `，${args.triggers.length} 条推进触发` : ''}。`
              + '\n这场戏的一切都在那个文件夹里（台面 / 角色卡 / 记忆 / 场景 / 规则），画布上它是一张演出卡，用户双击就进显示器；他在那里说的每句话直接进演出进程，不经过你。'
              + '\n你现在是场务：别在这里代演、别复述台上的剧情。用户回到这里跟你说话时才是在跟你说话（改设定 / 换玩法 / 问怎么用）。'
              + '\n改人设 = 改角色卡（cast_role 重登或用户在显示器里改）；改规矩 = 再调 open_stage 或用户在显示器里改台面。改完下一句话到时进程自动重开，场景和记忆都留着。',
          }],
        };
      } catch (err) {
        return fail(`开不了戏：${err.message}`);
      }
    },
  );
}
