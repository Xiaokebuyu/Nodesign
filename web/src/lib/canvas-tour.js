/**
 * 新手引导的五步（2026-09-12，站主看样张后「作为第一版是 OK 的」）。
 *
 * 走在**真界面**上，不是一张说明图：第一次打开示例项目时，逐步圈出画布上正在说的那一件。
 * 样张 ~/claude-report-file/0912-style/inv/sample-tour-1.png / -4.png。
 *
 * ## 两条口径
 *
 * - **不压暗画布**。整块变灰的引导等于把人挡在玻璃外面，而这一步恰恰是要他看清画布上有什么。
 *   用朱砂圈出目标（跟登录页那套红笔线同源），卡片落在它旁边。
 * - **指的是真元素**，所以每一步都挂一个选择器。⛔ 选择器是**跨文件的约定**：
 *   `data-nd-tour` 在 BindingLayer / ChatComposer 上，`data-board-object` 在卡片上，
 *   `data-canvas-keys` 在左下角那一列。谁改了标记，引导会安静地指空 ——
 *   canvas-tour.lint.test.js 钉住这件事。
 */

/** 引导卡的尺寸（定位算得出来就不用量 DOM） */
export const CARD = { w: 330, h: 190 };

/** 看完了 / 这个项目该走一遍（Home 领到示例时写） */
export const TOUR_DONE_KEY = 'nd:tour-done';
export const TOUR_PENDING_KEY = 'nd:tour-pending';

/**
 * 每一步：anchor = 圈谁。**按顺序试**的一串选择器，取第一个命中且尺寸合用的元素
 * （第三步就靠这个：优先圈线上的那句字，没有字才退回整条线）。
 * `src` 是这些标记住在哪个文件里，判据靠它反查。
 */
export const TOUR_STEPS = [
  {
    id: 'canvas',
    anchor: ['[data-board-object^="site:"], [data-board-object^="docx:"], [data-board-object^="deck:"]'],
    src: 'components/canvas/cards/BoardObject.jsx',
    title: '这是你的画布',
    body: 'Agent 做出来的东西都摆在这块画布上：一个站点、一份演示稿、一份 Word、几张图。它们是文件，不是聊天记录里的片段。',
  },
  {
    id: 'open',
    anchor: ['[data-board-object^="site:"], [data-board-object^="docx:"], [data-board-object^="deck:"]'],
    src: 'components/canvas/cards/BoardObject.jsx',
    title: '双击打开它',
    body: '在窗口里看、改、导出。关掉窗口，画布上这张卡跟着更新 —— 卡就是那件东西本身。',
  },
  {
    id: 'link',
    // ⛔ 别圈整层（`[data-nd-tour="links"]`）：那张 svg 铺满画布，圈出来等于圈了整个屏幕（09-12 实测）
    anchor: ['[data-nd-tour="link-label"]', '[data-nd-tour="link"]'],
    // 线是一条曲线，外框是一大片空白 —— 圈它的中点，不圈它的外框
    ring: 'spot',
    src: 'components/canvas/BindingLayer.jsx',
    title: '线就是关系',
    body: '两件东西之间连一条线，Agent 就知道它们相关。改其中一件的时候，它会顺着线找到另一件。',
  },
  {
    id: 'chat',
    anchor: ['[data-nd-tour="composer"]'],
    src: 'components/chat/ChatComposer.jsx',
    title: '在这里跟它说话',
    body: '在这里说一句，它看得到画布上的全部内容。想改哪一件，先点那一件再说话，它就知道你指的是谁。',
  },
  {
    id: 'keys',
    anchor: ['[data-canvas-keys]'],
    src: 'components/canvas/CanvasCorner.jsx',
    title: '工具和快捷键在这里',
    body: '底边正中是工具栏，左下角是常用快捷键。看完回首页，在那句输入框里写一句，就是你自己的第一个项目。',
  },
];

/**
 * 圈得出来吗。三条，每一条都是实测逼出来的：
 *   太小   还没画出来（宽高 ≤ 4）
 *   太大   整层铺满屏 —— 第三步原来指的是整张关系线 svg，圈出来是个包住整屏的框
 *   在屏外 画布上的东西多半不在视野里（第三步改指线上的字之后，圈跑到 y=1543 去了）
 * 前两条只看尺寸，第三条要跟视口求交：⛔ 少了它，卡片会指着屏幕外的东西讲话。
 */
export function usable(rect, view, maxRatio = 0.7) {
  if (!rect || rect.w <= 4 || rect.h <= 4) return false;
  if (rect.w > view.w * maxRatio && rect.h > view.h * maxRatio) return false;
  const vx = Math.min(rect.x + rect.w, view.w) - Math.max(rect.x, 0);
  const vy = Math.min(rect.y + rect.h, view.h) - Math.max(rect.y, 0);
  return vx > 8 && vy > 8;
}

/**
 * 卡片摆哪：先右、再左、再下、最后上；都放不下就贴着视口边。
 * 纯函数，因为"卡片被挤出屏幕"这种错只在小窗口上出现，靠眼睛看不全（判据 canvas-tour.test.js）。
 * @param {{x:number,y:number,w:number,h:number}} target 圈出来的那块
 * @param {{w:number,h:number}} card
 * @param {{w:number,h:number}} view 视口
 */
export function placeCard(target, card = CARD, view = { w: 1440, h: 900 }, gap = 20, margin = 16) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  // view 可以带 x/y：钉住的聊天卡占了一侧时，能摆卡的只是它左边（或右边）那块
  const x0 = view.x || 0;
  const y0 = view.y || 0;
  const x1 = x0 + view.w;
  const y1 = y0 + view.h;
  const midY = clamp(target.y + target.h / 2 - card.h / 2, y0 + margin, Math.max(y0 + margin, y1 - card.h - margin));
  const midX = clamp(target.x + target.w / 2 - card.w / 2, x0 + margin, Math.max(x0 + margin, x1 - card.w - margin));

  const right = target.x + target.w + gap;
  if (right + card.w <= x1 - margin) return { x: right, y: midY, side: 'right' };

  const left = target.x - gap - card.w;
  if (left >= x0 + margin) return { x: left, y: midY, side: 'left' };

  const below = target.y + target.h + gap;
  if (below + card.h <= y1 - margin) return { x: midX, y: below, side: 'below' };

  const above = target.y - gap - card.h;
  if (above >= y0 + margin) return { x: midX, y: above, side: 'above' };

  // 哪边都塞不下（目标几乎占满屏）：压在它身上，居中
  return { x: midX, y: midY, side: 'over' };
}
