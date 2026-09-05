/**
 * mcp/tools/stage-backdrop.js —— stage_backdrop：主循环给故事显示器挂背景图（2026-09-06）
 *
 * 09-06 真案（问题库 friction）：用户说"来张背景插图""先放上看看"，agent 用 generate_image 出了图，
 * 然后发现**没有任何受支持的路**把图挂进显示器，只能猜字段名往 戏.json 里塞。这件就是那条路：
 *   - fixed：把这张图设成当前背景（显示器立刻换，用户在「状态」页也能换回"跟着场景走"）
 *   - scene：登记成某个地点的背景，机器换场到那儿时自动铺（键跟自动生图同一套 normalizeScene）
 *   - clear：撤掉手选的背景，回到跟着场景走
 * 图会复制进 <故事>/场景/背景/，原件留在原处。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ensurePlays, patchStageConfig, runtimeOf } from '../../stage/manager.js';
import { sceneKey, fileUrl } from '../../stage/mechanics.js';
import { SCENES_DIR, BACKDROPS_DIR, readPlayConfig, writePlayConfig } from '../../stage/play.js';
import { getWorkspaceRoot } from '../../../projects/workspace.js';

export function makeStageBackdropTool({ projectId }) {
  return tool(
    'stage_backdrop',
    `Put an image behind the story display (the reader's backdrop), or clear it.
Give a workspace-relative image path (e.g. what generate_image returned: assets/generated/gen-…-bg.png;
prefer the PNG master, the display dims it anyway). mode "fixed" makes it the current backdrop right away;
"scene" registers it for a place (\`scene\`, e.g. "河边台阶 · 傍晚") so the machine shows it whenever the
story moves there; "clear" removes the fixed backdrop and goes back to following scenes.
The machine also generates backdrops itself when the place changes (from the 地点/时间 state values or
write_scene's scene field); this tool is for when the user wants a specific picture.`,
    {
      image: z.string().max(400).optional().describe('工作区相对路径的图（png / jpg / webp）。mode=clear 时不用'),
      mode: z.enum(['fixed', 'scene', 'clear']).default('fixed'),
      scene: z.string().max(80).optional().describe('mode=scene 时：这是哪个地方（加个时段更好，比如 "教室 · 清晨"）'),
      title: z.string().max(60).optional().describe('故事的文件夹名，项目里只有一个时可不传'),
    },
    async ({ image, mode, scene, title }) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!projectId) return fail('没有项目上下文。');
      const plays = await ensurePlays(projectId);
      if (!plays.length) return fail('这个项目还没有故事。');
      const root = title && plays.includes(title) ? title : (plays.length === 1 ? plays[0] : null);
      if (!root) return fail(`有 ${plays.length} 个故事，指一下 title：${plays.join(' / ')}`);
      if (mode === 'clear') {
        await patchStageConfig(projectId, root, { backdrop: null });
        return { content: [{ type: 'text', text: '撤掉手选的背景了，显示器回到跟着场景走。' }] };
      }
      const ws = getWorkspaceRoot(projectId);
      const clean = String(image || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!clean || clean.includes('..') || !/\.(png|jpe?g|webp)$/i.test(clean)) return fail('image 要是工作区里的 png / jpg / webp 路径。');
      const src = path.join(ws, clean);
      try { await fs.access(src); } catch { return fail(`找不到 ${clean}。generate_image 返回的路径是相对工作区的，原样传进来。`); }
      const rt = runtimeOf(projectId, root);
      const destDir = path.join(rt.playAbs, SCENES_DIR, BACKDROPS_DIR);
      await fs.mkdir(destDir, { recursive: true });
      const name = `${mode === 'scene' ? `stage-bg-${sceneKey(scene || clean)}` : `pick-${Date.now().toString(36)}`}${path.extname(clean).toLowerCase()}`;
      await fs.copyFile(src, path.join(destDir, name));
      const rel = `${root}/${SCENES_DIR}/${BACKDROPS_DIR}/${name}`;
      if (mode === 'scene') {
        if (!scene) return fail('mode=scene 要给 scene（这是哪个地方）。');
        const cfg = (await readPlayConfig(rt.playAbs)) || {};
        cfg.backdrops = { ...(cfg.backdrops || {}), [sceneKey(scene)]: rel };
        await writePlayConfig(rt.playAbs, cfg);
        rt.broadcast({ type: 'backdrop', scene, file: fileUrl(projectId, rel) });
        return { content: [{ type: 'text', text: `登记好了：故事走到「${scene}」时铺这张（${rel}）。现在的场景要是就是它，显示器已经换上。` }] };
      }
      await patchStageConfig(projectId, root, { backdrop: rel });
      return { content: [{ type: 'text', text: `挂上了：显示器现在的背景是 ${rel}。用户在「状态」页点「跟着场景走」能撤掉；要机器换场时自动换，用 mode=scene 按地点登记。` }] };
    },
  );
}
