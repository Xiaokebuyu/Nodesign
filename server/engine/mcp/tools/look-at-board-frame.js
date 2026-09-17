/**
 * look_at_board 的取景与截图（2026-09-17 从 look-at-board.js 拆出，便于不起浏览器单测）。
 *
 *   frameAround       around → 取景矩形，走共用锚点解析（问题库 iss_mtjevkfs_n9dm）
 *   captureBoardShot  截图超时兜底：先 playwright 等稳定帧，超时改走 CDP 抓当前帧（iss_mtcl9nps_7q15）
 */
import { readBoard } from '../../../projects/board-store.js';
import { makeAnchorResolver, anchorMissHint, anchorMissWhy } from '../../../lib/board-anchor.js';
import { seatArtifacts } from '../../runs/board-seater.js';

const SHOT_TIMEOUT_MS = 15_000;
/**
 * 截当前视口：先 playwright（等稳定帧），超时退到 CDP 抓当前帧（不等任何东西）。
 * @returns {Promise<{buf: Buffer, degraded: boolean}>}
 */
export async function captureBoardShot(page, { timeout = SHOT_TIMEOUT_MS } = {}) {
  try {
    return { buf: await page.screenshot({ type: 'png', fullPage: false, timeout }), degraded: false };
  } catch (err) {
    if (!/timeout/i.test(String(err?.message || err))) throw err;
    const cdp = await page.context().newCDPSession(page);
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      return { buf: Buffer.from(data, 'base64'), degraded: true };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }
}

/**
 * around → 取景矩形。跟 write_on_board 的 near 同一份解析（真 id > tag 包络 > 写法变体 > 救援入座 > 宽认）。
 * @returns {Promise<{box, what} | {error: string}>}
 */
export async function frameAround(projectId, around, margin = 160) {
  const board = await readBoard(projectId);
  const resolve = makeAnchorResolver({ projectId, known: new Set(Object.keys(board.zones || {})), readBoard, seatArtifacts });
  const a = await resolve(around, board);
  if (!a) return { error: `${around} 不在板上：${anchorMissWhy(resolve, around)} —— ${anchorMissHint(around, board)}。` };
  const m = margin;
  return {
    box: { x: a.rect.x - m, y: a.rect.y - m, w: a.rect.w + m * 2, h: a.rect.h + m * 2 },
    what: `around ${a.anchorId}${a.fuzzy ? `（按「${a.fuzzy.from}」认成了 ${a.anchorId}：${a.fuzzy.how}）` : ''}`,
  };
}
