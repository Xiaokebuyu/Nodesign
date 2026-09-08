/**
 * lib/workspace-audit.js —— 工作区一致性对账（2026-09-08 诊断埋点⑬）：board.json 上有座位的东西磁盘上还在不在，
 * 磁盘上的产物有没有一张卡。09-08 那个 Windows 上 toWorkspaceRel 恒定失败的案子，症状是画布长出名叫 `C:` 的
 * 影子文件夹 + agent 写完文件画布不动 —— 两边对一次账当天就能发现。
 *
 * 卡 id 的口径（lib/kinds/index.js cardIdOf）：`<kind>:<路径>`（deck/site/docx/stage；site/docx/stage 的路径可以是目录），
 * 没前缀的 id 就是文件的相对路径（图片 / 散文件 / 便签 / 视频）；`scribble:` 这类画布原生物件没有磁盘身份，跳过。
 * 只把「板上有、磁盘没有」当问题记（signature 按项目归并）；「磁盘有、板上没有」只报数 —— 入座是 run 收尾才做的，
 * 中途看到差异是常态。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBoard } from '../projects/board-store.js';
import { getSharedDir } from '../projects/workspace.js';
import { walkTaskFiles, RESERVED_DIRS } from './task-scan.js';
import { recordIssue } from './issues-store.js';
import { obstaclesIn } from './board-obstacles.js';
import { estimateSizeOn } from './board-kind-sizes.js';

const KIND_PREFIX = /^(deck|site|docx|stage):(.+)$/;
const NATIVE_PREFIX = /^[a-z_-]+:.+/i;   // `C:` 这种冒号后面没东西的不是原生物件，是 Windows 盘符漏进来的影子

export async function auditWorkspace(projectId, { sharedRoot = getSharedDir(projectId), board = null } = {}) {
  const b = board || await readBoard(projectId);
  const ids = Object.keys(b?.objects || {});
  const zones = Object.keys(b?.zones || {});   // 文件夹卡：id 就是文件夹相对路径
  const dangling = []; const checked = []; const covered = new Set();
  for (const id of [...ids, ...zones]) {
    let rel = null; const m = KIND_PREFIX.exec(id);
    if (m) rel = m[2];
    else if (!NATIVE_PREFIX.test(id)) rel = id;
    if (!rel || rel.includes('..')) continue;
    checked.push(id);
    let st = null;
    try { st = await fs.stat(path.join(sharedRoot, rel)); } catch { st = null; }
    if (!st) { dangling.push(id); continue; }
    covered.add(rel.replace(/\/+$/, ''));
  }
  const files = await walkTaskFiles(sharedRoot, { maxDepth: 4 });
  const unseated = [];
  for (const f of files) {
    const top = f.rel.split('/')[0];
    if (RESERVED_DIRS.has(top) || top.startsWith('.')) continue;
    if (covered.has(f.rel)) continue;
    if ([...covered].some((c) => f.rel.startsWith(`${c}/`))) continue;   // 目录卡（站点 / word 文件夹）整段认领
    unseated.push(f.rel);
  }
  const overlaps = boardOverlaps(b, { sharedRoot });
  return { projectId, sharedRoot, objects: ids.length, zones: zones.length, checked: checked.length, dangling, unseated: unseated.slice(0, 50), unseatedCount: unseated.length, files: files.length, overlaps: overlaps.slice(0, 40), overlapCount: overlaps.length };
}

const OVERLAP_MIN = 8;   // 挨着的卡差一两像素不算压（行距取整会产生 1px 叠边）
/**
 * 谁压了谁（2026-09-08 埋点）：同一层里矩形相交超过 OVERLAP_MIN 的物件对，按服务端自己的障碍口径
 * （obstaclesIn：objects + 文件夹卡 + 卷卡，主角按 1.5 倍）。每一对报**谁后到**（seatedAt，没有戳的老座
 * 记 null）和大的那张有没有在对方入座之后长过大小（sizedAt > 对方 seatedAt = 「先摆好邻居、卡再长大」）。
 * 圈注类（板书带 anchor 贴着锚）是合法压盖，这里不分辨 —— 它是审计不是判决，先把账摊开。
 */
export function boardOverlaps(board, { sharedRoot = null, layers = null } = {}) {
  const objs = board?.objects || {};
  const known = new Set(Object.keys(board?.zones || {}));
  const layerSet = layers || new Set(['', ...known]);
  const out = [];
  for (const zone of layerSet) {
    const rects = obstaclesIn(board, zone, { sharedRoot }).filter((r) => !/^(ph|roll):/.test(r.id));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]; const b = rects[j];
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ix < OVERLAP_MIN || iy < OVERLAP_MIN) continue;
        const ea = objs[a.id] || null; const eb = objs[b.id] || null;
        const ta = ea?.seatedAt ?? null; const tb = eb?.seatedAt ?? null;
        const later = ta != null && tb != null ? (ta >= tb ? a : b) : null;
        const big = a.w * a.h >= b.w * b.h ? a : b; const small = big === a ? b : a;
        const eBig = objs[big.id] || null; const eSmall = objs[small.id] || null;
        out.push({
          layer: zone, a: a.id, b: b.id, overlap: `${ix}x${iy}`,
          later: later ? later.id : null, laterBy: later ? (objs[later.id]?.seatedBy || null) : null,
          aSeatedAt: ta, bSeatedAt: tb,
          // 大卡在小卡入座之后变过尺寸 → 「卡长大压了邻居」；大卡的估算尺寸 vs 存的尺寸也给一份
          grewOver: !!(eBig?.sizedAt && eSmall?.seatedAt && eBig.sizedAt > eSmall.seatedAt),
          big: `${big.id} ${big.w}x${big.h}` + (eBig && !Number.isFinite(eBig.w) ? ` (est ${estimateSizeOn(board, big.id, null).w}x${estimateSizeOn(board, big.id, null).h})` : ''),
        });
      }
    }
  }
  return out;
}

/** 挂在项目 bus 上：run 收尾后对一次账，板上有磁盘没有的记一条 auto 问题（同项目归并） */
export function attachWorkspaceAudit(bus, projectId, { audit = auditWorkspace, record = recordIssue, delayMs = 1500 } = {}) {
  let timer = null;
  return bus.subscribe('*', (evt) => {
    if (evt?.type !== 'run.done' && evt?.type !== 'run.error') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const r = await audit(projectId);
        if (!r.dangling.length) return;
        record({
          source: 'auto', kind: 'bug', toolName: 'workspace-audit',
          summary: `画布上 ${r.dangling.length} 张卡对应的文件磁盘上不存在`,
          detail: r.dangling.slice(0, 20).join('\n'), signature: `workspace-audit|${projectId}`, projectId, sessionId: evt.sessionId || null,
        });
      } catch (err) { console.warn('[workspace-audit]', projectId, err?.message || err); }
    }, delayMs);
    timer.unref?.();
  });
}
