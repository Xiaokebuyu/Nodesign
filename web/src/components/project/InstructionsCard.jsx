import { useState, useEffect, useCallback } from 'react';
import { Pencil, Save, Loader2 } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Instruction } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * InstructionsCard —— Hub 右栏卡片：项目级 instruction（.claude/CLAUDE.md）
 *
 * mount 时读 GET /instruction 显示 preview。点铅笔弹 modal 编辑 textarea
 * → PUT 保存 → 关 modal + 刷新。
 *
 * agent 进每次 session 由 SDK settingSources: ['project'] 自动加载这份文件
 * 到 system prompt（H3 软链让 agent 跨目录看到 shared/.claude/CLAUDE.md）。
 */
export default function InstructionsCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await Instruction.read(projectId);
      setContent(result?.content || '');
      setExists(!!result?.exists);
    } catch (err) {
      console.warn('[InstructionsCard] read failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const isEmpty = !content.trim();
  const preview = isEmpty
    ? 'Add instructions to tailor Claude\'s responses'
    : content.replace(/^#+ .*\n+/g, '').slice(0, 240);

  return (
    <>
      <div style={cardStyle}>
        <div style={cardHeader}>
          <span style={cardTitle}>Instructions</span>
          <button
            onClick={() => setEditOpen(true)}
            disabled={loading}
            title="编辑项目指令"
            style={iconBtnStyle}
          >
            <Pencil size={13} />
          </button>
        </div>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          color: isEmpty ? COLOR.sub : COLOR.text2,
          lineHeight: 1.55,
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {loading ? '加载中…' : preview}
        </div>
      </div>

      <InstructionEditModal
        show={editOpen}
        onClose={() => setEditOpen(false)}
        projectId={projectId}
        initialContent={content}
        onSaved={(next) => {
          setContent(next);
          setExists(true);
          showToast('项目指令已保存', 'success');
        }}
      />
    </>
  );
}

function InstructionEditModal({ show, onClose, projectId, initialContent, onSaved }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState(initialContent || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (show) setContent(initialContent || '');
  }, [show, initialContent]);

  const dirty = content !== initialContent;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await Instruction.write(projectId, content);
      onSaved?.(content);
      onClose?.();
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="项目背景（Instructions）" width={680}>
      <div style={{ padding: `${GAP.md}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.md }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.55,
        }}>
          AI 进每次 session 自动读这份指令到 system prompt（设计风格、品牌约束、
          受众、不要做什么）。保存后下一轮对话生效。
          <span style={{ color: COLOR.dim, marginLeft: GAP.sm, fontFamily: FONT_MONO, fontSize: 10 }}>
            shared/.claude/CLAUDE.md
          </span>
        </div>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="# 项目说明..."
          style={{
            width: '100%',
            minHeight: 360,
            padding: GAP.md,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm,
            color: COLOR.text, lineHeight: 1.55,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 8,
            outline: 'none',
            resize: 'vertical',
            boxSizing: 'border-box',
            whiteSpace: 'pre-wrap',
          }}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onConfirm={save}
        confirmDisabled={!dirty || saving}
        confirmLabel={
          saving
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Loader2 size={12} style={{ animation: 'i-edit-spin 1s linear infinite' }} /> 保存中…
              </span>
            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Save size={12} /> 保存
              </span>
        }
      />
      <style>{`@keyframes i-edit-spin { to { transform: rotate(360deg); } }`}</style>
    </Modal>
  );
}

const cardStyle = {
  background: '#fff',
  border: `1px solid ${COLOR.borderLt}`,
  borderRadius: 12,
  padding: GAP.lg,
};
const cardHeader = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: GAP.sm,
  marginBottom: GAP.sm,
};
const cardTitle = {
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
  color: COLOR.text,
};
const iconBtnStyle = {
  width: 26, height: 26, borderRadius: 4,
  background: 'transparent',
  border: 'none',
  color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
