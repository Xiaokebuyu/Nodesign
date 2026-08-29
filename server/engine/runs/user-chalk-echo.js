/**
 * server/engine/runs/user-chalk-echo.js —— 用户说话的落痕（2026-08-27 solo 画布对话）
 *
 * 用户从画布标注「说给某个角色」时，话直投收件箱（role-direct 那条 08-26 的路），
 * 但板上什么都不留 —— 这条对话线于是只有角色那半声道，事后回看像一出只印了
 * 一半台词的剧本。这里把同一句话落成 by:'user' 的板书接进线：
 *
 *   - 标注的目标是板书 → frontmatter reply_to 它（线程接上，flow 线照领养同款画）
 *   - 目标是别的画布物件 → frontmatter anchor 它（annotates 线）
 *   - tag 继承目标的（同一条戏线）
 *
 * 落座直接复用板书领养（board-seater.seatArtifacts）：say 端点不是 run，没有
 * run.file_changed 事件可搭，得当场调。
 *
 * ⚠️ 调用方约定：落痕失败**不拦投递** —— 话必须送到，痕是锦上添花。这里抛出的
 * 错由调用方吞并降级（照常 deliver，不带 echo 指针）。
 */

import { readBoard } from '../../projects/board-store.js';
import { getSharedDir } from '../../projects/workspace.js';
import { normalizeCanvasId } from '../../lib/canvas-id.js';
import { renderChalk, chalkFileName, writeChalkFile, CHALK_DIR } from '../../lib/chalk.js';
import { seatArtifacts } from './board-seater.js';

/**
 * @param {string} projectId
 * @param {{ text: string, anchor?: string|null }} p  anchor = 标注目标的 canvas id
 * @returns {Promise<{ rel: string, seated: boolean }>} rel = 落下的板书相对路径
 */
export async function echoUserChalk(projectId, { text, anchor = null }) {
  const board = await readBoard(projectId);
  const aid = anchor ? normalizeCanvasId(String(anchor).slice(0, 300)) : null;
  const ae = aid ? board.objects?.[aid] : null;
  const isChalk = !!(ae && aid.startsWith(`${CHALK_DIR}/`));
  const content = renderChalk({
    body: text, by: 'user',
    // 目标不在板上就落成无链板书（还是比丢掉这半段对话强）
    ...(ae ? (isChalk ? { replyTo: aid } : { anchor: aid }) : {}),
    ...(ae?.tag ? { tag: ae.tag } : {}),
  });
  const rel = await writeChalkFile(getSharedDir(projectId), chalkFileName(text), content);
  const { seated } = await seatArtifacts(projectId, [rel]);
  return { rel, seated: seated > 0 };
}
