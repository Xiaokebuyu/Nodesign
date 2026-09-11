/**
 * 新手示例项目（2026-09-12，站主定）。
 *
 * 新用户第一次打开首页时，自动收到一份**做好的项目**的副本：雾岭咖啡的画布、站点、
 * 演示稿、品牌手册、产品图、板书和关系线都在里面。起因是 09-08 的流失分析：注册后
 * 一个字都没输的占 43%，而首轮拿到产物的人回访率是没拿到的两倍多。先让他看见成品
 * 长什么样，比让他对着空画布想第一句话容易。
 *
 * ## 模板从哪来
 *
 * `server/onboarding/sample/`，由 `server/scripts/build-sample-project.mjs` 从真实项目
 * 清出来（会话痕迹、9MB 原图、指向空文件的卡都在那一步处理掉）。⛔ 别手工往那个目录
 * 里放东西：脚本每次重跑都整个重建。
 *
 * ## 只放一次，而且不碰老用户
 *
 * `onboarding` 表一人一行。**先抢座再铺**：首页连刷两下会同时打进来两个请求，
 * 先 INSERT OR IGNORE 占住行，抢不到的那个直接返回。铺失败就把行删掉，下次还能再试。
 * 已经有项目的人（老用户、或者自己先建了项目的）只记一行「不用给了」，不塞东西。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../engine/runs/store.js';
import { createProject } from '../projects/store.js';
import { ensureProjectWorkspace, getWorkspaceRoot } from '../projects/workspace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 模板目录（随 npm 包和桌面安装包一起发） */
export const SAMPLE_DIR = path.join(HERE, 'sample');
export const SAMPLE_NAME = '雾岭咖啡 MISTRIDGE';
export const SAMPLE_DESC = '示例项目 · 一句话做出来的站点、发布演示稿、品牌手册与产品图';

/** 本地版没有登录，owner 恒为 '_anon'；给个固定键，别让 null 当主键 */
const LOCAL_KEY = '_local';

db.exec(`
  CREATE TABLE IF NOT EXISTS onboarding (
    user_id    TEXT PRIMARY KEY,
    project_id TEXT,
    seeded_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const keyOf = (userId) => userId || LOCAL_KEY;

/** 这个人收到过示例了吗（收到过 / 判过不用给，都算） */
export function sampleState(userId) {
  const row = db.prepare('SELECT project_id, seeded_at FROM onboarding WHERE user_id = ?').get(keyOf(userId));
  if (!row) return { done: false, projectId: null };
  return { done: true, projectId: row.project_id || null, at: row.seeded_at };
}

function projectCount(userId) {
  // `IS` 而不是 `=`：本地版 owner_id 可能是 NULL，= 对 NULL 永远不成立
  return db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id IS ?').get(userId ?? null).n;
}

/**
 * 给这个人铺一份示例项目。幂等：铺过、判过、或正在铺，都只是返回状态。
 * @returns {Promise<{seeded:boolean, reason:string, projectId:string|null}>}
 */
export async function ensureSampleProject(userId) {
  const key = keyOf(userId);
  const seen = sampleState(userId);
  if (seen.done) return { seeded: false, reason: 'already', projectId: seen.projectId };

  if (projectCount(userId) > 0) {
    // 老用户不塞东西，但记一行，省得每次开首页都来问一遍
    db.prepare('INSERT OR IGNORE INTO onboarding (user_id, project_id) VALUES (?, NULL)').run(key);
    return { seeded: false, reason: 'has-projects', projectId: null };
  }

  const claim = db.prepare('INSERT OR IGNORE INTO onboarding (user_id, project_id) VALUES (?, NULL)').run(key);
  if (!claim.changes) return { seeded: false, reason: 'in-progress', projectId: null };

  try {
    const stat = await fs.stat(path.join(SAMPLE_DIR, 'board.json')).catch(() => null);
    if (!stat) throw new Error(`示例模板不在或不完整：${SAMPLE_DIR}（跑 server/scripts/build-sample-project.mjs）`);
    const project = createProject({
      name: SAMPLE_NAME,
      description: SAMPLE_DESC,
      ownerId: userId ?? null,
      isSample: true,
    });
    // 先立工作区家具（.claude / assets / CLAUDE.md / git），再把模板盖进去
    await ensureProjectWorkspace(project.id);
    await fs.cp(SAMPLE_DIR, getWorkspaceRoot(project.id), { recursive: true, force: true });
    db.prepare('UPDATE onboarding SET project_id = ? WHERE user_id = ?').run(project.id, key);
    return { seeded: true, reason: 'seeded', projectId: project.id };
  } catch (err) {
    // 没铺成就把座位让出来：下次打开首页还能再试一次
    db.prepare('DELETE FROM onboarding WHERE user_id = ?').run(key);
    throw err;
  }
}
