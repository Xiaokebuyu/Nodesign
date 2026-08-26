/**
 * server/lib/board-hero.js —— 主角判断的服务端镜像（2026-08-23 黑板）
 *
 * 前端 `web/src/lib/hero.js` 的 pickHero 决定哪张产物卡放大 1.5 倍。服务端摆东西
 * （sketch_on_board / create_on_board 的避让、read_board 的尺寸、look_at_board 的
 * 取景）在这之前只认基础尺寸，于是"锚在主角卡右边"会落进主角卡的身体里
 * （08-23 首跑真踩：纸本站是主角 960 宽，草图从 640 处起算，整张压进去）。
 *
 * **镜像不是重写**：下面 pickHero 的函数体必须与 web/src/lib/hero.js 逐字相同，
 * board-hero.test.js 读两份源码比对。npm 包不带 web/src，所以不能 import 过来。
 */
import { DECK_EMBED_W, ARTIFACT_HEADER_H, ARTIFACT_PREVIEW_H } from './board-kind-sizes.js';
import { layerOf } from './canvas-id.js';

// ── 以下到 END-MIRROR 与 web/src/lib/hero.js 逐字一致 ──
const ELIGIBLE = new Set(['deck', 'site', 'docx']);
const FOCUS_PER_EDGE = 0.5;
const FOCUS_CAP = 1.5;
export function pickHero(items, bindings) {
  const score = new Map();
  for (const it of items || []) {
    if (ELIGIBLE.has(it.type)) score.set(String(it.id), 3);
  }
  if (!score.size) return null;
  const bump = (id, d) => { if (score.has(id)) score.set(id, score.get(id) + d); };
  const focus = new Map();
  for (const b of Object.values(bindings || {})) {
    if (b.type === 'derives-from') { bump(b.from, 2); bump(b.to, -3); }
    if (b.type === 'ref' && b.by === 'auto') bump(b.to, -3);
    // 「手画的线」= 用户 / 主控 / 常驻角色画的（08-26：RP 场里大半线是角色画的，
    // 只认 user|agent 的话主角推断的信号会大量流失）。auto 那支在上面已单独处理。
    if (b.by && b.by !== 'auto') {
      for (const end of [b.from, b.to]) {
        if (!score.has(end)) continue;
        const used = focus.get(end) || 0;
        if (used >= FOCUS_CAP) continue;
        focus.set(end, used + FOCUS_PER_EDGE);
        bump(end, FOCUS_PER_EDGE);
      }
    }
  }
  const ranked = [...score.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] === ranked[1][1]) return null;   // 并列 = 没证据
  return ranked[0][0];
}
// ── END-MIRROR ──

export const HERO_SCALE = 1.5;   // = web board-kinds.js HERO_SCALE

const TYPE_RE = /^(deck|site|docx):/;

/**
 * 这块板此刻的主角 id（只看桌面根层，与前端入座同口径）：board.hero 显式覆盖，
 * 否则按关系线推。前端还会把谱系收叠藏起来的旧版排除在外 —— 那些卡本来就被
 * 改自边重罚，结果一致，这里不重复实现收叠。
 */
export function boardHeroId(board) {
  const known = new Set(Object.keys(board?.zones || {}));
  const items = [];
  for (const [id, e] of Object.entries(board?.objects || {})) {
    if (!Number.isFinite(e?.x) || e.kind) continue;
    if (layerOf(id, e, known) !== '') continue;
    const m = TYPE_RE.exec(id);
    if (m) items.push({ id, type: m[1] });
  }
  if (board?.hero && items.some(it => it.id === board.hero)) return board.hero;
  return pickHero(items, board?.bindings || {});
}

export function heroSize(id) {
  const m = TYPE_RE.exec(String(id || ''));
  if (!m) return null;
  return {
    w: Math.round(DECK_EMBED_W * HERO_SCALE),
    h: ARTIFACT_HEADER_H + Math.round(ARTIFACT_PREVIEW_H[m[1]] * HERO_SCALE),
  };
}
