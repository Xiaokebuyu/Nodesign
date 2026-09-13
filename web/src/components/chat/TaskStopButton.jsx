import { useState } from 'react';
import { COLOR, FONT_SIZE } from '../../lib/theme.js';
import { Turn } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { t } from '../../lib/i18n.js';

/**
 * 子代理时间轴行上的「停止」（2026-09-13）：只停这一个子代理，整轮继续。
 * 服务端走 Query.stopTask(taskId)；停下后 run.task.notification(stopped) 会把这一行改成「已停止」，
 * 主 agent 收到中断的工具结果后自己把这一轮说完。按钮本身只管发请求，状态以事件为准。
 */
export default function TaskStopButton({ projectId, sessionId, taskId }) {
  const [busy, setBusy] = useState(false);
  const showToast = useGlobalStore((s) => s.showToast);
  if (!projectId || !sessionId || !taskId) return null;
  const onClick = async (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await Turn.stopTask({ pid: projectId, sid: sessionId, taskId });
    } catch (err) {
      showToast?.(t('没停下来：子代理可能已经结束'), 'info');
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={t('只停这个子代理，这一轮继续')}
      data-testid="task-stop"
      style={{
        marginLeft: 6, padding: '0 6px', flexShrink: 0,
        fontSize: FONT_SIZE.xs, lineHeight: '16px',
        color: busy ? COLOR.dim : COLOR.sub,
        background: 'transparent', border: `1px solid ${busy ? COLOR.dim : COLOR.sub}`, borderRadius: 2,
        cursor: busy ? 'default' : 'pointer',
      }}
    >
      {busy ? t('停止中…') : t('停止')}
    </button>
  );
}
