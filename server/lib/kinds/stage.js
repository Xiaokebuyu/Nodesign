/**
 * kinds/stage.js — 演出形态（RP 显示器，2026-09-05）
 *
 * 一场戏在磁盘上就是任务目录下的 `stage/`：
 *   stage/stage.json      开戏时定下的东西（标题、在场者、状态面板、皮肤、系统提示词）
 *   stage/scenes.jsonl    一拍一行，显示器顺着读（engine/stage/tools.js 的 write_scene 写）
 *   stage/memory/*.md     演出进程自己的记忆（一事一文件 + INDEX.md）
 *
 * 它是第四种一等产物，跟站点走同一条路（画布上一张卡、双击开最大化窗），差别在：
 *   - **不是 html 文件**，所以既不 browsable 也不 renderable。显示器是服务端一条
 *     路由（api/stage.js 的 /stage/view）现渲染的页面，感知工具（截图 / 读页）
 *     按能力位问、问不到它，正好 —— 台上的字不是给 agent 截图用的。
 *   - **目录型**（卡即文件夹）：stage/ 整段被产物认领，里面的 jsonl / md 不当散文件上墙。
 *   - 没有导出格式。要留档就是文件夹本身。
 *
 * 入口文件取 scenes.jsonl 而不是 stage.json：ENTRY_FILE 的扩展名会进
 * artifact-target 的 ENTRY_EXTS（「写了这种文件 = 在做这份产物」的判据），
 * `.json` 进去会让 agent 随手写的任何 json 都被记成"当前产物"。`.jsonl` 全仓只有这一处。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

export const STAGE_DIR = 'stage';
export const STAGE_CONFIG = 'stage.json';
export const STAGE_SCENES = 'scenes.jsonl';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** stage.json 的正文（读不动 / 没有 → null；坏 JSON 也 null，别让一份坏配置弄死整份清单） */
export async function readStageConfig(taskDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(taskDir, STAGE_DIR, STAGE_CONFIG), 'utf8'));
  } catch { return null; }
}

async function countScenes(taskDir) {
  try {
    const raw = await fs.readFile(path.join(taskDir, STAGE_DIR, STAGE_SCENES), 'utf8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { if (JSON.parse(line).by === 'stage') n += 1; } catch { /* 半行 */ }
    }
    return n;
  } catch { return 0; }
}

/**
 * 实例发现：任务目录下有 stage/stage.json 或 stage/scenes.jsonl 就是一场戏。
 * 一个任务目录最多一场（stage/ 是固定名字）；要并排两场就开两个文件夹。
 */
async function discoverInstances(taskDir) {
  const dir = path.join(taskDir, STAGE_DIR);
  if (await exists(path.join(dir, STAGE_CONFIG)) || await exists(path.join(dir, STAGE_SCENES))) {
    return [{ root: STAGE_DIR }];
  }
  return [];
}

export default {
  id: 'stage',
  capabilities: [],          // 不是 html、不是二进制包：显示器是服务端路由现渲染的，感知工具不该问到它
  entryFile: STAGE_SCENES,
  view: 'stage',
  injectFit: false,
  exportFormats: [],
  referenceDoc: null,
  directory: () => true,     // 卡即文件夹：stage/ 整段认领
  discoverInstances,

  async artifactRoot() { return STAGE_DIR; },

  async instanceManifest(taskDir) {
    const cfg = await readStageConfig(taskDir);
    return {
      kind: 'stage',
      root: STAGE_DIR,
      srcRoot: STAGE_DIR,
      entry: STAGE_SCENES,
      entryRel: `${STAGE_DIR}/${STAGE_SCENES}`,
      file: null,
      pages: [],
      single: false,
      title: (cfg?.title && String(cfg.title).trim()) || '演出',
      // 卡面要的那几样（不带 systemPrompt —— 那是演出进程的冻结区，几 KB，清单接口每次都拉）
      stage: {
        cast: Array.isArray(cfg?.cast) ? cfg.cast.map(c => ({ name: c.name, note: c.note || '' })) : [],
        skin: cfg?.skin || 'paper',
        beats: await countScenes(taskDir),
        startedAt: cfg?.startedAt || null,
      },
    };
  },

  async describe(_taskDir, artifact) {
    const n = artifact.stage?.beats || 0;
    const who = (artifact.stage?.cast || []).map(c => c.name).slice(0, 4).join(' / ');
    return `演出「${artifact.title}」 · ${n} 拍${who ? ` · 在场：${who}` : ''}（台上的字由演出进程写，用户直接对它说话，不经过你）`;
  },
};
