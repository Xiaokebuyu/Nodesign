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
const PROGRESS = 'progress.md';      // 存档：剧情进度与角色记忆

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

  const saveProgress = tool(
    'save_progress',
    '在剧情关键点存档：进度推到哪了、谁对玩家改观了、埋了什么伏笔。'
    + '整份覆盖写，所以要把还有效的旧内容一起带上。别每拍都存，'
    + '**只在真的发生了不可逆的事情时存**（关系变了、地点变了、伏笔埋下或收回）。',
    {
      content: z.string().min(1).max(20000).describe('整份进度的 markdown 全文'),
      note: z.string().max(80).optional().describe('这次为什么存，一句话'),
    },
    async ({ content, note }) => {
      const p = path.join(dir, STAGE_DIR, PROGRESS);
      await fs.mkdir(path.dirname(p), { recursive: true });
      const head = `<!-- 存于 ${new Date().toISOString()}${note ? ` · ${note}` : ''} -->\n`;
      await fs.writeFile(p, head + content, 'utf8');
      return { content: [{ type: 'text', text: `存档已更新（${content.length} 字）。下次开戏这份会进你的系统提示词。` }] };
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

  return createSdkMcpServer({ name: 'stage', version: '1.0.0', tools: [writeScene, saveProgress, rollDice] });
}

/** 显示器那边读这两份；开戏时也用它把上次的存档接回系统提示词。 */
export async function readProgress(dir) {
  try { return await fs.readFile(path.join(dir, STAGE_DIR, PROGRESS), 'utf8'); } catch { return null; }
}
export async function readScenes(dir, { limit = 200 } = {}) {
  try {
    const raw = await fs.readFile(path.join(dir, STAGE_DIR, SCENES), 'utf8');
    const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  } catch { return []; }
}
