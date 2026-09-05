import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { taskManifest, can, KINDS, formatAllowed, cardIdOf, isDirArtifact } from './index.js';

/**
 * 演出形态（2026-09-05；当晚改成一场戏一个文件夹）的判定链。盯的是"加第四种形态最容易漏的那几处"：
 *   1. 能力位：既不 browsable 也不 renderable —— 感知工具、封面截图都不该碰它
 *   2. 目录型：戏的文件夹整段被认领（否则画布上会多一张同名文件夹卡 + 一堆散文件卡）
 *   3. 不参与形态判定的偏好序：站点任务里开一场戏，任务仍然"是"站点
 *   4. 入口扩展名 .jsonl 不跟别人撞（.json 进 ENTRY_EXTS 会让随手写的 json 被记成当前产物）
 *   5. 老形状 stage/stage.json 还认（标 legacy），manager 开戏时迁移
 */

const tmps = [];
async function mkTask(files) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-stagekind-'));
  tmps.push(d);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(d, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  return d;
}
afterAll(async () => { await Promise.all(tmps.map(d => fs.rm(d, { recursive: true, force: true }))); });

const CFG = JSON.stringify({ title: '教室初遇', cast: [{ name: '晴可', note: '同桌' }], skin: 'jiangnan' });
const SCENES = [
  { by: 'stage', text: '晨光。', choices: [{ label: '继续', prompt: '继续' }] },
  { by: 'user', text: '我坐下。' },
  { by: 'stage', text: '她抬头。', choices: [{ label: '打招呼', prompt: '你好' }] },
  { by: 'dice', sides: 20, rolls: [7], total: 7 },
].map(r => JSON.stringify(r)).join('\n') + '\n';

describe('能力位与契约', () => {
  it('演出既不可浏览也不可渲染（显示器是服务端路由现渲染的，不走 artifact-file）', () => {
    expect(Object.keys(KINDS)).toContain('stage');
    expect(can('stage', 'browsable')).toBe(false);
    expect(can('stage', 'renderable')).toBe(false);
  });
  it('没有导出格式', () => {
    expect(KINDS.stage.exportFormats).toEqual([]);
    expect(formatAllowed('stage', 'site')).toBe(false);
  });
  it('入口扩展名不跟 html / docx / json 撞；前缀表从注册表派生', () => {
    expect(KINDS.stage.entryFile).toMatch(/\.jsonl$/);
    expect(Object.keys(KINDS).map(id => `${id}:`)).toContain('stage:');
  });
});

describe('实例发现：一场戏一个文件夹', () => {
  it('工作区根下有 戏.json 的文件夹 = 一场戏；标题 / 在场者 / 拍数进清单', async () => {
    const d = await mkTask({ '晴可同桌/戏.json': CFG, '晴可同桌/场景/scenes.jsonl': SCENES });
    const m = await taskManifest(d);
    const st = m.artifacts.find(a => a.kind === 'stage');
    expect(st).toBeTruthy();
    expect(st.root).toBe('晴可同桌');
    expect(st.entryRel).toBe('晴可同桌/场景/scenes.jsonl');
    expect(st.title).toBe('教室初遇');
    expect(st.stage.cast).toEqual([{ name: '晴可', note: '同桌' }]);
    expect(st.stage.beats).toBe(2);          // 只数台上写的拍
    expect(st.stage.skin).toBe('jiangnan');
    expect(isDirArtifact(st)).toBe(true);
  });

  it('只有台面、还没写 戏.json 也算（open_stage 写台面比写配置早一步）；标题退回文件夹名', async () => {
    const d = await mkTask({ '夜航/台面.md': '## 世界\n海上。' });
    const m = await taskManifest(d);
    const st = m.artifacts.find(a => a.kind === 'stage');
    expect(st.root).toBe('夜航');
    expect(st.title).toBe('夜航');
  });

  it('两场戏并排各自一张卡', async () => {
    const d = await mkTask({ 'A/戏.json': JSON.stringify({ title: 'A' }), 'B/戏.json': JSON.stringify({ title: 'B' }) });
    const m = await taskManifest(d);
    expect(m.artifacts.filter(a => a.kind === 'stage').map(a => a.root).sort()).toEqual(['A', 'B']);
  });

  it('任务目录自己就是戏（进了文件夹再扫）→ root 空串', async () => {
    const d = await mkTask({ '戏.json': CFG });
    const m = await taskManifest(d);
    expect(m.artifacts.find(a => a.kind === 'stage').root).toBe('');
  });

  it('普通文件夹不是戏；空文件夹不是戏', async () => {
    const d = await mkTask({ '稿件/a.md': 'x', '空/.keep': '' });
    expect(await taskManifest(d)).toBeNull();
  });

  it('站点任务里开一场戏：任务仍是站点，戏照样出卡', async () => {
    const d = await mkTask({ 'index.html': '<!doctype html>', '晴可同桌/戏.json': CFG });
    const m = await taskManifest(d);
    expect(m.kind).toBe('site');
    expect(m.artifacts.map(a => a.kind)).toEqual(['site', 'stage']);
  });

  it('老形状 stage/stage.json 还认，标 legacy', async () => {
    const d = await mkTask({ 'stage/stage.json': CFG, 'stage/scenes.jsonl': SCENES });
    const st = (await taskManifest(d)).artifacts.find(a => a.kind === 'stage');
    expect(st.root).toBe('stage');
    expect(st.stage.legacy).toBe(true);
    expect(st.stage.beats).toBe(2);
  });

  it('卡 id = stage:<戏的文件夹>（任务路径拼上去）', async () => {
    const d = await mkTask({ '晴可同桌/戏.json': CFG });
    const st = (await taskManifest(d)).artifacts.find(a => a.kind === 'stage');
    expect(cardIdOf('', st)).toBe('stage:晴可同桌');
    expect(cardIdOf('剧本', st)).toBe('stage:剧本/晴可同桌');
  });
});
