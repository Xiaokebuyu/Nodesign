import { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Turn } from '../../lib/api.js';

/**
 * CreateProjectModal — 新建项目向导（C30 简化）
 *
 * 流程：
 *   1. 项目名 + 初始 brief（自由文本，可附素材后由 agent 自己判断怎么用）
 *   2. 可选：展开"更详细" — 4 个结构化字段（goal / audience / keyMessages / style）
 *      参考 Claude_design §4 第 8 条：好 prompt 含 goal/layout/content/audience
 *   3. 创建并跳转
 *
 * C30 移除"自由创作 vs 参照模式"分支：现在 agent 能力够强（Claude
 * Agent SDK 内置 Read 工具 + content blocks 接附件），用户输入啥
 * 就处理啥，不需要"模式"框定（参照模式那块原本是 P6 设计文档
 * 的入口，但有附件 = 参照、没附件 = 自由的判断 agent 自己做就行）。
 */
export default function CreateProjectModal({ show, onClose, onCreated }) {
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [brief, setBrief] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [keyMessages, setKeyMessages] = useState('');
  const [stylePref, setStylePref] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // show 切换时重置
  useEffect(() => {
    if (show) {
      setName('');
      setDescription('');
      setBrief('');
      setAdvancedOpen(false);
      setGoal(''); setAudience(''); setKeyMessages(''); setStylePref('');
      setSubmitting(false);
    }
  }, [show]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    // 把结构化字段拼到 brief（agent 看 brief；前端不再单独存 details）
    const expanded = [
      brief.trim(),
      goal && `目标：${goal.trim()}`,
      audience && `受众：${audience.trim()}`,
      keyMessages && `关键消息：${keyMessages.trim()}`,
      stylePref && `风格偏好：${stylePref.trim()}`,
    ].filter(Boolean).join('\n');

    try {
      // 1. 创建项目（后端 ensureProjectWorkspace + git init）
      const proj = await createProject({
        name: name.trim() || '未命名项目',
        description: description.trim() || undefined,
      });

      // 2. 有 brief 就立即起首跑（agent 在后端异步跑，前端 Project.jsx 通过 WS 看流）
      if (expanded.trim()) {
        try {
          await Turn.send({ pid: proj.id, chat: expanded, attachments: [] });
        } catch (err) {
          showToast(`首跑触发失败：${err.message}（项目已创建，可在 chat 重发）`, 'error');
        }
      }

      onCreated?.(proj);
      onClose?.();
    } catch (err) {
      showToast(`创建失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="新建项目" width={560}>
      <div style={{ padding: GAP.xl }}>

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

        {/* 项目描述（可选 — 给你自己看的项目摘要，agent 不读这个）*/}
        <Section label="项目描述（可选 · 给团队看的项目摘要）">
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="例如：年度发布会主 deck，团队内部协作用。AI 看的是「项目背景」tab 里的 instruction。"
            rows={2}
            maxLength={2000}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: FONT_SANS, lineHeight: 1.5 }}
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

        {/* 更详细（可选）— 结构化字段 */}
        <button
          onClick={() => setAdvancedOpen(o => !o)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.sm}px`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            background: 'transparent',
            borderRadius: 4,
            marginBottom: advancedOpen ? GAP.lg : 0,
            cursor: 'pointer',
          }}
        >
          <ChevronRight
            size={11}
            style={{ transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}
          />
          更详细（可选 · 4 个结构化字段帮 agent 抓重点）
        </button>

        {advancedOpen && (
          <div style={{
            padding: GAP.lg,
            background: COLOR.bgCard,
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 8,
            marginBottom: GAP.lg,
            display: 'flex', flexDirection: 'column', gap: GAP.md,
          }}>
            <Field label="目标（goal）" placeholder="比如：说服客户接受 Q3 报价方案" value={goal} onChange={setGoal} />
            <Field label="受众（audience）" placeholder="比如：技术 leader + 财务 leader 各一位" value={audience} onChange={setAudience} />
            <Field
              label="关键消息（key messages）"
              placeholder="3 条核心信息，逗号或换行分隔"
              value={keyMessages}
              onChange={setKeyMessages}
              multiline
            />
            <Field label="风格偏好（style）" placeholder="比如：理性克制、不要 emoji、配色低饱和" value={stylePref} onChange={setStylePref} />
            <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub, lineHeight: 1.5 }}>
              填了的字段会拼进 brief 一起送给 agent；不填也没事，brief 自由文本就够了。
            </div>
          </div>
        )}

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
        confirmLabel={submitting ? '创建中…' : '创建并打开'}
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

function Field({ label, value, onChange, placeholder, multiline }) {
  const Comp = multiline ? 'textarea' : 'input';
  const commonStyle = {
    width: '100%',
    padding: `${GAP.sm}px ${GAP.md}px`,
    fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
    color: COLOR.text,
    background: '#fff',
    border: `1px solid ${COLOR.borderMd}`,
    borderRadius: 6,
    outline: 'none',
    boxSizing: 'border-box',
  };
  return (
    <div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: 4,
      }}>{label}</div>
      <Comp
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={multiline ? 2 : undefined}
        style={multiline ? { ...commonStyle, resize: 'vertical', lineHeight: 1.5 } : commonStyle}
      />
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
};
