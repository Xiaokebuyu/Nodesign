/**
 * lib/workspace-audit.js —— 工作区一致性对账（2026-09-08 诊断埋点⑬）：board.json 上有座位的东西磁盘上还在不在，
 * 磁盘上的产物有没有一张卡。09-08 那个 Windows 上 toWorkspaceRel 恒定失败的案子，症状是画布长出名叫 `C:` 的
 * 影子文件夹 + agent 写完文件画布不动 —— 两边对一次账当天就能发现。
 *
 * 卡 id 的口径（lib/kinds/index.js cardIdOf）：`<kind>:<路径>`（deck/site/docx/stage；site/docx/stage 的路径可以是目录），
 * 没前缀的 id 就是文件的相对路径（图片 / 散文件 / 便签 / 视频）；`scribble:` 这类画布原生物件没有磁盘身份，跳过。
 * 只把「板上有、磁盘没有」当问题记（signature 按项目归并）；「磁盘有、板上没有」只报数 —— 入座是 run 收尾才做的，
 * 中途看到差异是常态。
 *
 * 09-17（问题库 iss_mu3kqljp_6ycd / iss_mu0mx6q6_jx75 / iss_mtyisspu_ds3r / iss_mtx1v74x_9p5v / iss_mtg7ls2w_w80i）：
 * 对完账还要**处理**文件已删掉的产物 / 文件卡座位（ghostSeats → pruneGhostSeats）。此前这里只记问题：rm 掉的文件
 * 座位一直留着，前端不画，read_board 照报、落位照绕，谁也清不掉。口径照 api/assets.js 的 confirmDeadZones：
 * 连着两次对账都不在、且不在改名窗口里才剪；剪座位走 patchBoard 的 null，连着它的线由那里的端点级联一并清掉。
 * 板书（notes/板书/，有自己的删除路径）和手写字 / 涂鸦（没有文件本体）不在范围内。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBoard, patchBoard, forwardId, reconcileBoardRenames } from '../projects/board-store.js';
import { getSharedDir } from '../projects/workspace.js';
import { walkTaskFiles, RESERVED_DIRS } from './task-scan.js';
import { recordIssue } from './issues-store.js';
import { obstaclesIn, seatBacked } from './board-obstacles.js';
import { estimateSizeOn, RUNTIME_SINGLETONS } from './board-kind-sizes.js';
import { CHALK_DIR } from './chalk.js';

const KIND_PREFIX = /^(deck|site|docx|stage):(.+)$/;
const NATIVE_PREFIX = /^[a-z_-]+:.+/i;   // `C:` 这种冒号后面没东西的不是原生物件，是 Windows 盘符漏进来的影子

export async function auditWorkspace(projectId, { sharedRoot = getSharedDir(projectId), board = null } = {}) {
  const b = board || await readBoard(projectId);
  const ids = Object.keys(b?.objects || {});
  const zones = Object.keys(b?.zones || {});   // 文件夹卡：id 就是文件夹相对路径
  const dangling = []; const checked = []; const covered = new Set();
  for (const id of [...ids, ...zones]) {
    // 运行时单例（browse / repo）背后本来就没有文件，不参与磁盘对账 —— read_board 那头早就
    // 这么判了（board-kind-sizes.RUNTIME_SINGLETONS 的头注写着"四处都问这一份"，这就是漏掉的
    // 第四处）。漏掉的后果不是没查出来，是**每轮都报一条假的 dangling**：站主库里 09-08 那条
    // 「画布上 1 张卡对应的文件磁盘上不存在」×4 全是浏览器卡，假警报会训练人忽略真警报。
    if (RUNTIME_SINGLETONS.has(id)) continue;
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
  const ghosts = ghostSeats(b, sharedRoot);
  return { projectId, sharedRoot, objects: ids.length, zones: zones.length, checked: checked.length, dangling, ghostSeats: ghosts, unseated: unseated.slice(0, 50), unseatedCount: unseated.length, files: files.length, overlaps: overlaps.slice(0, 40), overlapCount: overlaps.length };
}

/**
 * 文件已经不在磁盘上的产物 / 文件卡座位（09-17）。「文件还在不在」跟落位障碍集是同一个判据
 * （board-obstacles.seatBacked）：那边不画、不绕的，这边才剪。板书、画布原生件、运行时单例不算。
 */
export function ghostSeats(board, sharedRoot) {
  const out = [];
  for (const [id, e] of Object.entries(board?.objects || {})) {
    if (!e || e.kind || id.startsWith(`${CHALK_DIR}/`)) continue;
    if (!seatBacked(id, e, sharedRoot)) out.push(id);
  }
  return out;
}

/** pid → Set(上一次对账时的幽灵座位)。跟 assets.js 的 zoneSuspects 同一个两次判定 */
const seatSuspects = new Map();

/**
 * 剪掉连着两次对账都没有文件撑着的座位（09-17）。
 *
 * 先跑一次 git 改名对账：agent 这一轮 `mv` 走的文件，在这一步被认成改名（座位换成新名字），
 * 而不是被当成删除剪掉 —— 回合末的 commit 已经落了，对账看得见。改名窗口里的（转发表有记录）一律不碰。
 * 两次判定之间文件又回来了（agent 重新写了它），第二次就不在嫌疑名单里，不剪。
 *
 * @returns {Promise<{pruned: string[], suspects: string[]}>}
 */
export async function pruneGhostSeats(projectId, { sharedRoot = getSharedDir(projectId), reconcile = reconcileBoardRenames } = {}) {
  await reconcile(projectId).catch(() => {});
  const board = await readBoard(projectId);
  const ghosts = ghostSeats(board, sharedRoot).filter((id) => forwardId(projectId, id) === id);
  const prev = seatSuspects.get(projectId) || new Set();
  const dead = ghosts.filter((id) => prev.has(id));
  const suspects = ghosts.filter((id) => !dead.includes(id));
  if (suspects.length) seatSuspects.set(projectId, new Set(suspects)); else seatSuspects.delete(projectId);
  if (dead.length) {
    await patchBoard(projectId, { objects: Object.fromEntries(dead.map((id) => [id, null])) });
    console.log(`[board] ${projectId} 清掉 ${dead.length} 个文件已不在的座位: ${dead.slice(0, 3).join(', ')}`);
  }
  return { pruned: dead, suspects };
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

/**
 * 挂在项目 bus 上：run 收尾后对一次账，板上有磁盘没有的记一条 auto 问题（同项目归并），
 * 文件已删的座位走 pruneGhostSeats。
 *
 * 第二次判定不等下一个回合（09-17，iss_mtg7ls2w_w80i「rm 后当轮即清」）：第一次对账留下嫌疑的，
 * confirmMs 后再判一次 —— 两次都在回合结束之后，中间隔着回合末的 commit 与改名对账，
 * 「搬走了」在第一次之前就已被认出来，剩下的是真删掉的。
 * 会被自动剪掉的座位不再记问题（删文件是正常操作，每次都报一条会训练人忽略真警报）。
 */
export function attachWorkspaceAudit(bus, projectId, { audit = auditWorkspace, record = recordIssue, prune = pruneGhostSeats, delayMs = 1500, confirmMs = 10_000 } = {}) {
  let timer = null; let confirmTimer = null;
  const confirm = async () => {
    confirmTimer = null;
    try { await prune(projectId); } catch (err) { console.warn('[workspace-audit] prune', projectId, err?.message || err); }
  };
  const unsubscribe = bus.subscribe('*', (evt) => {
    if (evt?.type !== 'run.done' && evt?.type !== 'run.error') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const r = await audit(projectId);
        const ghosts = new Set(r.ghostSeats || []);
        const real = r.dangling.filter((id) => !ghosts.has(id));
        if (real.length) {
          record({
            source: 'auto', kind: 'bug', toolName: 'workspace-audit',
            summary: `画布上 ${real.length} 张卡对应的文件磁盘上不存在`,
            detail: real.slice(0, 20).join('\n'), signature: `workspace-audit|${projectId}`, projectId, sessionId: evt.sessionId || null,
          });
        }
      } catch (err) { console.warn('[workspace-audit]', projectId, err?.message || err); }
      try {
        const p = await prune(projectId);
        if (p?.suspects?.length && !confirmTimer) { confirmTimer = setTimeout(confirm, confirmMs); confirmTimer.unref?.(); }
      } catch (err) { console.warn('[workspace-audit] prune', projectId, err?.message || err); }
    }, delayMs);
    timer.unref?.();
  });
  // 退订连同两个计时器一起停（09-17 项目删除，iss_mtjex6wv_5xhn）：删完之后 1.5s / 10s 后的对账与剪座位不该再跑
  return () => {
    unsubscribe();
    if (timer) { clearTimeout(timer); timer = null; }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    seatSuspects.delete(projectId);
  };
}
