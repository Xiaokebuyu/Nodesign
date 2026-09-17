/**
 * server/lib/board-endpoint.js —— 关系线端点的归一与校验（2026-09-17，问题库 iss_mtgcjmnf_tye4）
 *
 * 病根：read_board / 每回合关系摘要 / 邻域注入曾把端点印成 `X（site）`，agent 照抄回来。
 * write_on_board / move / pin 的 by 走锚点宽认接住了（a5ea942f），线的端点没有；add_edge 还把裸目录名
 * `十三机兵防卫圈` 当「磁盘上存在」收下，存成一个没有卡的端点 —— 前端按 id 精确找卡（BoardCanvas
 * rectOfId），画不出来，工具却回报成功。
 *
 * edit_board 的 add_edge / set_edge 与 write_on_board 的图内边共用这一份，顺序：
 *   1. 调用方自己的句柄（edit_board 的 rid：本调用局部 id / lid / tag / 精确 id / 文件夹）；
 *   2. 近乎精确的写法变体（board-anchor.nameVariants：括注里的 id、剥括注、index.html → 站点、补前缀）；
 *   3. 磁盘上真有、会渲染成卡的文件：当场入座，按入座器实际落的 id（站点目录里的文件归站点卡）；
 *   4. 画布上的文件夹（与 /artifacts 同判，lib/folder-claims.js）。
 * 认完必须是前端画得出来的东西：板上有座位且文件还在（或画布原生件 / 运行时单例），或者文件夹卡。
 * 否则拒，并给候选。**不走宽认**（目录名整片、唯一同名、唯一包含）：线连错比连不上更难发现。
 */
import { normalizeCanvasId } from './canvas-id.js';
import { nameVariants, dirCardOn, anchorMissHint, cleanAnchorName } from './board-anchor.js';
import { seatBacked } from './board-obstacles.js';
import { isCanvasFolder } from './folder-claims.js';

const PREFIX_RE = /^(deck|site|docx|stage):/;
const NATIVE_RE = /^(text|scribble):/;

/**
 * @param {object} deps
 *   projectId, sharedRoot
 *   readBoard(pid) / seatArtifacts(pid, [rel])   救援入座（注入，同 board-anchor）
 *   board     调用开始时的板（候选提示用）
 *   live      本调用的当前态 objects —— 救援入座成功会把新座位写进来
 *   zones     当前态 zones
 *   local     (raw) => id|null  调用方自己的句柄解析
 * @returns {(raw: string) => Promise<{id: string, how?: string|null} | {error: string}>}
 */
export function makeEndpointResolver({ projectId, sharedRoot, readBoard, seatArtifacts, board = {}, live, zones = {}, local = () => null }) {
  const hasZone = (id) => Object.prototype.hasOwnProperty.call(zones, id);
  /** 这个 id 此刻画不画得出来：{id} 画得出；{ghost} 有座位但文件已不在；null 不在板上 */
  const drawable = async (id) => {
    if (!id) return null;
    if (live[id]) return seatBacked(id, live[id], sharedRoot) ? { id } : { ghost: id };
    if (hasZone(id)) {
      // 同名目录是一张站点 / word 文件夹卡：那层文件夹坐标前端不画（iss_mtp465ds_ctko）
      const card = dirCardOn({ objects: live }, id);
      if (card) return { id: card, how: '同名目录是一张产物卡，不是文件夹' };
      // 前端只画扫描清单里的文件夹：目录已删、或它其实是还没座位的站点目录，这层坐标都画不出来
      if (!sharedRoot || await isCanvasFolder(sharedRoot, id).catch(() => false)) return { id };
    }
    return null;
  };

  return async function resolveEnd(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return { error: '端点是空的' };
    let ghost = null;
    const first = await drawable(local(s) || normalizeCanvasId(s));
    if (first?.id) return first;
    if (first?.ghost) ghost = first.ghost;
    for (const [v, how] of nameVariants(s)) {
      const h = await drawable(normalizeCanvasId(v));
      if (h?.id) return { id: h.id, how: h.how ? `${how}；${h.how}` : how };
      if (h?.ghost && !ghost) ghost = h.ghost;
    }

    // 磁盘上真有：让入座器按注册表落座，按它实际落的 id 连（不猜 deck:/裸路径）
    const nid = normalizeCanvasId(cleanAnchorName(s));
    const bare = nid && !NATIVE_RE.test(nid) ? nid.replace(PREFIX_RE, '') : '';
    let reason = null;
    if (bare && !ghost) {
      const r = await seatArtifacts(projectId, [bare]).catch(() => null);
      const id = r?.ids?.[bare];
      if (id) {
        if (!live[id]) { const nb = await readBoard(projectId); if (nb?.objects?.[id]) live[id] = nb.objects[id]; }
        const h = await drawable(id);
        if (h?.id) return { id: h.id, how: id !== nid && id !== bare ? '这个文件归这张卡（按产物注册表认）' : null };
      }
      if (r?.skipped?.includes(bare)) {
        if (await isCanvasFolder(sharedRoot, bare).catch(() => false)) return { id: bare, how: null };
        reason = '磁盘上这个路径不作为一张卡上画布（隐藏目录、exports/、assets/ 深处、站点内部目录等），线画不出来';
      } else if (r?.missing?.includes(bare)) {
        reason = '磁盘上也没有这个路径';
      }
    }
    const hint = anchorMissHint(s, { ...board, objects: live, zones });
    if (ghost) return { error: `${s}：${ghost} 的文件已不在磁盘上，画布上没有这张卡，线画不出来 —— ${hint}` };
    return { error: `${s} 不在板上${reason ? `，${reason}` : ''} —— ${hint}` };
  };
}
