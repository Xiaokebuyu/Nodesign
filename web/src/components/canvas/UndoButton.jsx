import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { Canvas } from '../../lib/api.js';

/**
 * UndoButton —— 顶栏 / canvas 区一颗"撤销"按钮
 *
 * 调 POST /api/projects/:pid/canvas/undo（git checkout 上一个 commit）。
 * 成功后调用 onUndone(commit) 让父级 bump reloadToken。
 *
 * 设计：
 * - 操作不可逆（git revert 会创建新 commit），用户应该明白
 * - 失败时不抛，回 toast，让父级处理
 * - loading 状态防双击
 */
export default function UndoButton({ projectId, onUndone, onError, label = '撤销' }) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (loading || !projectId) return;
    setLoading(true);
    try {
      const result = await Canvas.undo(projectId);
      onUndone?.(result);
    } catch (err) {
      onError?.(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: GAP.xs,
        padding: `${GAP.xs + 1}px ${GAP.lg}px`,
        fontFamily: FONT_SANS,
        fontSize: FONT_SIZE.sm,
        color: COLOR.text2,
        background: loading ? 'rgba(0,0,0,0.02)' : 'rgba(0,0,0,0.04)',
        borderRadius: 6,
        border: 'none',
        cursor: loading ? 'wait' : 'pointer',
        opacity: loading ? 0.6 : 1,
      }}
      title="回到上一个 git commit 的 canvas.html"
    >
      <Undo2 size={13} />
      {loading ? '撤销中…' : label}
    </button>
  );
}
