import { useEffect } from 'react';
import { Sessions } from '../lib/api.js';
import { sessionMessagesToDisplay } from '../lib/session-to-messages.js';
import { COMPOSER_RESTORE_EVENT } from '../lib/composer-draft.js';
import { newId } from '../lib/helpers.js';

/**
 * 「回到某条消息之前」落地后，工作台这边要跟着动的两件事（2026-08-30 从
 * ProjectWorkspace 抽出，行数棘轮）。
 *
 * 两个事件都由 UserMessage 里的 RewindDialog 发出 —— 走 window 事件而不是 props，
 * 是因为消息气泡埋在 ChatPanel → TimelineGroup → Message 三层下面，为这两个回调
 * 穿三层 props 不划算。
 *
 *   nd-conversation-rewound  原地回退：服务端已把 jsonl 截断，这里整体重拉替换
 *                            messages（回退时必无进行中 turn，不存在洗掉流式正文
 *                            的问题）。
 *   nd-session-forked        分叉：切到新会话。跟 SessionListModal 的 onSwitch 是
 *                            同一套动作 —— 改服务端指针（会话唯一真相源），本地
 *                            先行，WS 重连自动重 hydrate。messages 先清空，免得新
 *                            会话的历史到之前旧那条还挂在屏幕上（两条前半段一模
 *                            一样，光看内容看不出已经换了线）。
 *   nd:composer-restore      原话放回输入框时（09-17，iss_mtxylgs4_xmmz），那条消息的附件回托盘。
 *                            文字归 ChatComposer 接（lib/composer-draft.js）；托盘是工作台的 state，
 *                            所以附件在这里接。按 path 去重，已在托盘里的不重复加。
 */
export function useRewindEvents({
  projectId,
  currentSessionId,
  setMessages,
  sessionIdRef,
  setCurrentSessionId,
  updateProject,
  setInputs = null,
}) {
  useEffect(() => {
    const onRewound = (e) => {
      if (!currentSessionId || e.detail?.sessionId !== currentSessionId) return;
      Sessions.read(projectId, currentSessionId)
        .then(({ messages: m = [] }) => setMessages(sessionMessagesToDisplay(m)))
        .catch(() => { /* 拉不到就等下次切会话自然重拉 */ });
    };
    window.addEventListener('nd-conversation-rewound', onRewound);
    return () => window.removeEventListener('nd-conversation-rewound', onRewound);
  }, [projectId, currentSessionId, setMessages]);

  useEffect(() => {
    const onForked = (e) => {
      const sid = e.detail?.sessionId;
      if (!sid) return;
      setMessages([]);
      sessionIdRef.current = sid;
      setCurrentSessionId(sid);
      updateProject(projectId, { activeSessionId: sid });
    };
    window.addEventListener('nd-session-forked', onForked);
    return () => window.removeEventListener('nd-session-forked', onForked);
  }, [projectId, setMessages, sessionIdRef, setCurrentSessionId, updateProject]);

  useEffect(() => {
    if (!setInputs) return undefined;
    const onRestore = (e) => {
      const list = (Array.isArray(e.detail?.attachments) ? e.detail.attachments : []).filter((a) => a && a.path);
      if (!list.length) return;
      setInputs((arr) => {
        const have = new Set(arr.map((it) => it.path).filter(Boolean));
        const add = list.filter((a) => !have.has(a.path)).map((a) => ({ ...a, type: 'asset', id: newId('asset') }));
        return add.length ? [...arr, ...add] : arr;
      });
    };
    window.addEventListener(COMPOSER_RESTORE_EVENT, onRestore);
    return () => window.removeEventListener(COMPOSER_RESTORE_EVENT, onRestore);
  }, [setInputs]);
}
