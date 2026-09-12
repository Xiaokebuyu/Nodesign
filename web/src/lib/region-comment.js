/**
 * 圈选评论（2026-08-07 建，2026-09-12 从 ProjectWorkspace 拆出）—— 跟点选评论进同一条
 * pending-changes buffer，差别是它多带一张服务端截的区域图。
 *
 * 两条出口：
 *   - queue（默认，跟标注浮层一致）：登记进 comments（右下角浮钮计数、handleSend 统一标 sentAt）
 *     再 POST 进 buffer，不起轮；用户接着圈下一块，攒够了一起发。
 *   - 立刻发：POST 完直接起一轮，消息只写一句指路，内容 agent 自己去 get_pending_changes 拉。
 */
import { PendingChanges } from './api.js';
import { newId } from './helpers.js';
import { useGlobalStore } from '../stores/globalStore.js';

export function makeRegionCommentHandler({ projectId: id, setComments, showToast, handleSend }) {
  return async ({ region, viewport, container, elements, text, path, docxPage, queue = false }) => {
    // 无会话闸门 2026-08-13 撤除：没有会话时 handleSend 自己会起一条新的
    if (!path) {
      showToast('这份产物没有任务路径，圈选暂时用不了', 'error');
      return;
    }
    const rel = path;
    // 攒着（2026-09-12 一次多个截图标注）：先登记进 comments（右下角浮钮计数 + handleSend 统一标 sentAt），
    // 再 POST 进 buffer（服务端裁图要几秒，登记不等它）。发送时 agent 从 get_pending_changes 一起拉。
    const cid = queue ? newId('rgn') : null;
    if (queue) {
      setComments(arr => [...arr, {
        id: cid, kind: 'region-comment', anchor: null, path: rel, text, region,
        status: 'open', createdAt: new Date().toISOString(),
      }]);
    }
    try {
      await PendingChanges.regionComment(id, {
        ...(cid ? { id: cid } : {}),
        path: rel, region, viewport, container, elements, text,
        // docx 圈的是页图，得说清第几页（服务端按它去页图缓存裁）
        ...(docxPage ? { docxPage } : {}),
      });
    } catch (err) {
      if (cid) setComments(arr => arr.filter(c => c.id !== cid));
      showToast(`圈选没记下来：${err.message}`, 'error');
      return;
    }
    if (queue) return;
    const what = docxPage ? `第 ${docxPage} 页`
      : elements.length
        ? `${elements.slice(0, 3).map(e => `<${e.tag}>`).join('')}${elements.length > 3 ? ' 等' : ''}`
        : '一块区域';
    useGlobalStore.getState().openChatDock();   // 对话在悬浮卡里流，收起时唤出来
    await handleSend(text
      ? `我在 ${rel} 上圈了一块（${what}）：${text}`
      : `我在 ${rel} 上圈了一块（${what}），看一下 —— 截图和框住的${docxPage ? '区域' : '元素'}都在 pending changes 里。`);
  };
}
