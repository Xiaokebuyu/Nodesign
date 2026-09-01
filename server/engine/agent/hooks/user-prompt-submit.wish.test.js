/**
 * 状态块转述「用户对版面表过的态」（2026-09-01 叠纸刀 7，站主拍板）。
 *
 * 两个动作是有信息量的：他手动改了缩放、他把板书拖成某个宽度。后者从 08-28 起就在
 * 学（learnedChalkWidth，判据是前端拖手柄盖的 sized:'user' 章，模型盖不出），但它
 * 只影响下一条板书的宽度，够不着纸；前者一直有人报（viewpoint.zoom）却没有任何人
 * 读它来定版面。这一刀把这两条接到纸的尺寸上。
 *
 * ⚠️ 判据有两半，缺一不可：
 *   ① 真有信号才说 —— 状态块每回合都进上下文，没信号还占字就是纯噪音
 *   ② 说的是「问一句」不是「照做」—— 缩放调小可能只是想看全貌，不一定是要更大的纸
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-ups-wish-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { makeUserPromptSubmitHandler } = await import('./user-prompt-submit.js');
const { resetTurnMemory } = await import('./turn-state-memory.js');
const { patchBoard } = await import('../../../projects/board-store.js');
const { ensureProjectWorkspace, getSharedDir } = await import('../../../projects/workspace.js');
const { setViewpoint } = await import('../../../projects/viewpoint-store.js');

const DESKTOP = { class: 'desktop', w: 1600, h: 950, coarse: false };

async function block(pid, { zoom, chalkW = null }) {
  await ensureProjectWorkspace(pid);
  setViewpoint(pid, { camera: { x: 0, y: 0, w: 2133, h: 1267 }, zoom, device: DESKTOP });
  if (chalkW) {
    await patchBoard(pid, {
      objects: { 'notes/板书/20260901-000000-a.md': { x: 0, y: 0, w: chalkW, h: 200, sized: 'user' } },
    });
  }
  const sid = `wish-${pid}-${Date.now()}`;
  resetTurnMemory(sid);
  const h = makeUserPromptSubmitHandler({ workspaceRoot: getSharedDir(pid), sessionId: sid, projectId: pid });
  return (await h({ prompt: 'hi' }, 't', {})).hookSpecificOutput.additionalContext;
}

describe('状态块：用户对版面表过的态', () => {
  it('⭐ 他没动过缩放、也没拖过板书 → 一个字不说（状态块每回合都占上下文）', async () => {
    const r = await block('proj_wish_quiet', { zoom: 0.75 });
    expect(r).not.toMatch(/对版面表的态/);
  });

  it('⭐ 他把缩放调开了 → 报出来，并且说的是「问一句再动」', async () => {
    const r = await block('proj_wish_zoom', { zoom: 0.4 });
    expect(r).toMatch(/他把缩放调到了 0\.40/);
    expect(r).toMatch(/这台机器的基准是 0\.75/);
    expect(r).toMatch(/问一句再动/);
    expect(r).toMatch(/open_sheet\{w,h\}/);
  });

  it('⭐ 他把板书拖宽过 → 报那个宽度（判据是 sized:user，模型盖不出这个章）', async () => {
    const r = await block('proj_wish_chalk', { zoom: 0.75, chalkW: 600 });
    expect(r).toMatch(/他把板书拖到过 600px 宽/);
    expect(r).toMatch(/问一句再动/);
  });

  it('缩放只差一点（基准 ±15% 内）不算表态 —— 那是手滑不是意见', async () => {
    const r = await block('proj_wish_tiny', { zoom: 0.8 });
    expect(r).not.toMatch(/对版面表的态/);
  });
});
