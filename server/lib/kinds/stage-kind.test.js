import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { taskManifest, can, KINDS, formatAllowed, cardIdOf, isDirArtifact } from './index.js';

/**
 * 演出形态（2026-09-05）的判定链。盯的是"加第四种形态最容易漏的那几处"：
 *   1. 能力位：既不 browsable 也不 renderable —— 感知工具、封面截图都不该碰它
 *   2. 目录型：stage/ 整段被认领（否则画布上会多一张同名文件夹卡 + 一堆 jsonl 文件卡）
 *   3. 不参与形态判定的偏好序：站点任务里开一场戏，任务仍然"是"站点
 *   4. 入口扩展名 .jsonl 不跟别人撞（.json 进 ENTRY_EXTS 会让随手写的 json 被记成当前产物）
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

const CFG = JSON.stringify({ title: '教室初遇', cast: [{ name: '晴可', note: '同桌' }], skin: 'jiangnan', systemPrompt: 'x'.repeat(300) });
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
    expect(formatAllowed('stage', 'html')).toBe(false);
  });
  it('入口扩展名不跟 html / docx / json 撞', () => {
    expect(KINDS.stage.entryFile).toMatch(/\.jsonl$/);
    // 前缀表从注册表派生（board-relations.js / board-kind-sizes.js 同款），新形态自动进表
    expect(Object.keys(KINDS).map(id => `${id}:`)).toContain('stage:');
  });
});

describe('实例发现', () => {
  it('stage/stage.json 就是一场戏；标题 / 在场者 / 拍数进清单，systemPrompt 不出门', async () => {
    const d = await mkTask({ 'stage/stage.json': CFG, 'stage/scenes.jsonl': SCENES });
    const m = await taskManifest(d);
    const st = m.artifacts.find(a => a.kind === 'stage');
    expect(st).toBeTruthy();
    expect(st.title).toBe('教室初遇');
    expect(st.root).toBe('stage');
    expect(st.stage.cast).toEqual([{ name: '晴可', note: '同桌' }]);
    expect(st.stage.beats).toBe(2);          // 只数台上写的拍，用户行和骰子不算
    expect(st.stage.skin).toBe('jiangnan');
    expect(JSON.stringify(st)).not.toContain('xxxxxxxx');
    expect(isDirArtifact(st)).toBe(true);
  });

  it('只有 scenes.jsonl、还没写 stage.json 也算（进程先写了拍、配置晚一步）', async () => {
    const d = await mkTask({ 'stage/scenes.jsonl': SCENES });
    const m = await taskManifest(d);
    expect(m.artifacts.some(a => a.kind === 'stage')).toBe(true);
    expect(m.artifacts.find(a => a.kind === 'stage').title).toBe('演出');
  });

  it('空的 stage/ 目录不是戏', async () => {
    const d = await mkTask({ 'stage/.keep': '' });
    expect(await taskManifest(d)).toBeNull();
  });

  it('站点任务里开一场戏：任务仍是站点，戏照样出卡', async () => {
    const d = await mkTask({ 'index.html': '<!doctype html>', 'stage/stage.json': CFG });
    const m = await taskManifest(d);
    expect(m.kind).toBe('site');
    expect(m.artifacts.map(a => a.kind)).toEqual(['site', 'stage']);
  });

  it('卡 id = stage:<任务里那个 stage 文件夹>，根任务是 stage:stage', async () => {
    const d = await mkTask({ 'stage/stage.json': CFG });
    const st = (await taskManifest(d)).artifacts.find(a => a.kind === 'stage');
    expect(cardIdOf('', st)).toBe('stage:stage');
    expect(cardIdOf('剧本A', st)).toBe('stage:剧本A/stage');
  });
});
