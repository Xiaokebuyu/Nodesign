/**
 * desktop/window-state.js —— 主窗口开多大、开在哪。单独成文件是为了不带 electron 也能测。
 *
 * ⛔ 09-07 站主：进画布后小地图缺一截、AI 侧栏输入框大半在屏幕外。窗口是写死的 1440×900 建的，
 * Electron 不会替你按屏幕裁：1920×1080 开 125% 缩放的笔记本可用高度只有 864 减任务栏，
 * 窗口比屏幕高，底下那截落在屏幕外面。修法两条：
 *   1. 首次按主屏**工作区**（不含任务栏）取最小值；
 *   2. 记住上次的大小 / 位置 / 是否最大化，下次照开 —— 但位置要落在某块现存显示器的工作区里
 *      （外接屏拔掉了就回主屏居中），大小照样按那块屏裁。
 */

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 960, height: 600 };

/**
 * @param {{ width:number, height:number, x?:number, y?:number, maximized?:boolean } | null} saved  上次存的
 * @param {{ x:number, y:number, width:number, height:number }[]} workAreas  各显示器的工作区（DIP，不含任务栏），[0] 是主屏
 * @returns {{ width:number, height:number, x?:number, y?:number, maximized:boolean }}
 */
export function resolveWindowBounds(saved, workAreas) {
  const primary = workAreas[0] || { x: 0, y: 0, ...DEFAULT_SIZE };
  const wanted = { width: num(saved?.width, DEFAULT_SIZE.width), height: num(saved?.height, DEFAULT_SIZE.height) };
  // 位置落在哪块屏上：左上角在那块屏工作区里（允许贴边）；不在任何一块上就当没存过
  const at = Number.isFinite(saved?.x) && Number.isFinite(saved?.y)
    ? workAreas.find((wa) => saved.x >= wa.x && saved.y >= wa.y && saved.x < wa.x + wa.width && saved.y < wa.y + wa.height) || null
    : null;
  const screenArea = at || primary;
  const width = clamp(wanted.width, MIN_SIZE.width, screenArea.width);
  const height = clamp(wanted.height, MIN_SIZE.height, screenArea.height);
  const out = { width, height, maximized: !!saved?.maximized };
  if (at) {
    // 存的位置在屏上，但按新尺寸可能右下越界（比如换了分辨率）：往回挪到刚好贴边
    out.x = Math.min(saved.x, at.x + at.width - width);
    out.y = Math.min(saved.y, at.y + at.height - height);
  }
  return out;   // 没有 x/y → 调用方 center
}

function num(v, d) { return Number.isFinite(v) && v > 0 ? Math.round(v) : d; }
function clamp(v, lo, hi) { return Math.max(Math.min(lo, hi), Math.min(v, hi)); }
