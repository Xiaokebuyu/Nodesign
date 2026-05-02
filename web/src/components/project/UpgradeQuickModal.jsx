import { useState, useEffect } from 'react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * UpgradeQuickModal — 把闪聊（kind='quick'）升级为标准项目（kind='project'）
 *
 * 触发：Workspace 顶栏 ⋯ 菜单「升级为项目」（仅闪聊项目可见）
 * 行为：PATCH name + description + kind='project' → 该项目从此出现在 Home 网格
 *
 * 不复用 CreateProjectModal —— 语义是 update 不是 create，预填项目名（闪聊
 * 自动取 prompt 前 30 字命的名往往太长 / 太随意，让用户在升级时整理一下）。
 */
export default function UpgradeQuickModal({ show, onClose, project, onUpgraded }) {
  const upgradeQuickProject = useProjectStore(s => s.upgradeQuickProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // show 切换时用 project 字段预填
  useEffect(() => {
    if (show && project) {
      setName(project.name || '');
      setDescription(project.description || '');
      setSubmitting(false);
    }
  }, [show, project]);

  const submit = async () => {
    if (submitting) return;
    const finalName = name.trim();
    if (!finalName) {
      showToast('项目名必填', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await upgradeQuickProject(project.id, {
        name: finalName,
        description: description.trim() || null,
      });
      onUpgraded?.(updated);
      onClose?.();
    } catch (err) {
      showToast(`升级失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  if (!project) return null;

  return (
    <Modal show={show} onClose={onClose} title="升级为项目" width={520}>
      <div style={{ padding: GAP.xl }}>
        <div style={{
          padding: GAP.md,
          background: 'rgba(45,36,24,0.04)',
          border: `1px solid ${COLOR.borderLt}`,
          borderRadius: 8,
          marginBottom: GAP.xl,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
          lineHeight: 1.55,
        }}>
          升级后这个项目会出现在 Home「我的项目」网格里。所有会话、记忆、文件、
          指引保留不变；你随时可以继续在这里工作。
        </div>

        <Section label="项目名">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="给这个项目起个名字"
            style={inputStyle}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </Section>

        <Section label="项目描述（可选）">
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="给团队看的项目摘要（agent 不读）"
            rows={3}
            maxLength={2000}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT_SANS, lineHeight: 1.5 }}
          />
        </Section>
      </div>

      <ModalFooter
        onCancel={onClose}
        onConfirm={submit}
        confirmLabel={submitting ? '升级中…' : '升级为项目'}
        confirmDisabled={submitting}
      />
    </Modal>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: GAP.xl }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: GAP.sm,
      }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: `${GAP.md}px ${GAP.lg}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.base,
  color: COLOR.text,
  background: '#fff',
  border: `1px solid ${COLOR.borderMd}`,
  borderRadius: 8,
  outline: 'none',
  boxSizing: 'border-box',
};
