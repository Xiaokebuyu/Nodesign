import { useCallback, useState } from 'react';

/**
 * useFolderPicks —— 同类收卡的文件夹「此刻显示哪一件」（2026-09-18）
 *
 * 纯本机的偏好（看哪一版是看的人自己的事，不是版面的事实），所以记在 localStorage、不写
 * board.json。读写都包 try：隐私窗口、清过站点数据时拿不到，退回「最近那一件」。
 * 记的是物件 id；那一件被搬走或删掉之后 id 对不上，调用方照样退回第一件。
 */
const KEY = (pid) => `nd:folder-picks:${pid}`;

function load(pid) {
  try { return JSON.parse(localStorage.getItem(KEY(pid)) || '{}') || {}; } catch { return {}; }
}

export function useFolderPicks(projectId) {
  const [picks, setPicks] = useState(() => load(projectId));
  const setPick = useCallback((folderId, memberId) => {
    setPicks((prev) => {
      const next = { ...prev, [folderId]: memberId };
      try { localStorage.setItem(KEY(projectId), JSON.stringify(next)); } catch { /* 只管这一次 */ }
      return next;
    });
  }, [projectId]);
  return [picks, setPick];
}
