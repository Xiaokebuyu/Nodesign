import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// 隔离数据目录（服务端测试纪律：别碰真库真工作区）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-onboard-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'projects-data');
process.env.DB_PATH = path.join(tmp, 'test.db');

const { ensureSampleProject, sampleState, SAMPLE_DIR } = await import('./seed.js');
const { createProject, getProject, listProjects } = await import('../projects/store.js');
const { getWorkspaceRoot } = await import('../projects/workspace.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exists = (p) => fs.stat(p).then(() => true, () => false);

/**
 * 新手示例项目：只铺一次、不碰老用户、模板必须是干净的。
 *
 * 最后那条（模板体检）是这个文件里最值钱的一条：模板是**盘上的东西**，
 * 谁手工往 server/onboarding/sample/ 里塞一份带会话编号或本机路径的文件，
 * 代码层面一条判据都不会红，而它会被原样复制给每一个新用户。
 */
describe('新用户领到一份示例项目', () => {
  let first;
  beforeAll(async () => { first = await ensureSampleProject('u_alice'); });

  it('第一次：真的铺了，项目标着 isSample', () => {
    expect(first.seeded).toBe(true);
    const p = getProject(first.projectId);
    expect(p.isSample).toBe(true);
    expect(p.ownerId).toBe('u_alice');
  });

  it('画布和产物都落到了工作区里', async () => {
    const root = getWorkspaceRoot(first.projectId);
    expect(await exists(path.join(root, 'board.json'))).toBe(true);
    expect(await exists(path.join(root, 'mistridge-site/index.html'))).toBe(true);
    expect(await exists(path.join(root, '品牌手册/雾岭品牌手册.docx'))).toBe(true);
    // 工作区家具是 ensureProjectWorkspace 建的，模板不带，盖完之后两样都在
    expect(await exists(path.join(root, '.claude'))).toBe(true);
  });

  it('⭐ 画布上没有指向空文件的卡（示例里出现坏卡，新人第一眼看到的就是它）', async () => {
    const root = getWorkspaceRoot(first.projectId);
    const board = JSON.parse(await fs.readFile(path.join(root, 'board.json'), 'utf8'));
    for (const id of Object.keys(board.objects)) {
      if (/^[a-z]+:/.test(id)) continue;          // 产物卡（site: / docx:）不是盘上的路径
      expect(await exists(path.join(root, id)), `画布上这张卡指向不存在的文件：${id}`).toBe(true);
    }
  });

  it('再问一次不会再铺一份', async () => {
    const again = await ensureSampleProject('u_alice');
    expect(again.seeded).toBe(false);
    expect(again.reason).toBe('already');
    expect(again.projectId).toBe(first.projectId);
    expect(listProjects({ owner: 'u_alice' }).filter((p) => p.isSample).length).toBe(1);
  });

  it('已经有项目的人不塞，但记一笔，省得每次开首页都来问', async () => {
    createProject({ name: '我自己的项目', ownerId: 'u_bob' });
    const r = await ensureSampleProject('u_bob');
    expect(r.seeded).toBe(false);
    expect(r.reason).toBe('has-projects');
    expect(sampleState('u_bob').done).toBe(true);
    expect(listProjects({ owner: 'u_bob' }).some((p) => p.isSample)).toBe(false);
  });

  it('本地版（没有登录、owner 为空）也照铺一份', async () => {
    const r = await ensureSampleProject(null);
    expect(r.seeded).toBe(true);
    expect(getProject(r.projectId).isSample).toBe(true);
  });
});

describe('⛔ 模板体检：会发给每一个新用户的东西', () => {
  it('模板在，而且带着画布', async () => {
    expect(await exists(path.join(SAMPLE_DIR, 'board.json')), `模板不在 ${SAMPLE_DIR}，跑 server/scripts/build-sample-project.mjs`).toBe(true);
  });

  it('没有会话痕迹 / 本机路径 / 用户 id / 邮箱', async () => {
    const bad = [];
    const walk = async (dir, rel = '') => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { await walk(p, r); continue; }
        if (!/\.(md|json|html|css|js|txt)$/i.test(e.name)) continue;
        const text = await fs.readFile(p, 'utf8');
        for (const [re, what] of [
          [/^[ \t]*(?:session|originSessionId):[ \t]*\S+/im, '会话编号'],
          [/\/home\/[a-z0-9_-]+/i, '本机绝对路径'],
          [/u_[a-z0-9]{8}_[a-z0-9]{5}/i, '用户 id'],
          [/[\w.+-]+@(?!mistridge\.coffee)[\w-]+\.[\w.]+/, '邮箱'],
        ]) {
          const m = text.match(re);
          if (m) bad.push(`${r}: ${what} → ${m[0].slice(0, 50)}`);
        }
      }
    };
    await walk(SAMPLE_DIR);
    expect(bad, `模板里有不该发给别人的东西：\n${bad.join('\n')}`).toEqual([]);
  });

  it('别把原图塞进安装包：模板整体不超过 4MB', async () => {
    let total = 0;
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else total += (await fs.stat(p)).size;
      }
    };
    await walk(SAMPLE_DIR);
    expect(Math.round(total / 1024 / 1024 * 100) / 100).toBeLessThan(4);
  });

  it('模板目录跟生成脚本在同一个仓库位置上（脚本改了输出路径这条会红）', async () => {
    const src = await fs.readFile(path.join(HERE, '../scripts/build-sample-project.mjs'), 'utf8');
    expect(src).toContain("server/onboarding/sample");
  });
});
