/**
 * server/lib/board-anchor.js —— 锚点解析（2026-08-27 行数棘轮拆件）
 *
 * 从 mcp/tools/write-on-board.js **原样**搬出：真 id > tag 包络 > **救援入座**
 * （文件真在只是还没座位 —— 当场给它排一个再锚。入座下沉后防抖 1.5s 内的窗口、
 * 以及历史欠座都从这里兜住，「还没有座位」这个失败类只剩"确实不存在"一种真情况）。
 *
 * readBoard / seatArtifacts 走注入，不在这里 import —— lib 不该反向抓 engine/runs
 * 和 projects 层的东西；纯几何依赖（canvas-id / board-kind-sizes）留作直接 import。
 */

import { layerOf, normalizeCanvasId, tagEnvelope } from './canvas-id.js';
import { estimateSizeOn, FOLDER_CARD } from './board-kind-sizes.js';

/**
 * @param {object} deps
 *   projectId       救援入座要按项目发
 *   known           Set(board.zones 的键) —— layerOf 的分层判据
 *   readBoard       (pid) => board       救援后重读
 *   seatArtifacts   (pid, [rel]) => {seated}
 * @returns {(raw: string, b: object) => Promise<{anchorId,zone,rect,board,rescued?}|null>}
 */
export function makeAnchorResolver({ projectId, known, readBoard, seatArtifacts }) {
  const sizeOf = (b) => (id, e) => estimateSizeOn(b, id, e);
  return async function resolveAnchor(raw, b) {
    // 文件夹卡也是锚（2026-09-05 意图层：place.by:"素材" 是很自然的写法）
    const zname = typeof raw === 'string' ? raw.trim().replace(/^#/, '') : '';
    const z = zname && b.zones?.[zname];
    if (z && Number.isFinite(z.x) && Number.isFinite(z.y)) {
      return { anchorId: zname, zone: '', rect: { x: z.x, y: z.y, ...FOLDER_CARD }, board: b, folder: true };
    }
    const nid = normalizeCanvasId(raw);
    const e = nid ? b.objects?.[nid] : null;
    if (e && Number.isFinite(e.x)) {
      return { anchorId: nid, zone: layerOf(nid, e, known), rect: { x: e.x, y: e.y, ...estimateSizeOn(b, nid, e) }, board: b };
    }
    const env = tagEnvelope(b, raw, sizeOf(b));
    if (env) {
      return { anchorId: env.anchorId, zone: layerOf(env.anchorId, b.objects[env.anchorId], known), rect: { x: env.x, y: env.y, w: env.w, h: env.h }, board: b };
    }
    if (nid) {
      const bare = nid.replace(/^(deck|site|docx|text|scribble):/, '');
      const { seated } = await seatArtifacts(projectId, [bare]).catch(() => ({ seated: 0 }));
      if (seated) {
        const nb = await readBoard(projectId);
        const ne = nb.objects?.[nid] || nb.objects?.[bare];
        const realId = nb.objects?.[nid] ? nid : bare;
        if (ne && Number.isFinite(ne.x)) {
          return { anchorId: realId, zone: layerOf(realId, ne, known), rect: { x: ne.x, y: ne.y, ...estimateSizeOn(nb, realId, ne) }, board: nb, rescued: true };
        }
      }
    }
    return null;
  };
}
