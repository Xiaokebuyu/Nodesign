/**
 * lib/aux-events.js —— 低频「旁路副作用」事件的独立处理面（2026-08-28 拆件）
 *
 * 从 ProjectWorkspace 的大 switch 抽出来的一族：不改会话状态、不折聊天流，
 * 只产生一次性的 UI 副作用（跳页 / 高亮 / toast）。抽出的直接动机是 08-28
 * 死事件清账 —— `run.canvas_focus_page` / `run.merged` / `run.auth_error`
 * 服务端一直在发、前端一直没有 case（勘查实锤），接上时撞了 2408 行数棘轮，
 * 顺势把同族的 canvas_navigate / canvas_highlight 一起搬来。
 *
 * @returns {boolean} true = 这条事件在这里消费完了，调用方就此收手
 */
import { scrollToPage, pulseHighlight } from './canvas-iframe-ops.js';

export function handleAuxEvent(evt, { isStale, showToast }) {
  switch (evt?.type) {
    // C6: agent 的 navigate_to_page / highlight（实现在 canvas-iframe-ops.js）
    case 'run.canvas_navigate':
      if (!isStale) scrollToPage(evt.page);
      return true;
    case 'run.canvas_highlight':
      if (!isStale) pulseHighlight(evt.selector, evt.durationMs);
      return true;
    // Edit/Write 落点跳页（08-28 接上：post-canvas-focus hook 一直在发 ——
    // agent 改了第 N 页用户此前毫无感知）
    case 'run.canvas_focus_page':
      if (!isStale) {
        if (Array.isArray(evt.pages) && evt.pages.length) scrollToPage(evt.pages[0]);
        if (evt.anchor) pulseHighlight(`[data-anchor="${evt.anchor}"]`, 1500);
      }
      return true;
    // 排队消息被 CLI 并进正在跑的回合（08-28 接上：不提示的话那条消息像被吞了）
    case 'run.merged':
      if (!isStale) showToast('刚才那条消息并进了正在跑的回合，一起处理', 'info');
      return true;
    // 模型鉴权失败（08-28 接上：此前完全静默，用户只看到回合迟迟不动）
    case 'run.auth_error':
      showToast(`模型鉴权失败：${evt.message || '未知错误'}`, 'error');
      return true;
    // 明骰直达（08-28 roll_dice）：服务端真随机的骰面第一时间给用户看 ——
    // 不经 GM 的笔，这条是"骰子可信"的另一半（工具返回那半给 GM 写正文用）
    case 'run.dice': {
      const mod = evt.modifier ? (evt.modifier > 0 ? `+${evt.modifier}` : `${evt.modifier}`) : '';
      const vs = evt.dc != null ? ` vs DC${evt.dc} ${evt.outcome === 'success' ? '成功' : '失败'}` : '';
      showToast(`🎲 ${evt.label}：${evt.n}d${evt.sides}${mod} → [${(evt.rolls || []).join(', ')}] = ${evt.total}${vs}`, 'info');
      return true;
    }
    default:
      return false;
  }
}
