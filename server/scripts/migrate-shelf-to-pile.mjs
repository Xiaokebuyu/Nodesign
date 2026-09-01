#!/usr/bin/env node
/**
 * server/scripts/migrate-shelf-to-pile.mjs（2026-09-01 叠纸，一次性但幂等）
 *
 * 背景：暂存架从竖列改成**一摞**（站主拍板「暂存架我们干脆也就改成栈吧」）。
 * 新代码起，架上的货全部叠在架原点上，屏幕上一次只画最上面那件、上下翻找。
 * 存量的架还按老规矩码着：08-31 折列之前是一根不封口的柱子（真案 proj_mtg61or1
 * 26 件码到 8322px、板高才 2600），之后是一列一屏高往左折。
 *
 * ⛔⛔ **这一发必须跟部署同时走，不能提前跑**。线上跑的还是不会藏页的旧前端时
 * 就把坐标改掉，用户看到的是一堆卡片叠成一坨 —— 比现在难看得多。
 *
 * 判据（只碰机器自己码上去的）：
 *   `seat === 'shelf'` 且在**根层**（layerOf 判，跟渲染同一套）。
 *   seat 是「谁摆的」的单一真相源：pin_to_board / edit_board move / 用户拖拽
 *   任何一只手一挪它就被改写。所以按定义，seat:'shelf' 的东西没有任何一只手
 *   碰过，重排它不覆盖任何人的摆位。
 *
 * ⚠️ 只改 x/y，别的字段一个不动。board.json 先备份 `.bak-0901`。
 *
 * 用法：node server/scripts/migrate-shelf-to-pile.mjs [--apply]
 *       不带 --apply 是干跑，只打印会改什么。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const ROOT = process.env.PROJECTS_DATA_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'projects-data');

/** layerOf 的等价判据（不 import 服务端模块：这脚本要能在没起服务的盒子上跑） */
function layerOf(id, e, known) {
  if (typeof e.zone === 'string') return e.zone;
  const parts = String(id).split('/');
  let best = '';
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts.slice(0, i).join('/');
    if (known.has(p)) best = p;
  }
  return best;
}

const files = execSync(`find ${JSON.stringify(ROOT)} -maxdepth 3 -name board.json`)
  .toString().trim().split('\n').filter(Boolean);

let boards = 0; let moved = 0; let skipped = 0;
for (const f of files) {
  let b;
  try { b = JSON.parse(await fs.readFile(f, 'utf8')); } catch { continue; }
  const shelf = b.shelf;
  if (!shelf || !Number.isFinite(shelf.x) || !Number.isFinite(shelf.y)) continue;
  const known = new Set(Object.keys(b.zones || {}));
  const ids = Object.entries(b.objects || {})
    .filter(([id, e]) => e?.seat === 'shelf' && Number.isFinite(e?.x) && layerOf(id, e, known) === '')
    .map(([id]) => id);
  const off = ids.filter((id) => b.objects[id].x !== shelf.x || b.objects[id].y !== shelf.y);
  if (!off.length) { skipped += ids.length ? 1 : 0; continue; }
  boards += 1; moved += off.length;
  const pid = f.split('/').slice(-3)[0];
  const xs = ids.map((id) => b.objects[id].x); const ys = ids.map((id) => b.objects[id].y);
  console.log(`${pid}: 架上根层 ${ids.length} 件，${off.length} 件要归位`
    + `　包络 ${Math.max(...xs) - Math.min(...xs)}x${Math.max(...ys) - Math.min(...ys)}`
    + ` → 全部叠到 (${shelf.x},${shelf.y})`);
  if (!APPLY) continue;
  await fs.copyFile(f, `${f}.bak-0901`);
  for (const id of off) b.objects[id] = { ...b.objects[id], x: shelf.x, y: shelf.y };
  await fs.writeFile(f, JSON.stringify(b, null, 2), 'utf8');
}
console.log(`\n${APPLY ? '已归位' : '干跑'}：${boards} 块板 / ${moved} 件`
  + `${skipped ? `（另有 ${skipped} 块板的架本来就是一摞，没动）` : ''}`);
if (!APPLY) console.log('加 --apply 才真写。⛔ 记得跟前端部署同时走 —— 旧前端不会藏页。');
