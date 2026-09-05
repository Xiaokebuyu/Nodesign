/**
 * mcp/tools/open-stage.js —— open_stage：把一个故事交给演出进程（2026-09-05；09-06 加写法预设、不再自动起进程）
 *
 * 主 agent 在 RP 里的位置从此是**后台**：问清楚用户想怎么玩、把世界/人物/规矩编成一份
 * 设定（skill `stage-setup` 教怎么写），然后调这一件把它交出去。之后台上每一段
 * 由演出进程写，用户的话直接进它的队列，主 agent 不再转述、不再代演。
 *
 * 为什么是独立进程不是子代理：子代理没法不吃项目 CLAUDE.md（SDK 强制注入），而 RP 模式
 * 下那份档案是污染；独立会话 settingSources:[] 一刀切干净。细账在 engine/stage/session.js。
 *
 * 一个故事一个文件夹（按标题起名，见 engine/stage/play.js）。同名再调一次 = 换设定重开：
 * 重写设定 / 规则、停掉在跑的进程，场景和记忆**不清** —— 上一场记住的事照样接回去。
 * 用户要"从头再来"时让他自己删那个文件夹（画布上那张卡），别替他删。
 *
 * 09-06 起 open_stage **不起进程**：玩家双击卡进显示器，在开场页挑写法预设、勾角色卡上的可选条目，
 * 点「开始」才起（之前一调就先烧 400MB，玩家还没进来）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { allowedModelsFor } from '../../agent/model-context.js';
import { stopStage, getStageRuntime, createPlay, SKINS } from '../../stage/manager.js';
import { validateCondition } from '../../stage/rules.js';
import { BUILTIN_IDS, DEFAULT_PRESET } from '../../stage/preset.js';

const castSchema = z.object({
  name: z.string().min(1).max(30).describe('在场者的名字，必须已经有角色卡（cast_role 写的 角色/<名>/角色卡.md）'),
  note: z.string().max(60).optional().describe('名字下面那行小字。不给就用卡 frontmatter 里的 note'),
});

const vitalSchema = z.object({
  key: z.string().min(1).max(30).describe('状态键，演出进程在 write_scene 的 state 里按这个键更新。⛔ 键名要跟你在设定里、规则里写的一字不差（09-05 有一场 vitals 用英文键、进程报中文键，面板永远是 0）'),
  label: z.string().max(20).optional().describe('面板上显示的名字，不给就用 key'),
  as: z.enum(['bar', 'chips', 'num', 'text']).default('text')
    .describe('bar=进度条（配 max）/ chips=几个格子里亮一个（配 options）/ num=数字（配 unit）/ text=一行字'),
  max: z.number().optional(),
  unit: z.string().max(10).optional(),
  options: z.array(z.string().max(20)).max(8).optional(),
  initial: z.union([z.string().max(60), z.number()]).optional().describe('开场时的值'),
  who: z.string().max(30).optional().describe('这个值属于哪个在场者（比如"好感度"属于她）。给了显示器的角色页会把它挂在这个人身上；世界性的（时间 / 天气）不给'),
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
  note: z.string().min(1).max(300).describe('阈值到了要递给演出进程的便条，比如 "好感过 60，按卡上的分阶段人设进熟稔期，这一段起可以让她主动开口"'),
  once: z.boolean().default(true).describe('只触发一次（默认）还是每次成立都递'),
});
const panelItemSchema = z.object({ name: z.string().min(1).max(40), qty: z.number().int().min(0).max(9999).optional(), note: z.string().max(120).optional(), price: z.number().min(0).optional(), slot: z.string().max(12).optional(), tags: z.array(z.string().max(12)).max(6).optional() });
const panelSchema = z.object({
  id: z.string().min(1).max(20).describe('面板名，演出进程 update_panel 按它指；显示器顶栏按它加一页。中文就行：背包 / 装备 / 杂货铺'),
  name: z.string().max(20).optional().describe('显示名，不给就用 id'),
  kind: z.enum(['inventory', 'equipment', 'shop', 'list']).describe('inventory 背包 / equipment 装备与穿着（带槽位，挂在某个人身上）/ shop 商店（条目带价，玩家能在显示器里点买）/ list 泛清单（任务、线索…）'),
  who: z.string().max(30).optional().describe('equipment 用：这是谁的装备'),
  slots: z.array(z.string().max(12)).max(12).optional().describe('equipment 用：槽位，默认 头 / 身 / 手 / 脚 / 饰品'),
  currency: z.string().max(20).optional().describe('shop 用：用哪个状态键当钱（要在 vitals 里声明过，比如 金钱）'),
  into: z.string().max(20).optional().describe('shop 用：买到的东西进哪个面板，默认第一个 inventory'),
  items: z.array(panelItemSchema).max(60).optional().describe('开场就有的条目'),
});
const styleSchema = z.object({
  preset: z.string().max(80).describe(`写法预设 id：${BUILTIN_IDS.map(x => `"${x}"`).join(' / ')}（内置），或 "user:<文件夹名>"（用户上传的酒馆预设 JSON，先放进 <故事>/预设/ 下），或 "none"`),
  on: z.array(z.string().max(60)).max(80).optional().describe('按用户开场前的回答，在默认勾选之上**加开**的模块 id（表在 skill stage-setup 的 presets.md）。互斥组里开一个，机器会关掉同组默认那个'),
  off: z.array(z.string().max(60)).max(80).optional().describe('按用户的回答**关掉**的模块 id。always 组（通用规矩）关不掉'),
  modules: z.array(z.string().max(60)).max(80).optional().describe('老写法，等于 on'),
});

export function makeOpenStageTool({ projectId }) {
  return tool(
    'open_stage',
    `Hand a story to the stage process and step back to stage-manager duty.

Two kinds of files make a story (load skill \`stage-setup\` first):
  - the TABLE (\`table\` here → written to <story>/台面.md): world, difficulty, how much you
    ghost-write, prose rules, how to act. Everything that belongs to THIS story, not to a person.
  - the CARDS (<story>/角色/<名>/角色卡.md, written earlier with cast_role): who each person is, how
    they talk, what they never do, plus their own memory index. Everything that belongs to a PERSON.
    A card may carry a \`## 可选\` section (one \`- [ ] item — why\` per line): the player toggles those
    on the opening screen, so put "does the player want this subplot / trait?" items there.
The stage process gets table + every cast member's card verbatim as its system prompt, plus the
prose preset the player picks on the opening screen (default: ${DEFAULT_PRESET}), and nothing else:
no project CLAUDE.md, no memory of yours.

This does NOT start the process. The player opens the card, picks a prose preset and card options
on the opening screen, and presses 开始; the machine then writes the opening instruction itself.
Leave \`skin\` at its default (matches the platform); the player can change looks in the display.
Call this once. From here on the user talks to the stage directly through the display card;
you do not relay, narrate, or act. Calling again rewrites the table and stops the running process,
keeping scenes and memories. To wipe a story, the user deletes its folder themselves.`,
    {
      title: z.string().min(1).max(60).describe('这个故事的名字，卡上和显示器顶栏都显示它'),
      table: z.string().min(100).max(40000)
        .describe('设定全文（世界 / 规矩 / 怎么演），写进 <故事>/台面.md。这是冻结区：只放整场不变的东西，人物不在这里 —— 人物在各自的卡上'),
      cast: z.array(castSchema).min(1).max(12).describe('在场者。每个都要先有角色卡；一人=显示器画立绘，多人=画名册'),
      vitals: z.array(vitalSchema).max(8).optional().describe('状态面板显示哪些字段（好感 / 时间 / 体力…）。不需要就别传'),
      skin: z.enum(SKINS).default('paper').describe('显示器外观。留默认 paper（跟平台一致）；玩家自己会换'),
      style: styleSchema.optional().describe('写法预设与预选。用户在开场问答里说了偏好（慢一点 / 多对白 / 第一人称 / 像轻小说 / 短一点…）就按 presets.md 的表翻成 on / off 传进来，开场页会标"agent 预选了这些，你可以改"；什么都没说就不传（默认 Izumi 全默认）。用户交了自己的酒馆预设 JSON 才传 preset: user:<名>'),
      opening: z.string().max(6000).optional().describe('开场参考：酒馆卡的 first_mes（开场白）和 scenario 原文贴这里，{{user}} 那类占位符不用改。机器在玩家点「开始」时把它交给演出进程当第一段的底：照它的地点、时刻、气氛和头几句写，不照抄，占位符换成玩家的角色。没有就不传，进程按设定自己开场'),
      images: z.boolean().optional().describe('演出进程能不能自己配图（关键转折的插图 / 换场背景 / 立绘）。每张 $0.20 左右计入玩家每日额度、约一分钟。玩家在问答里明确说了才传；没说就不传，他在开场页自己开'),
      model: z.string().max(80).optional().describe('演出进程用哪个模型。只在玩家点名要某个模型时传，且得是他账号当前能选的（选不了会当场退回）；不传用默认，他在开场页自己挑'),
      lore: z.object({ off: z.array(z.string().max(80)).max(500) }).optional().describe('按玩家开场前的回答**预先关掉**的世界书条目名（read_tavern_json 导出时给的名字）：他说不要某条支线 / 某类内容 / 某个人物线，对应条目名列在这里，开场页画成开关他还能改。没说就不传，全开'),
      panels: z.array(panelSchema).max(8).optional().describe('跑团 / 冒险类才要：背包、装备与穿着、商店、任务清单这类**清单状态**。声明了显示器就多出对应的页，演出进程用 update_panel 记账，玩家能在显示器里买 / 用 / 装上。恋爱日常那种不要硬加'),
      achievements: z.array(achievementSchema).max(40).optional()
        .describe('奖杯。阈值按用户选的难度定（爽档 40 就给"她笑了"，严酷档要 80）。事件型的靠 state 里的标志位：牵手 == 1'),
      triggers: z.array(triggerSchema).max(20).optional()
        .describe('剧情推进：从酒馆卡的分阶段规则翻过来 —— 关键数值到了阈值，机器递纸条给演出进程，它这一段照着推'),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId) return fail('没有项目上下文，open_stage 不可用。');
      try {
        for (const r of [...(args.achievements || []), ...(args.triggers || [])]) {
          const bad = validateCondition(r.when);
          if (bad) return fail(`规则「${r.id}」的条件不合法：${bad}`);
        }
        if (args.model) {
          const owner = getProject(projectId)?.ownerId ? getUserById(getProject(projectId).ownerId) : null;
          const ok = owner ? allowedModelsFor(owner).map(m => m.id) : [];
          if (!ok.includes(args.model)) return fail(`这个账号现在选不了 ${args.model}。能选的：${ok.join(' / ') || '（查不到账号）'}。不传 model 就用默认。`);
        }
        const style = args.style ? { preset: args.style.preset, on: [...(args.style.on || []), ...(args.style.modules || [])], off: args.style.off || [] } : null;
        const root = await createPlay(projectId, {
          title: args.title, table: args.table, cast: args.cast, vitals: args.vitals || [], skin: args.skin, style, panels: args.panels || null, opening: args.opening || null, lore: args.lore || null, images: typeof args.images === 'boolean' ? args.images : undefined, model: args.model || null,
          rules: (args.achievements || args.triggers) ? { achievements: args.achievements || [], triggers: args.triggers || [] } : null,
        });
        const rt = getStageRuntime(projectId, root);
        const wasRunning = !!rt?.running;
        if (wasRunning) await stopStage(projectId, root, 'reopen');
        const who = args.cast.map(c => c.name).join(' / ');
        return {
          content: [{
            type: 'text',
            text: `${wasRunning ? '换了设定，进程已停，下一句话到时重开' : '建好了'}：「${args.title}」→ 文件夹 ${root}/，在场 ${who}，设定 ${args.table.length} 字`
              + `${args.achievements?.length ? `，${args.achievements.length} 枚奖杯` : ''}${args.triggers?.length ? `，${args.triggers.length} 条推进触发` : ''}${args.panels?.length ? `，${args.panels.length} 块面板（${args.panels.map(p => p.name || p.id).join(' / ')}）` : ''}${style ? `，写法预设 ${style.preset}（预选 +${style.on.length} −${style.off.length}，玩家开场页能改）` : '，写法由玩家开场时挑（默认 Izumi）'}。`
              + '\n这个故事的一切都在那个文件夹里（设定 / 角色卡 / 记忆 / 场景 / 规则 / 预设），画布上它是一张卡，用户双击进去先到开场页：'
              + '看世界与人物、挑写法、勾角色卡上的可选条目，点「开始」机器才起进程并发开场指令；之后他说的每句话直接进进程，不经过你。'
              + '\n你现在在后台：别在这里代演、别复述显示器上的剧情。用户回到这里跟你说话时才是在跟你说话（改设定 / 换玩法 / 问怎么用）。'
              + '\n改人设 = 改角色卡（cast_role 重登或用户在显示器里改）；改规矩 = 再调 open_stage 或用户在显示器里改设定。改完下一句话到时进程自动重开（resume 转录，前文不丢），场景和记忆都留着。',
          }],
        };
      } catch (err) {
        return fail(`建不了：${err.message}`);
      }
    },
  );
}
