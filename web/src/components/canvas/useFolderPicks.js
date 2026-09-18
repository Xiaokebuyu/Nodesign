import { createContext, useCallback, useMemo, useState } from 'react';

/**
 * useFolderPicks —— 同类收卡的文件夹「此刻显示哪一件」（2026-09-18）
 *
 * 纯本机的偏好（看哪一版是看的人自己的事，不是版面的事实），所以记在 localStorage、不写
 * board.json。读写都包 try：隐私窗口、清过站点数据时拿不到，退回「最近那一件」。
 * 记的是物件 id；那一件被搬走或删掉之后 id 对不上，调用方照样退回第一件。
 *
 * 两种卡共用这一份（键不会撞：文件夹卡用文件夹路径，word 目录卡用 `docx:<文件夹>`）：
 *   - 同类收卡的文件夹卡：值是成员物件 id（FolderCard 的 pick 走 props）
 *   - word 目录卡（09-18 站主「下拉加一下」）：值是成员 .docx 的路径；applyDocxPick 在派生物件那一步
 *     换掉 deckFile，于是卡面缩略、双击打开、菜单打开、手机点开都自动是选中那份。卡头的下拉从
 *     DocxPickContext 拿 setPick（ArtifactCard 在 BoardObject 里面，不为一个回调穿两层 props）
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
  const ctx = useMemo(() => ({ setPick }), [setPick]);   // DocxPickContext 的值：稳定引用，不让卡片无谓重渲
  return [picks, setPick, ctx];
}

/** word 目录卡卡头下拉拿 setPick 的口（BoardCanvas 提供） */
export const DocxPickContext = createContext(null);

/** 选过的成员换进 deckFile（那份已经不在成员表里就照旧用第一份） */
export function applyDocxPick(o, picks) {
  if (o?.type !== 'docx' || !(o.members?.length > 1)) return o;
  const f = picks?.[o.id];
  return f && f !== o.deckFile && o.members.some((m) => m.file === f) ? { ...o, deckFile: f } : o;
}
