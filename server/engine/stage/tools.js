/**
 * engine/stage/tools.js —— 演出进程的工具面（MCP）。
 *
 * 台上的人只需要四件事：把这一拍写出来、给玩家把手、掷骰、在关键点存档。
 * 内置工具那边只留了 Read/Glob/Grep/Skill（读角色卡和世界书、加载 story-* 技能包），
 * Write 和 Bash 是挡掉的 —— 所以落盘一律走这里，路径由服务端拼，模型给不了绝对路径。
 *
 * ⚠️ 参数名和枚举值一律 ASCII：中文参数名会让 agent 静默结束回合（老账）。
 * 描述和返回正文用中文没问题。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const STAGE_DIR = 'stage';
const SCENES = 'scenes.jsonl';       // 一拍一行，显示器顺着读
const MEM = 'memory';                // 一事一文件，照搬 harness 那套 auto-memory 的形状
const MEM_INDEX = 'INDEX.md';        // 索引：每次开戏进系统提示词，正文按需 Read

/** 选项一枚：label 是按钮上的字，hint 是按钮下那行小字，prompt 是点下去发生什么。 */
const choiceSchema = z.object({
  label: z.string().min(1).max(20).describe('按钮上的字，四到六个字最好'),
  hint: z.string().max(60).optional().describe('按钮下面那行小字，说清楚点下去是要做什么'),
  prompt: z.string().min(1).max(500).describe('玩家点下这枚之后，等于他对你说了这句话'),
});

async function appendScene(dir, row) {
  const p = path.join(dir, STAGE_DIR, SCENES);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(row) + '\n', 'utf8');
  return p;
}

/**
 * @param {object} ctx  dir（项目工作区）/ onScene（写完一拍的回调，用来推给显示器）
 */
export function createStageTools(ctx) {
  const dir = ctx.dir;

  const writeScene = tool(
    'write_scene',
    '把这一拍写到台上。正文是完整的一段戏（环境、动作、所有人的对白都在里面），'
    + '第三人称旁白，对白单独成段。choices 是留给玩家的把手 —— 两到四枚，'
    + '一枚推进主线、一枚人际、一枚合理但意想不到的。**没有把手这一拍就没写完**。',
    {
      text: z.string().min(1).max(8000).describe('这一拍的正文'),
      choices: z.array(choiceSchema).min(1).max(5).describe('留给玩家的把手，两到四枚'),
      scene: z.string().max(60).optional().describe('换场景时给一句地点时间，不换就别传'),
    },
    async ({ text, choices, scene }) => {
      const row = { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), by: 'stage', text, choices, ...(scene ? { scene } : {}) };
      await appendScene(dir, row);
      ctx.onScene?.(row);
      return { content: [{ type: 'text', text: `这一拍已经在台上了（${text.length} 字，${choices.length} 枚把手）。玩家点了哪一枚会当成他的话送回来，停在这里等他。` }] };
    },
  );

  /**
   * 记忆 —— 形状照搬 harness 自己那套 auto-memory：一事一文件、带 frontmatter、
   * 索引常驻正文按需读。**没有走 claude_code preset**：那样确实能白拿 SDK 的
   * recall supervisor，但 2026-09-05 实测它要多付 7,028 token 的地基，还会把
   * Claude Code 整套编码教义（TodoWrite、任务管理、代码规范）搬进演出会话。
   * 写和索引本来就只是提示词约定，自己做就行；召回那层先用"索引全量贴回"顶着 ——
   * 召回会漏，全量不会，等一场戏长到索引都贴不下再说。
   */
  const remember = tool(
    'remember',
    '记住一件事。一件事一份，别把两件事塞进一份。存之前先看索引里有没有已经在写这件事的，'
    + '有就用同一个 name 覆盖它，别新建第二份。'
    + '⛔ 别记这一拍刚发生的流水账 —— 正文本身就在台上，记忆是给**之后还会用到**的东西准备的：'
    + '关系变了、伏笔埋下、世界里确立了一个新事实、玩家做了回不了头的选择。',
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('文件名，小写英文加连字符，比如 qingke-attitude'),
      type: z.enum(['progress', 'character', 'thread', 'world'])
        .describe('progress=演到哪了 / character=某个人的态度与他记得的事 / thread=伏笔 / world=演出中确立的设定'),
      description: z.string().min(1).max(80).describe('一行摘要，进索引，也是之后判断"这条现在用不用得上"的依据'),
      content: z.string().min(1).max(8000).describe('正文 markdown。写事实，别写这一拍的散文'),
    },
    async ({ name, type, description, content }) => {
      const dirAbs = path.join(dir, STAGE_DIR, MEM);
      await fs.mkdir(dirAbs, { recursive: true });
      const head = `---\nname: ${name}\ntype: ${type}\ndescription: ${description.replace(/\n/g, ' ')}\nat: ${new Date().toISOString()}\n---\n\n`;
      await fs.writeFile(path.join(dirAbs, `${name}.md`), head + content, 'utf8');
      const n = await rewriteIndex(dirAbs);
      return { content: [{ type: 'text', text: `记住了：${name}（${type}）。索引现在 ${n} 条，下次开戏整份进你的系统提示词。` }] };
    },
  );

  const forget = tool(
    'forget',
    '删掉一条记错了或者已经作废的记忆。剧情推翻了旧设定时用，别留着两份打架的。',
    { name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe('要删的那份的 name') },
    async ({ name }) => {
      const dirAbs = path.join(dir, STAGE_DIR, MEM);
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
      await appendScene(dir, row);
      ctx.onScene?.(row);
      return { content: [{ type: 'text', text: `d${sides}×${count} = ${rolls.join(', ')}（合计 ${total}）· ${reason}` }] };
    },
  );

  return createSdkMcpServer({ name: 'stage', version: '1.0.0', tools: [writeScene, remember, forget, rollDice] });
}

/**
 * 索引重建 —— 每次写/删之后从磁盘上的文件重扫一遍。
 * ⭐ 不是增量维护：增量的索引会跟正文对不上（改了正文忘了改索引就是第二个真相源），
 * 重扫慢一点但索引永远等于磁盘上真实有的东西。
 */
async function rewriteIndex(dirAbs) {
  const files = (await fs.readdir(dirAbs).catch(() => [])).filter(f => f.endsWith('.md') && f !== MEM_INDEX);
  const rows = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dirAbs, f), 'utf8').catch(() => '');
    const d = /^description:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    const t = /^type:\s*(.+)$/m.exec(raw)?.[1]?.trim() || '';
    rows.push(`- [${f.replace(/\.md$/, '')}](${f})${t ? ` \`${t}\`` : ''} — ${d}`);
  }
  rows.sort();
  await fs.writeFile(path.join(dirAbs, MEM_INDEX),
    `# 这场戏记住的事\n\n一行一条，正文在各自的文件里，要用再 Read。\n\n${rows.join('\n')}\n`, 'utf8');
  return rows.length;
}

/** 开戏时把索引整份接回系统提示词（正文不贴，让它按需 Read）。 */
export async function readMemoryIndex(dir) {
  try { return await fs.readFile(path.join(dir, STAGE_DIR, MEM, MEM_INDEX), 'utf8'); } catch { return null; }
}
export async function readScenes(dir, { limit = 200 } = {}) {
  try {
    const raw = await fs.readFile(path.join(dir, STAGE_DIR, SCENES), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}
