/**
 * engine/stage/tools.js —— 演出进程的工具面（MCP）。
 *
 * 台上的人只需要四件事：把这一段写出来、给玩家把手、掷骰、在关键点存档。
 * 内置工具那边只留了 Read/Glob/Grep/Skill（读角色卡和世界书、加载 story-* 技能包），
 * Write 和 Bash 是挡掉的 —— 所以落盘一律走这里，路径由服务端拼，模型给不了绝对路径。
 *
 * 落点全在**这个故事的文件夹**里（engine/stage/play.js 的布局）：
 *   场景/scenes.jsonl   一段一行     记忆/*.md + INDEX.md   这个故事的记忆
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
import { rollCheck, diceText } from './dice.js';

/** 小字只有类别词时视为没写（显示器那边同一条判据） */
export const CATEGORY_HINT_RE = /^[（(\[【]?\s*(推进主线|主线|人际|人际关系|意外|意想不到|合理但意想不到|剑走偏锋|支线|日常)\s*[）)\]】]?[。.]?$/;

/** 选项一枚：label 是按钮上的字，hint 是按钮下那行小字，prompt 是点下去发生什么。 */
const choiceSchema = z.object({
  label: z.string().min(1).max(20).describe('按钮上的字：玩家的角色要做的那个具体动作，四到八个字（"把橘子推过去一半"）'),
  hint: z.string().max(60).optional().describe('按钮下面那行小字：说清楚点下去他具体会做什么、说什么，或者接下来会发生什么。⛔ 不许写类别词 —— "主线""人际""意外""推进剧情"这种字玩家看不懂也不想看，写了显示器会直接删掉'),
  prompt: z.string().min(1).max(500).describe('玩家点下这枚之后，等于他对你说了这句话'),
  check: z.object({
    label: z.string().min(1).max(20).describe('判定的名目，显示在选项上（"敏捷" / "说服" / "潜行"）'),
    dc: z.number().int().min(1).max(1000).describe('难度：总点数 ≥ 它算成功'),
    sides: z.number().int().min(2).max(1000).optional().describe('骰面，默认 20'),
    modifier: z.number().int().min(-100).max(100).optional().describe('玩家角色在这项上的修正，默认 0'),
    advantage: z.enum(['none', 'adv', 'dis']).optional().describe('优势 / 劣势：掷两颗取高 / 取低'),
  }).optional().describe('这枚选项带一次判定：结果不确定且有代价的行动才带（翻墙、说服、潜行、出手）。玩家点下去机器先掷，成败随他这句话一起告诉你，你照结果写。日常动作别带'),
});

/** 记录文件默认是主线的；别的线路由调用方给 rel（play.js 的 sceneFileOf） */
export const MAIN_SCENES_REL = `${SCENES_DIR}/${SCENES_FILE}`;

export async function appendSceneRow(playAbs, row, rel = MAIN_SCENES_REL) {
  const p = path.join(playAbs, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/**
 * @param {object} ctx  workspaceRoot / playRoot（故事的文件夹，工作区相对）/ onScene（写完一段的回调，推给显示器）
 *                      / onCardTouched（进程自己改了某张卡的索引块）
 */
export function createStageTools(ctx) {
  const workspaceRoot = ctx.workspaceRoot || ctx.dir;
  const playRoot = ctx.playRoot || '';
  const playAbs = playRoot ? path.join(workspaceRoot, playRoot) : workspaceRoot;
  const scenesRel = () => (typeof ctx.scenesRel === 'function' ? ctx.scenesRel() : (ctx.scenesRel || MAIN_SCENES_REL));   // 当前线路的记录文件（切线后会变）

  const writeScene = tool(
    'write_scene',
    '把这一段写到台上。正文是完整的一段（环境、动作、所有人的对白都在里面），'
    + '第三人称旁白，对白单独成段。choices 是留给玩家的选项 —— 两到四枚，'
    + '你心里按"一枚推进主线、一枚人际、一枚合理但意想不到"来配，**但这三个词只是给你分类用的，不许出现在 label 或 hint 里**，'
    + '每一枚都写玩家具体会做什么。**没有选项这一段就没写完**。'
    + 'state 每段必填：这一段改了哪些状态值就报哪些，什么都没变就传空数组 —— 空数组的意思是"我看过了，没变"。',
    {
      text: z.string().min(1).max(8000).describe('这一段的正文'),
      choices: z.array(choiceSchema).min(1).max(5).describe('留给玩家的把手，两到四枚'),
      scene: z.string().max(60).optional().describe('换场景时给一句地点时间，不换就别传。换了场显示器会换背景'),
      speakers: z.array(z.string().max(30)).max(12).optional()
        .describe('这一段开过口的人（用在场者的名字）。显示器靠它点亮名册，多人场面才用得上'),
      // ⛔⛔ 这里不能用 z.record（SDK 会静默丢掉整个 stage 服务器的工具）。键值对数组落盘时折成对象。
      state: z.array(z.object({
        key: z.string().min(1).max(30).describe('状态键，跟开始时状态面板声明的 key 一致'),
        value: z.union([z.string().max(60), z.number()]).describe('新值'),
      })).max(12)
        .describe('这一段改了的状态值，只传变了的键：[{"key":"好感","value":32}]。没变就传 []（必填，逼你每段看一眼数值）'),
    },
    async ({ text, choices, scene, speakers, state }) => {
      // 选项小字是类别词（"主线""人际""意外"）的机械剥掉：玩家看的是动作意图，不是你的分类（09-06 站主点名）
      let stripped = 0;
      choices = choices.map(c => {
        if (CATEGORY_HINT_RE.test(String(c.label || '').trim()) && c.hint && !CATEGORY_HINT_RE.test(c.hint.trim())) { stripped++; return { ...c, label: c.hint.slice(0, 20), hint: undefined }; }   // 按钮上写了"主线"、小字才是动作：换过来
        if (c.hint && CATEGORY_HINT_RE.test(c.hint.trim())) { stripped++; return { ...c, hint: undefined }; }
        return c;
      });
      const stateObj = state?.length ? Object.fromEntries(state.map(kv => [kv.key, kv.value])) : null;
      const row = {
        id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'stage', text, choices,
        ...(scene ? { scene } : {}),
        ...(speakers?.length ? { speakers } : {}),
        ...(stateObj ? { state: stateObj } : {}),
      };
      await appendSceneRow(playAbs, row, scenesRel());
      const extra = await ctx.onScene?.(row);   // manager 可能回一句（成就 / 触发），带给它
      return {
        // 结束回合的标记也盖在返回上（SDK 文档只说 "MCP tool using _meta['claude/endTurn']"，定义上和返回上各盖一份，哪边认都行）
        _meta: { 'claude/endTurn': true },
        content: [{ type: 'text', text: `这一段已经在台上了（${text.length} 字，${choices.length} 枚选项${stateObj ? `，状态改了 ${Object.keys(stateObj).length} 项` : ''}）。${extra || ''}${stripped ? `有 ${stripped} 枚选项写了类别词（主线 / 人际 / 意外那种），已经改掉 —— 按钮上和小字里都只写他具体会做什么。` : ''}玩家点了哪一枚会当成他的话送回来。这一轮到此结束，不用再说话。` }],
      };
    },
  );

  /**
   * 记忆分两个家：带 who 是**某个人**记得的事 → 他的卡（角色/<名>/记忆/ + 卡末尾的索引块）；
   * 不带 who 是这个故事的事（演到哪 / 伏笔 / 世界新事实）→ 记忆/，索引进 INDEX.md。
   * 形状照搬 harness 那套 auto-memory：一事一文件、frontmatter、索引常驻正文按需 Read。
   */
  const remember = tool(
    'remember',
    '记住一件事。一件事一份，别把两件事塞进一份。存之前先看索引里有没有已经在写这件事的，'
    + '有就用同一个 name 覆盖它，别新建第二份。'
    + '**是某个人记得的事（他的态度、他知道的秘密、他跟谁的关系）就带 who** —— 那会写进他的角色卡，'
    + '跟着他走；演到哪了、伏笔、世界里确立的新事实不带 who，那是这个故事的。'
    + '⛔ 别记这一段刚发生的流水账 —— 正文本身就在台上，记忆是给**之后还会用到**的东西准备的：'
    + '关系变了、伏笔埋下、世界里确立了一个新事实、玩家做了回不了头的选择。',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('文件名，小写英文加连字符，比如 qingke-attitude'),
      type: z.enum(['progress', 'character', 'thread', 'world'])
        .describe('progress=演到哪了 / character=某个人的态度与他记得的事（要带 who）/ thread=伏笔 / world=演出中确立的设定'),
      who: z.string().max(40).optional().describe('这是谁记得的事：在场者的名字（角色卡上的 name）。给了就写进他的卡'),
      description: z.string().min(1).max(80).describe('一行摘要，进索引，也是之后判断"这条现在用不用得上"的依据'),
      content: z.string().min(1).max(8000).describe('正文 markdown。写事实，别写这一段的散文'),
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
        return { content: [{ type: 'text', text: `记进「${who}」的卡了：${name}（${type}）。他的索引现在 ${n} 条，下次开始随卡进系统提示词。` }] };
      }
      const dirAbs = path.join(playAbs, MEMORY_DIR);
      await fs.mkdir(dirAbs, { recursive: true });
      await fs.writeFile(path.join(dirAbs, `${name}.md`), head + content, 'utf8');
      const n = await rewriteIndex(dirAbs);
      return { content: [{ type: 'text', text: `记住了：${name}（${type}）。这个故事的索引现在 ${n} 条，下次开始整份进你的系统提示词。` }] };
    },
  );

  const forget = tool(
    'forget',
    '删掉一条记错了或者已经作废的记忆。剧情推翻了旧设定时用，别留着两份打架的。记在某个人卡上的要带 who。',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('要删的那份的 name'),
      who: z.string().max(40).optional().describe('这条记在谁的卡上；这个故事的记忆不带'),
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
    '判定骰。服务端真随机，⛔ 永远别自己编点数 —— 编的会塌掉整桌的信任。给了 dc 机器直接报成败（单颗 d20 及以上天然 20 / 1 是大成功 / 大失败）；'
    + '什么时候掷：结果不确定且有代价的行动，玩家明确宣告了冒险的动作。日常琐事不掷。失败买信息或代价，成功带来新问题，永远不是白板一场。',
    {
      reason: z.string().max(60).describe('判定什么，会显示给玩家看（"翻墙 · 敏捷"）'),
      sides: z.number().int().min(2).max(1000).default(20).describe('骰面数，常用 20 或 100'),
      count: z.number().int().min(1).max(10).default(1).describe('掷几颗（优势 / 劣势时只能一颗）'),
      modifier: z.number().int().min(-100).max(100).default(0).describe('加在总点上的修正'),
      dc: z.number().int().min(1).max(1000).optional().describe('难度：总点 ≥ 它算成功。不给就只是掷个数'),
      advantage: z.enum(['none', 'adv', 'dis']).default('none').describe('adv 掷两颗取高，dis 取低'),
    },
    async (args) => {
      const row = rollCheck(args);
      await appendSceneRow(playAbs, row, scenesRel());
      await ctx.onScene?.(row);
      return { content: [{ type: 'text', text: diceText(row) }] };
    },
  );

  /**
   * 面板（背包 / 装备 / 商店…）的机械动作：数量账在这里记，正文里不出现数字。⚠️ 要在 write_scene 之前调 —— write_scene 一返回这一轮就结束。
   * 真正的加减在 panels.js applyOp；manager 负责落盘、推给显示器。
   */
  const updatePanel = tool(
    'update_panel',
    '改一个面板（背包 / 装备 / 商店…这类清单）。得到了东西 add、用掉了 remove、穿上 equip、脱下 unequip、改数量或备注 set、铺子标价 price、清空 clear；'
    + '故事里出现了新的铺子 / 新的包 / 新的人的装备栏就 open 一块（给 kind，商店给 currency），离开不会再回来的店可以 close。'
    + '**在 write_scene 之前调**，正文里只写"她把绳子塞进包里"，数量归这里。面板名跟开场声明的一致（系统提示词里有清单），open 的用你起的名。',
    {
      panel: z.string().min(1).max(20).describe('面板名，比如 背包 / 装备 / 杂货铺'),
      op: z.enum(['add', 'remove', 'set', 'equip', 'unequip', 'clear', 'price', 'open', 'close']),
      kind: z.enum(['inventory', 'equipment', 'shop', 'list']).optional().describe('open 用：背包 / 装备 / 商店 / 清单'),
      who: z.string().max(30).optional().describe('open 装备面板用：这是谁的'),
      currency: z.string().max(20).optional().describe('open 商店用：哪个状态键当钱'),
      into: z.string().max(20).optional().describe('open 商店用：买到的进哪个面板'),
      items: z.array(z.object({ name: z.string().min(1).max(40), qty: z.number().int().min(0).max(9999).optional(), note: z.string().max(120).optional(), price: z.number().min(0).optional(), slot: z.string().max(12).optional() })).max(40).optional().describe('open 用：一开始就摆着的东西'),
      item: z.string().max(40).optional().describe('条目名（clear 不用）'),
      qty: z.number().int().min(0).max(9999).optional().describe('数量：add 默认 1；remove 不给就整条拿掉；set 是改成这个数'),
      note: z.string().max(120).optional().describe('一句备注（来历 / 效果）'),
      price: z.number().min(0).optional().describe('商店条目的价'),
      slot: z.string().max(12).optional().describe('装备槽位：头 / 身 / 手 / 脚 / 饰品…（equip 用）'),
      tags: z.array(z.string().max(12)).max(6).optional(),
    },
    async (args) => {
      const r = await ctx.onPanel?.(args);
      if (!r) return { content: [{ type: 'text', text: '这个故事没开面板功能。' }], isError: true };
      if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
      return { content: [{ type: 'text', text: `记下了：${r.change}。${r.digest ? `现在：${r.digest}` : ''}` }] };
    },
  );

  // ⛔ 全部常驻（_meta alwaysLoad）：env 里带着 ENABLE_TOOL_SEARCH 时 MCP 工具默认延迟加载，
  // 模型看不见 write_scene，而提示词又叫它"不用 ToolSearch 去找别的"（09-05 真栽）。
  const always = (t) => ({ ...t, _meta: { ...(t._meta || {}), 'anthropic/alwaysLoad': true } });
  // write_scene 一返回这一轮就结束（SDK 的 _meta['claude/endTurn']）：模型再想在工具之外说一句"这一段写好了"也没机会 ——
  // 09-05/06 两天的转录里每一轮都有这么一句，提示词禁不住，端口关掉最省事。remember / roll 要在 write_scene 之前调。
  const endTurn = (t) => ({ ...t, _meta: { ...(t._meta || {}), 'claude/endTurn': true } });
  return createSdkMcpServer({ name: 'stage', version: '1.2.0', tools: [endTurn(writeScene), remember, forget, rollDice, updatePanel].map(always) });
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
    `# 这个故事记住的事\n\n一行一条，正文在各自的文件里，要用再 Read。\n\n${rows.join('\n')}\n`, 'utf8');
  return rows.length;
}

/**
 * 用户那一侧也落在流上：显示器要画"你"的那一栏。
 * uuid 是这句话在 SDK 转录里的 uuid（回退 / 分叉按它切转录）；by 可换成 'system'（开场那一行是机器发的）。
 */
export async function appendUserLine(playAbs, text, { rel = MAIN_SCENES_REL, uuid = null, by = 'user', extra = {} } = {}) {
  return appendSceneRow(playAbs, { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by, text, ...(uuid ? { uuid } : {}), ...extra }, rel);
}

/** 开始时把索引整份接回系统提示词（正文不贴，让它按需 Read）。 */
export async function readMemoryIndex(playAbs) {
  try { return await fs.readFile(path.join(playAbs, MEMORY_DIR, MEM_INDEX), 'utf8'); } catch { return null; }
}
/** 这个故事记忆的清单（显示器的记忆页） */
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
export async function readScenes(playAbs, { limit = 300, rel = MAIN_SCENES_REL } = {}) {
  try {
    const raw = await fs.readFile(path.join(playAbs, rel), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}
