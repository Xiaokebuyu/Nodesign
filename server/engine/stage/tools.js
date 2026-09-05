/**
 * engine/stage/tools.js —— 演出进程的工具面（MCP）。
 *
 * 台上的人只需要四件事：把这一拍写出来、给玩家把手、掷骰、在关键点存档。
 * 内置工具那边只留了 Read/Glob/Grep/Skill（读角色卡和世界书、加载 story-* 技能包），
 * Write 和 Bash 是挡掉的 —— 所以落盘一律走这里，路径由服务端拼，模型给不了绝对路径。
 *
 * 落点全在**这场戏的文件夹**里（engine/stage/play.js 的布局）：
 *   场景/scenes.jsonl   一拍一行     记忆/*.md + INDEX.md   这场戏的记忆
 *   角色/<名>/记忆/     某个人的记忆（索引写回他的卡）
 *
 * ⚠️ 参数名和枚举值一律 ASCII：中文参数名会让 agent 静默结束回合（老账）。
 * 描述和返回正文用中文没问题。
 * ⛔⛔ schema 里不许有 z.record：SDK 会因为它静默丢掉整个服务器的工具（tools.test.js 钉着）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCardPath, cardHome, rewriteCardMemoryIndex, CARD_MEMORY_DIR } from './card.js';
import { SCENES_DIR, SCENES_FILE, MEMORY_DIR, MEM_INDEX } from './play.js';

/** 选项一枚：label 是按钮上的字，hint 是按钮下那行小字，prompt 是点下去发生什么。 */
const choiceSchema = z.object({
  label: z.string().min(1).max(20).describe('按钮上的字，四到六个字最好'),
  hint: z.string().max(60).optional().describe('按钮下面那行小字，说清楚点下去是要做什么'),
  prompt: z.string().min(1).max(500).describe('玩家点下这枚之后，等于他对你说了这句话'),
});

export async function appendSceneRow(playAbs, row) {
  const p = path.join(playAbs, SCENES_DIR, SCENES_FILE);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/**
 * @param {object} ctx  workspaceRoot / playRoot（戏的文件夹，工作区相对）/ onScene（写完一拍的回调，推给显示器）
 *                      / onCardTouched（进程自己改了某张卡的索引块）
 */
export function createStageTools(ctx) {
  const workspaceRoot = ctx.workspaceRoot || ctx.dir;
  const playRoot = ctx.playRoot || '';
  const playAbs = playRoot ? path.join(workspaceRoot, playRoot) : workspaceRoot;

  const writeScene = tool(
    'write_scene',
    '把这一拍写到台上。正文是完整的一段戏（环境、动作、所有人的对白都在里面），'
    + '第三人称旁白，对白单独成段。choices 是留给玩家的把手 —— 两到四枚，'
    + '一枚推进主线、一枚人际、一枚合理但意想不到的。**没有把手这一拍就没写完**。'
    + 'state 每拍必填：这一拍改了哪些状态值就报哪些，什么都没变就传空数组 —— 空数组的意思是"我看过了，没变"。',
    {
      text: z.string().min(1).max(8000).describe('这一拍的正文'),
      choices: z.array(choiceSchema).min(1).max(5).describe('留给玩家的把手，两到四枚'),
      scene: z.string().max(60).optional().describe('换场景时给一句地点时间，不换就别传。换了场显示器会换背景'),
      speakers: z.array(z.string().max(30)).max(12).optional()
        .describe('这一拍开过口的人（用在场者的名字）。显示器靠它点亮名册，多人场面才用得上'),
      // ⛔⛔ 这里不能用 z.record（SDK 会静默丢掉整个 stage 服务器的工具）。键值对数组落盘时折成对象。
      state: z.array(z.object({
        key: z.string().min(1).max(30).describe('状态键，跟开戏时状态面板声明的 key 一致'),
        value: z.union([z.string().max(60), z.number()]).describe('新值'),
      })).max(12)
        .describe('这一拍改了的状态值，只传变了的键：[{"key":"好感","value":32}]。没变就传 []（必填，逼你每拍看一眼数值）'),
    },
    async ({ text, choices, scene, speakers, state }) => {
      const stateObj = state?.length ? Object.fromEntries(state.map(kv => [kv.key, kv.value])) : null;
      const row = {
        id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'stage', text, choices,
        ...(scene ? { scene } : {}),
        ...(speakers?.length ? { speakers } : {}),
        ...(stateObj ? { state: stateObj } : {}),
      };
      await appendSceneRow(playAbs, row);
      const extra = await ctx.onScene?.(row);   // manager 可能回一句（成就 / 触发），带给它
      return { content: [{ type: 'text', text: `这一拍已经在台上了（${text.length} 字，${choices.length} 枚把手${stateObj ? `，状态改了 ${Object.keys(stateObj).length} 项` : ''}）。${extra || ''}玩家点了哪一枚会当成他的话送回来，停在这里等他。` }] };
    },
  );

  /**
   * 记忆分两个家：带 who 是**某个人**记得的事 → 他的卡（角色/<名>/记忆/ + 卡末尾的索引块）；
   * 不带 who 是这场戏的事（演到哪 / 伏笔 / 世界新事实）→ 记忆/，索引进 INDEX.md。
   * 形状照搬 harness 那套 auto-memory：一事一文件、frontmatter、索引常驻正文按需 Read。
   */
  const remember = tool(
    'remember',
    '记住一件事。一件事一份，别把两件事塞进一份。存之前先看索引里有没有已经在写这件事的，'
    + '有就用同一个 name 覆盖它，别新建第二份。'
    + '**是某个人记得的事（他的态度、他知道的秘密、他跟谁的关系）就带 who** —— 那会写进他的角色卡，'
    + '跟着他走；演到哪了、伏笔、世界里确立的新事实不带 who，那是这场戏的。'
    + '⛔ 别记这一拍刚发生的流水账 —— 正文本身就在台上，记忆是给**之后还会用到**的东西准备的：'
    + '关系变了、伏笔埋下、世界里确立了一个新事实、玩家做了回不了头的选择。',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('文件名，小写英文加连字符，比如 qingke-attitude'),
      type: z.enum(['progress', 'character', 'thread', 'world'])
        .describe('progress=演到哪了 / character=某个人的态度与他记得的事（要带 who）/ thread=伏笔 / world=演出中确立的设定'),
      who: z.string().max(40).optional().describe('这是谁记得的事：在场者的名字（角色卡上的 name）。给了就写进他的卡'),
      description: z.string().min(1).max(80).describe('一行摘要，进索引，也是之后判断"这条现在用不用得上"的依据'),
      content: z.string().min(1).max(8000).describe('正文 markdown。写事实，别写这一拍的散文'),
    },
    async ({ name, type, who, description, content }) => {
      if (type === 'character' && !who) {
        return { content: [{ type: 'text', text: 'character 类的记忆要带 who（这是谁记得的事），不然没法写进他的卡。' }], isError: true };
      }
      const head = `---\nname: ${name}\ntype: ${type}\ndescription: ${description.replace(/\n/g, ' ')}\nat: ${new Date().toISOString()}\n---\n\n`;
      if (who) {
        const cardRel = await resolveCardPath(workspaceRoot, who, { playRoot });
        if (!cardRel) return { content: [{ type: 'text', text: `没有叫「${who}」的角色卡，写不进他的记忆。名字要跟在场者一致。` }], isError: true };
        const memDir = path.join(workspaceRoot, cardHome(cardRel), CARD_MEMORY_DIR);
        await fs.mkdir(memDir, { recursive: true });
        await fs.writeFile(path.join(memDir, `${name}.md`), head + content, 'utf8');
        const n = await rewriteCardMemoryIndex(workspaceRoot, cardRel);
        await ctx.onCardTouched?.(cardRel);
        return { content: [{ type: 'text', text: `记进「${who}」的卡了：${name}（${type}）。他的索引现在 ${n} 条，下次开戏随卡进系统提示词。` }] };
      }
      const dirAbs = path.join(playAbs, MEMORY_DIR);
      await fs.mkdir(dirAbs, { recursive: true });
      await fs.writeFile(path.join(dirAbs, `${name}.md`), head + content, 'utf8');
      const n = await rewriteIndex(dirAbs);
      return { content: [{ type: 'text', text: `记住了：${name}（${type}）。这场戏的索引现在 ${n} 条，下次开戏整份进你的系统提示词。` }] };
    },
  );

  const forget = tool(
    'forget',
    '删掉一条记错了或者已经作废的记忆。剧情推翻了旧设定时用，别留着两份打架的。记在某个人卡上的要带 who。',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('要删的那份的 name'),
      who: z.string().max(40).optional().describe('这条记在谁的卡上；这场戏的记忆不带'),
    },
    async ({ name, who }) => {
      if (who) {
        const cardRel = await resolveCardPath(workspaceRoot, who, { playRoot });
        if (!cardRel) return { content: [{ type: 'text', text: `没有叫「${who}」的角色卡。` }], isError: true };
        try { await fs.unlink(path.join(workspaceRoot, cardHome(cardRel), CARD_MEMORY_DIR, `${name}.md`)); } catch { return { content: [{ type: 'text', text: `「${who}」的卡上没有叫 ${name} 的记忆，没动。` }] }; }
        const n = await rewriteCardMemoryIndex(workspaceRoot, cardRel);
        await ctx.onCardTouched?.(cardRel);
        return { content: [{ type: 'text', text: `删了「${who}」的 ${name}，他的索引剩 ${n} 条。` }] };
      }
      const dirAbs = path.join(playAbs, MEMORY_DIR);
      try { await fs.unlink(path.join(dirAbs, `${name}.md`)); } catch { return { content: [{ type: 'text', text: `没有叫 ${name} 的记忆，索引没动。` }] }; }
      const n = await rewriteIndex(dirAbs);
      return { content: [{ type: 'text', text: `删了 ${name}，索引剩 ${n} 条。` }] };
    },
  );

  const rollDice = tool(
    'roll',
    '掷骰。服务端真随机，⛔ 永远别自己编点数 —— 编的会塌掉整桌的信任。',
    {
      sides: z.number().int().min(2).max(1000).describe('骰面数，常用 20 或 100'),
      count: z.number().int().min(1).max(10).default(1).describe('掷几颗'),
      reason: z.string().max(60).describe('为什么掷，会显示给玩家看'),
    },
    async ({ sides, count, reason }) => {
      const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
      const total = rolls.reduce((a, b) => a + b, 0);
      const row = { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'dice', reason, sides, rolls, total };
      await appendSceneRow(playAbs, row);
      await ctx.onScene?.(row);
      return { content: [{ type: 'text', text: `d${sides}×${count} = ${rolls.join(', ')}（合计 ${total}）· ${reason}` }] };
    },
  );

  // ⛔ 四件全部常驻（_meta alwaysLoad）：env 里带着 ENABLE_TOOL_SEARCH 时 MCP 工具默认延迟加载，
  // 模型看不见 write_scene，而提示词又叫它"不用 ToolSearch 去找别的"（09-05 真栽）。
  const always = (t) => ({ ...t, _meta: { ...(t._meta || {}), 'anthropic/alwaysLoad': true } });
  return createSdkMcpServer({ name: 'stage', version: '1.1.0', tools: [writeScene, remember, forget, rollDice].map(always) });
}

/**
 * 索引重建 —— 每次写/删之后从磁盘上的文件重扫一遍。
 * ⭐ 不是增量维护：增量的索引会跟正文对不上（改了正文忘了改索引就是第二个真相源）。
 */
export async function rewriteIndex(dirAbs) {
  const files = (await fs.readdir(dirAbs).catch(() => [])).filter(f => f.endsWith('.md') && f !== MEM_INDEX);
  const rows = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dirAbs, f), 'utf8').catch(() => '');
    const d = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    const t = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    rows.push(`- [${f.replace(/\.md$/, '')}](${f})${t ? ` \`${t}\`` : ''} — ${d}`);
  }
  rows.sort();
  await fs.mkdir(dirAbs, { recursive: true });
  await fs.writeFile(path.join(dirAbs, MEM_INDEX),
    `# 这场戏记住的事\n\n一行一条，正文在各自的文件里，要用再 Read。\n\n${rows.join('\n')}\n`, 'utf8');
  return rows.length;
}

/** 用户那一侧也落在流上：显示器要画"你"的那一栏。 */
export async function appendUserLine(playAbs, text) {
  return appendSceneRow(playAbs, { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'user', text });
}

/** 开戏时把索引整份接回系统提示词（正文不贴，让它按需 Read）。 */
export async function readMemoryIndex(playAbs) {
  try { return await fs.readFile(path.join(playAbs, MEMORY_DIR, MEM_INDEX), 'utf8'); } catch { return null; }
}
/** 这场戏记忆的清单（显示器的记忆页） */
export async function listMemories(playAbs) {
  const dir = path.join(playAbs, MEMORY_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter(f => f.endsWith('.md') && f !== MEM_INDEX).sort();
  const out = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const get = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm?.[1] || '')?.[1]?.trim() || '';
    out.push({ name: f.replace(/\.md$/, ''), type: get('type'), description: get('description'), at: get('at'), content: fm ? raw.slice(fm[0].length).trim() : raw });
  }
  return out;
}
export async function readScenes(playAbs, { limit = 300 } = {}) {
  try {
    const raw = await fs.readFile(path.join(playAbs, SCENES_DIR, SCENES_FILE), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}
