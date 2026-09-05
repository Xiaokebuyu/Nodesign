/**
 * kinds/stage.js — 演出形态（RP 显示器，2026-09-05；当晚改成"一个故事一个文件夹"）
 *
 * 一个故事在磁盘上就是工作区根下的一个文件夹（布局见 engine/stage/play.js）：
 *   <故事>/戏.json 台面.md 规则.json 角色/ 记忆/ 场景/scenes.jsonl 世界书/ 预设/ 素材/
 * 有 `戏.json` 或 `台面.md` 的文件夹就是一个故事。
 *
 * 它是第四种一等产物，跟站点走同一条路（画布上一张卡、双击开最大化窗），差别在：
 *   - **不是 html 文件**，所以既不 browsable 也不 renderable。显示器是服务端一条路由
 *     （api/stage.js 的 /stage/<故事>/view）现渲染的页面，感知工具按能力位问、问不到它。
 *   - **目录型**（卡即文件夹）：整个文件夹被产物认领，里面的卡 / 世界书 / jsonl 不当散文件上墙 ——
 *     它们都在显示器里看和改。
 *   - 没有导出格式。要留档就是文件夹本身（一个文件夹 = 一份能整个搬走的存档）。
 *
 * 实例发现跟站点同款：任务目录本身是戏 → root ''；否则一级子目录里是戏的各算一个实例
 * （从父目录的视角认领它，assets.js 的 collect 才不会再把它当文件夹递归）。
 * 老形状 `stage/stage.json`（09-05 下午那版）还认，标 legacy，manager 开始时迁移。
 *
 * 入口文件取 scenes.jsonl 而不是 戏.json：ENTRY_FILE 的扩展名会进 artifact-target 的
 * ENTRY_EXTS，`.json` 进去会让 agent 随手写的任何 json 都被记成"当前产物"。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  PLAY_CONFIG, SCENES_DIR, SCENES_FILE, LEGACY_DIR, isPlayDir, readPlayConfig, exists, currentLine, sceneFileOf,
} from '../../engine/stage/play.js';

export { PLAY_CONFIG, SCENES_FILE };

async function countScenes(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { if (JSON.parse(line).by === 'stage') n += 1; } catch { /* 半行 */ }
    }
    return n;
  } catch { return 0; }
}

async function discoverInstances(taskDir) {
  if (await isPlayDir(taskDir)) return [{ root: '' }];
  const out = [];
  let entries = [];
  try { entries = await fs.readdir(taskDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name === LEGACY_DIR) {
      if (await exists(path.join(taskDir, LEGACY_DIR, 'stage.json'))) out.push({ root: LEGACY_DIR, legacy: true });
      continue;
    }
    if (await isPlayDir(path.join(taskDir, e.name))) out.push({ root: e.name });
  }
  return out;
}

export default {
  id: 'stage',
  capabilities: [],          // 不是 html、不是二进制包：显示器是服务端路由现渲染的，感知工具不该问到它
  entryFile: SCENES_FILE,
  view: 'stage',
  injectFit: false,
  exportFormats: [],
  referenceDoc: null,
  directory: () => true,     // 卡即文件夹：整个故事的文件夹整段认领
  discoverInstances,

  async artifactRoot(taskDir) {
    const inst = await discoverInstances(taskDir);
    return inst[0]?.root || '';
  },

  async instanceManifest(taskDir, _marker, inst) {
    const root = inst.root || '';
    const playAbs = root ? path.join(taskDir, root) : taskDir;
    let cfg = null;
    if (inst.legacy) { try { cfg = JSON.parse(await fs.readFile(path.join(playAbs, 'stage.json'), 'utf8')); } catch { cfg = null; } }
    else cfg = await readPlayConfig(playAbs);
    // 段数按当前线路的记录数（分支各有各的文件）；入口文件名固定是主线的，别让 ENTRY_FILE 跟着线路漂
    const scenesRel = inst.legacy ? 'scenes.jsonl' : `${SCENES_DIR}/${SCENES_FILE}`;
    const countRel = inst.legacy ? scenesRel : sceneFileOf(currentLine(cfg || {}).id);
    const fallbackTitle = root ? path.basename(root) : path.basename(taskDir);
    return {
      kind: 'stage',
      root,
      srcRoot: root,
      entry: scenesRel,
      entryRel: root ? `${root}/${scenesRel}` : scenesRel,
      file: null,
      pages: [],
      single: false,
      title: (cfg?.title && String(cfg.title).trim()) || fallbackTitle || '演出',
      // 卡面要的那几样（systemPrompt / 规则不进清单 —— 清单接口每次都拉）
      stage: {
        cast: Array.isArray(cfg?.cast) ? cfg.cast.map(c => ({ name: c.name, note: c.note || '' })) : [],
        skin: cfg?.skin || 'paper',
        beats: await countScenes(path.join(playAbs, countRel)),
        startedAt: cfg?.startedAt || null,
        legacy: !!inst.legacy,
      },
    };
  },

  async describe(_taskDir, artifact) {
    const n = artifact.stage?.beats || 0;
    const who = (artifact.stage?.cast || []).map(c => c.name).slice(0, 4).join(' / ');
    return `故事「${artifact.title}」（文件夹 ${artifact.root || '.'}/）· ${n} 段${who ? ` · 在场：${who}` : ''}（台上的字由演出进程写，用户直接对它说话，不经过你）`;
  },
};
