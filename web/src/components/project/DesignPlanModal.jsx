/**
 * DesignPlanModal — S4b-3
 *
 * 全屏 modal 渲染 sessions/<sid>/design-plan.md（markdown）。
 *
 * 触发路径：
 *   1. run.plan_doc_ready 事件 → ProjectWorkspace setOpen(true)
 *   2. Message.jsx Write tool 按钮 → useGlobalStore.openDesignPlan()
 *
 * 关闭：点遮罩 / 右上 × / esc。fetch 失败友好降级。
 */

import { useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { X } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { DesignPlan } from '../../lib/api.js';
import { COLOR, GAP, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';

export default function DesignPlanModal({ pid, sid }) {
  const designPlanOpen = useGlobalStore((s) => s.designPlanOpen);
  const closeDesignPlan = useGlobalStore((s) => s.closeDesignPlan);

  const [markdown, setMarkdown] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ESC 关
  useEffect(() => {
    if (!designPlanOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') closeDesignPlan(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [designPlanOpen, closeDesignPlan]);

  // 打开时 fetch；关闭时清缓存（下次打开重 fetch，避免老内容）
  useEffect(() => {
    if (!designPlanOpen) {
      setMarkdown(null); setError(null);
      return;
    }
    if (!pid || !sid) {
      setError('缺 pid / sid，无法定位 plan 文件');
      return;
    }
    setLoading(true); setError(null);
    DesignPlan.read(pid, sid)
      .then(({ plan }) => setMarkdown(plan))
      .catch((err) => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  }, [designPlanOpen, pid, sid]);

  const handleOverlayClick = useCallback((e) => {
    if (e.target === e.currentTarget) closeDesignPlan();
  }, [closeDesignPlan]);

  if (!designPlanOpen) return null;

  return (
    <div
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(20, 16, 10, 0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: GAP.lg,
        animation: 'nd-fadein 160ms ease',
      }}
    >
      <div
        style={{
          width: '100%', maxWidth: 840,
          maxHeight: '86vh',
          display: 'flex', flexDirection: 'column',
          background: COLOR.bg,
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: 12,
          boxShadow: '0 8px 28px rgba(20,16,10,0.18), 0 2px 8px rgba(20,16,10,0.08)',
          overflow: 'hidden',
        }}
      >
        {/* 头部 */}
        <header
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: `${GAP.md}px ${GAP.lg}px`,
            borderBottom: `1px solid ${COLOR.borderLt}`,
            background: COLOR.bgCard,
          }}
        >
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
            color: COLOR.text2, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: GAP.sm,
          }}>
            <span>📄</span>
            <span>设计计划</span>
            <span style={{ fontSize: FONT_SIZE.xs, color: COLOR.sub, fontWeight: 400 }}>
              design-plan.md
            </span>
          </div>
          <button
            onClick={closeDesignPlan}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: GAP.xs,
              display: 'flex', alignItems: 'center',
              color: COLOR.sub,
            }}
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>

        {/* 主体 */}
        <main
          style={{
            flex: 1, overflow: 'auto',
            padding: `${GAP.lg}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
            color: COLOR.text2, lineHeight: 1.7,
          }}
        >
          {loading && (
            <div style={{ color: COLOR.sub, fontStyle: 'italic' }}>加载中…</div>
          )}
          {error && (
            <div style={{ color: COLOR.error }}>读取失败：{error}</div>
          )}
          {!loading && !error && markdown == null && (
            <div style={{ color: COLOR.sub, fontStyle: 'italic' }}>
              这个 session 还没生成设计计划。让 agent 进入深度对齐流程后会自动写一份。
            </div>
          )}
          {markdown && (
            <div className="nd-markdown">
              <ReactMarkdown>{markdown}</ReactMarkdown>
            </div>
          )}
        </main>

        {/* 底部 hint */}
        <footer
          style={{
            padding: `${GAP.sm}px ${GAP.lg}px`,
            borderTop: `1px solid ${COLOR.borderLt}`,
            background: COLOR.bgCard,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}
        >
          <span>plan 是 agent 的执行 brief — 改方向时让 agent 重写</span>
          <span style={{ opacity: 0.7 }}>esc 关闭</span>
        </footer>
      </div>
    </div>
  );
}
