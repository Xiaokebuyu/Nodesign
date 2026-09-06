#!/usr/bin/env node
/**
 * server/scripts/migrate-publish-keys.mjs（2026-08-18，一次性但幂等）
 *
 * 背景：`published_sites.task` 以前是调用方随手传的自由文本，既不参与寻址也没有
 * 校验。2026-08-17 有两次发布把**项目 ID** 填了进去（agent 从每 turn 注入的 cwd
 * 里只看得见 projectId，而当时 schema 描述还写着「任务目录名」），落库落成
 * `task='proj_xxx'`，域名跟着变成 `proj-xxx.share.…`；更麻烦的是界面按**站点根**
 * 去查这张表，查不到 → 显示"未上线" → 用户再点一次就会造出第二个 Pages 项目和
 * 第二个域名。
 *
 * 现在 key 已经收敛到站点根（site-publish.js 里先寻址再定 key），这个脚本把存量
 * 数据搬到同一口径上。
 *
 * ⭐ 只搬 key。`cf_project` 和 `custom_domain` **一个字不改** —— 线上跑着的域名
 *    不因为一次内部改名而变动。想换成好看的 slug 是另一件事，要人拍板。
 *
 * 判据（两条都满足才搬，宁可不搬也不猜）：
 *   1. 当前 task 不是工作区里任何一个站点根
 *   2. 工作区里**恰好只有一个**站点 → 那它就是这行记录说的站
 *
 * 用法：node --env-file=.env server/scripts/migrate-publish-keys.mjs [--apply]
 * 不带 --apply 只报告。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSharedDir } from '../projects/workspace.js';
import { taskManifest } from '../lib/kinds/index.js';

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/nodesign.db');
const db = new DatabaseSync(dbPath, { timeout: 5000 });

const rows = db.prepare('SELECT * FROM published_sites').all();
let moved = 0, skipped = 0;

for (const r of rows) {
  let roots = [];
  try {
    const m = await taskManifest(getSharedDir(r.project_id));
    roots = (m?.artifacts || []).filter(a => a.kind === 'site' && !a.single).map(a => a.root || '.');
  } catch { /* 工作区读不到 → 当没有站点 */ }

  if (roots.includes(r.task)) { skipped++; continue; }          // 已经是站点根
  if (roots.length !== 1) {
    // 0 个：站点文件早被删/改名了，线上那份还挂着 —— key 只能维持原样，
    //       下线走 lookupPublished 的直查照样找得到
    // 2+ 个：搬到哪个是猜，不猜
    console.log(`跳过 ${r.project_id} task="${r.task}"（工作区里有 ${roots.length} 个站点）`);
    skipped++; continue;
  }

  const to = roots[0];
  const clash = db.prepare('SELECT id FROM published_sites WHERE project_id=? AND task=?')
    .get(r.project_id, to);
  if (clash && clash.id !== r.id) {
    console.log(`跳过 ${r.project_id} task="${r.task}" → "${to}"：目标 key 已被 ${clash.id} 占用`);
    skipped++; continue;
  }

  console.log(`${APPLY ? '搬' : '将搬'} ${r.project_id}: task "${r.task}" → "${to}"`
    // custom_domain 列是 08-02 当天 ALTER 加的；从没迁过的库上它可能不存在，
    // 直接打就是一句 `域名=undefined`（读起来像"域名丢了"）
    + `（cf_project=${r.cf_project} 域名=${r.custom_domain ?? '(这个库还没有 custom_domain 列)'} 均不变）`);
  if (APPLY) db.prepare('UPDATE published_sites SET task=? WHERE id=?').run(to, r.id);
  moved++;
}

console.log(`\n${APPLY ? '已搬' : '待搬'} ${moved} 行，跳过 ${skipped} 行。${APPLY ? '' : '加 --apply 真执行。'}`);
