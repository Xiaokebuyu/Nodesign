#!/usr/bin/env node
/**
 * server/scripts/migrate-canvas-model.mjs（2026-09-06，一次性但幂等）
 *
 * 背景：09-06 起 `glm-5.3-flash-rp`（「GLM-5.3-Flash · 演出」）从首页 / 画布的选择器下架，只在演出显示器
 * 的选择器里出现（model-table 里 `select.only: 'stage'`）。画布的 turn 校验跟清单走同一个 scope，
 * 所以**画布上钉着这行的老会话会被 403**（"这个会话指向的模型现在不可用"）。
 *
 * 会话钉子在文件里不在库里：`<工作区>/.nd/<sid>/session-config.json` 的 `model` 字段
 * （见 engine/agent/session-model.js）。这个脚本把钉着旧行的会话改钉到 `glm-5.3-flash-merge`——
 * **同一个模型的另一条线**（对话中途不换性格，只是厂商从 particle 换回 zai，那一轮缓存冷一次）。
 * ⛔ 不能清空钉子：清了会落到 NODESIGN_MODEL 的订阅行，basic 用户照样 403（08-30 zai 下架时的同一课）。
 *
 * 只动画布会话的 session-config.json；演出那边的 `戏.json` **一个字不碰**（演出面本来就还能选这行）。
 *
 * 用法：
 *   node server/scripts/migrate-canvas-model.mjs            # 只报，不写
 *   node server/scripts/migrate-canvas-model.mjs --apply    # 真写
 * 数据目录从 PROJECTS_DATA_DIR 取（跟服务端同一个 .env：`node --env-file=.env …`），没配就用 ./server/projects-data。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const FROM = 'glm-5.3-flash-rp';
const TO = 'glm-5.3-flash-merge';
const apply = process.argv.includes('--apply');
const root = path.resolve(process.env.PROJECTS_DATA_DIR || './server/projects-data');

async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; yield* walk(p); }
    else if (e.name === 'session-config.json' && path.basename(path.dirname(path.dirname(p))) === '.nd') yield p;
  }
}

let seen = 0, hit = 0, written = 0;
for await (const file of walk(root)) {
  seen++;
  let cfg;
  try { cfg = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
  if (cfg?.model !== FROM) continue;
  hit++;
  console.log(`${apply ? '改' : '会改'} ${path.relative(root, file)}  ${FROM} → ${TO}`);
  if (!apply) continue;
  const next = { ...cfg, model: TO, updatedAt: new Date().toISOString(), migratedFrom: FROM };
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n');
  written++;
}
console.log(`扫了 ${seen} 个会话配置，钉着 ${FROM} 的 ${hit} 个${apply ? `，已改 ${written} 个` : '（加 --apply 才写）'}；数据目录 ${root}`);
