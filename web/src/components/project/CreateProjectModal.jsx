import { useState, useEffect } from 'react';
import { Sparkles, FileText } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useProjectStore } from '../../stores/projectStore.js';

/**
 * CreateProjectModal — 新建项目向导
 *
 * 流程：
 *   1. 选模式（自由创作 / 参照模式 — 后者标 P6 占位）
 *   2. 项目名 + 初始 brief
 *   3. 创建并跳转
 */
export default function CreateProjectModal({ show, onClose, onCreated, initialMode = 'free' }) {
  const createProject = useProjectStore(s => s.createProject);
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');

  // show 切换时重置
  useEffect(() => {
    if (show) {
      setMode(initialMode);
      setName('');
      setBrief('');
    }
  }, [show, initialMode]);

  const submit = () => {
    const proj = createProject({
      name: name.trim() || '未命名项目',
      brief: brief.trim(),
      mode,
    });
    onCreated?.(proj);
    onClose?.();
  };

  return (
    <Modal show={show} onClose={onClose} title="新建项目" width={560}>
      <div style={{ padding: GAP.xl }}>

        {/* 模式选择 */}
        <Section label="创作模式">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP.md }}>
            <ModeCard
              icon={<Sparkles size={18} color={COLOR.btn} />}
              title="自由创作"
              desc="输入 brief，agent 从 metaphor 推审美生成"
              selected={mode === 'free'}
              onClick={() => setMode('free')}
            />
            <ModeCard
              icon={<FileText size={18} color={COLOR.brown} />}
              title="参照模式"
              desc="基于已有设计系统生成（P6 实现）"
              selected={mode === 'reference'}
              onClick={() => setMode('reference')}
              disabled
            />
          </div>
        </Section>

        {/* 项目名 */}
        <Section label="项目名">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例如：Q3 产品发布会 deck"
            style={inputStyle}
            autoFocus
          />
        </Section>

        {/* 初始 brief */}
        <Section label="初始 brief（可选）">
          <textarea
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="描述你想做什么 deck、给谁看、传达什么；之后还能在项目里继续聊"
            rows={4}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT_SANS, lineHeight: 1.5 }}
          />
        </Section>

        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          marginTop: GAP.sm,
        }}>
          创建后会进入工作台，资料 / 引用 / 微调都在那里继续。
        </div>
      </div>

      <ModalFooter
        onCancel={onClose}
        onConfirm={submit}
        confirmLabel="创建并打开"
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

function ModeCard({ icon, title, desc, selected, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        textAlign: 'left',
        padding: GAP.lg,
        background: selected ? 'rgba(45,36,24,0.05)' : '#fff',
        border: `1.5px solid ${selected ? COLOR.btn : COLOR.borderLt}`,
        borderRadius: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s',
      }}
    >
      <div style={{ marginBottom: GAP.sm }}>{icon}</div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, fontWeight: 600,
        color: COLOR.text, marginBottom: 2,
      }}>{title}</div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        lineHeight: 1.5,
      }}>{desc}</div>
    </button>
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
};
