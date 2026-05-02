/**
 * PlanReviewCard — Phase 3.2 SDK 原生 plan mode 审批卡
 *
 * 触发：run.plan_for_approval 事件（agent 在 plan mode 下调 ExitPlanMode 工具）
 *   → ProjectWorkspace setPlanForApproval({ toolUseId, plan })
 *   → 本卡片显示
 *
 * 用户操作：
 *   - **批准并执行**：POST /plan-approve → setPermissionMode('default') → agent 自然继续
 *   - **编辑后批准**：toggle textarea 编辑 plan → POST /plan-approve { editedPlan } → 后端落 design-plan.md + 切 mode
 *   - **重新对齐（拒绝）**：POST /plan-reject → cancelRun → run 中断，前端切回 chat 让用户重述
 *
 * 设计：
 *   - 独立 modal-like 组件，覆盖 chat 区
 *   - markdown 用 react-markdown 渲染
 *   - 编辑模式用原生 textarea（避免拉 monaco 依赖；plan 文本不会很大）
 *   - 不能 dismiss（必须三选一），ESC 也不行—— SDK 在 plan mode 下卡着等
 */
import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Check, Edit3, X, Send } from 'lucide-react';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Plan } from '../../lib/api.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';

export default function PlanReviewCard() {
  const planForApproval = useGlobalStore((s) => s.planForApproval);
  const clearPlanForApproval = useGlobalStore((s) => s.clearPlanForApproval);
  const activeRun = useGlobalStore((s) => s.activeRun);
  const showToast = useGlobalStore((s) => s.showToast);

  const [editing, setEditing] = useState(false);
  const [editedPlan, setEditedPlan] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 新 plan 来时重置 state
  useEffect(() => {
    if (planForApproval) {
      setEditing(false);
      setEditedPlan(planForApproval.plan || '');
      setSubmitting(false);
    }
  }, [planForApproval?.toolUseId]);

  if (!planForApproval) return null;

  const { plan } = planForApproval;
  const planText = editing ? editedPlan : plan;

  const handleApprove = async () => {
    if (!activeRun?.pid || !activeRun?.runId) {
      showToast('当前无活跃 run，无法批准 plan', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await Plan.approve({
        pid: activeRun.pid,
        runId: activeRun.runId,
        editedPlan: editing && editedPlan.trim() !== plan.trim() ? editedPlan : undefined,
      });
      showToast('plan 已批准，agent 开始执行', 'success');
      clearPlanForApproval();
    } catch (err) {
      setSubmitting(false);
      showToast(`批准失败：${err.message}`, 'error');
    }
  };

  const handleReject = async () => {
    if (!activeRun?.pid || !activeRun?.runId) {
      showToast('当前无活跃 run', 'error');
      clearPlanForApproval();
      return;
    }
    if (!confirm('确定拒绝这个 plan？run 会中止，你需要重新发 brief。')) return;
    setSubmitting(true);
    try {
      await Plan.reject({
        pid: activeRun.pid,
        runId: activeRun.runId,
        reason: 'plan_rejected_by_user',
      });
      showToast('plan 已拒绝，run 已中止', 'info');
      clearPlanForApproval();
    } catch (err) {
      setSubmitting(false);
      showToast(`拒绝失败：${err.message}`, 'error');
    }
  };

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      background: 'rgba(0,0,0,0.5)',
      zIndex: 100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: GAP.lg,
    }}>
      <div style={{
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
        maxWidth: 880,
        width: '100%',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* header */}
        <div style={{
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderBottom: `1px solid ${COLOR.borderLt}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 11, color: COLOR.warn,
              letterSpacing: '0.05em', marginBottom: 2,
            }}>
              PLAN MODE
            </div>
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, fontWeight: 600,
              color: COLOR.text,
            }}>
              agent 提交了一份设计计划
            </div>
            <div style={{
              fontFamily: FONT_SANS, fontSize: 12, color: COLOR.sub,
              marginTop: 2,
            }}>
              {editing ? '编辑后再批准。SDK 在 plan mode 下不会执行任何文件改动。' : 'review 后批准开始执行；或编辑、或拒绝重新对齐。'}
            </div>
          </div>
          <button
            onClick={() => setEditing(!editing)}
            disabled={submitting}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `4px ${GAP.sm}px`,
              fontFamily: FONT_SANS, fontSize: 11,
              color: editing ? COLOR.btnText : COLOR.text2,
              background: editing ? COLOR.btn : '#fff',
              border: `1px solid ${editing ? COLOR.btn : COLOR.borderMd}`,
              borderRadius: 5,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <Edit3 size={11} /> {editing ? '预览' : '编辑'}
          </button>
        </div>

        {/* body */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: GAP.lg,
        }}>
          {editing ? (
            <textarea
              value={editedPlan}
              onChange={(e) => setEditedPlan(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 400,
                padding: GAP.md,
                fontFamily: FONT_MONO,
                fontSize: 13,
                lineHeight: 1.6,
                color: COLOR.text,
                background: '#fafafa',
                border: `1px solid ${COLOR.borderMd}`,
                borderRadius: 6,
                resize: 'vertical',
                outline: 'none',
              }}
            />
          ) : (
            <div className="plan-md" style={{
              fontFamily: FONT_SANS,
              fontSize: FONT_SIZE.base,
              color: COLOR.text2,
              lineHeight: 1.6,
            }}>
              <ReactMarkdown>{planText || ''}</ReactMarkdown>
              <style>{`
                .plan-md h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px 0; }
                .plan-md h2 { font-size: 16px; font-weight: 600; margin: 16px 0 8px 0; color: ${COLOR.text}; }
                .plan-md h3 { font-size: 14px; font-weight: 600; margin: 12px 0 6px 0; }
                .plan-md p { margin: 0 0 8px 0; }
                .plan-md ul, .plan-md ol { margin: 0 0 8px 0; padding-left: 20px; }
                .plan-md li { margin: 2px 0; }
                .plan-md code { background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 3px; font-family: ${FONT_MONO}; font-size: 12px; }
                .plan-md pre { background: ${COLOR.bgCard}; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
                .plan-md table { border-collapse: collapse; margin: 8px 0; }
                .plan-md th, .plan-md td { border: 1px solid ${COLOR.borderLt}; padding: 6px 10px; text-align: left; }
                .plan-md th { background: ${COLOR.bgCard}; font-weight: 600; }
                .plan-md strong { font-weight: 600; }
              `}</style>
            </div>
          )}
        </div>

        {/* footer buttons */}
        <div style={{
          padding: `${GAP.sm}px ${GAP.lg}px`,
          borderTop: `1px solid ${COLOR.borderLt}`,
          display: 'flex',
          alignItems: 'center',
          gap: GAP.sm,
        }}>
          <button
            onClick={handleReject}
            disabled={submitting}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `6px ${GAP.md}px`,
              fontFamily: FONT_SANS, fontSize: 12,
              color: COLOR.error,
              background: '#fff',
              border: `1px solid ${COLOR.borderMd}`,
              borderRadius: 5,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <X size={12} /> 重新对齐
          </button>
          <span style={{ flex: 1 }} />
          <button
            onClick={handleApprove}
            disabled={submitting}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: `6px ${GAP.md}px`,
              fontFamily: FONT_SANS, fontSize: 12, fontWeight: 500,
              color: COLOR.btnText,
              background: COLOR.btn,
              border: `1px solid ${COLOR.btn}`,
              borderRadius: 5,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            {editing ? <Send size={12} /> : <Check size={12} />}
            {editing ? '编辑后批准并执行' : '批准并执行'}
          </button>
        </div>
      </div>
    </div>
  );
}
