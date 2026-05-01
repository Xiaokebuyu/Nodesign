import { useState, useEffect, useRef } from 'react';
import { Save, Loader2 } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Instruction } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * BackgroundTab —— 项目背景编辑器
 *
 * 直接读写 workspace/.claude/CLAUDE.md（GET/PUT /api/projects/:pid/instruction）。
 * 这是 agent 进每次 session 自动读到的项目级指令（S1 启用了
 * settingSources: ['project']，SDK 把 CLAUDE.md append 到 system prompt）。
 *
 * 区别于项目 description（NoDesign 自管，仅 UI 用，agent 不读）：
 *   - description ＝ 给团队看的项目摘要（项目卡片显示）
 *   - 项目背景（CLAUDE.md）＝ 给 AI 看的项目指令（每次 session 自动加载）
 *
 * UI：
 *   - 顶部说明 + 文件路径
 *   - textarea 占满空间
 *   - 底部保存按钮（dirty 时高亮）+ saved 状态
 */
export default function BackgroundTab({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const cancelRef = useRef(false);

  // mount / pid 变化时拉
  useEffect(() => {
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    Instruction.read(projectId)
      .then(({ content: c }) => {
        if (cancelRef.current) return;
        setContent(c || '');
        setSavedContent(c || '');
        setLoading(false);
      })
      .catch(err => {
        if (cancelRef.current) return;
        setError(err.message || 'load failed');
        setLoading(false);
      });
    return () => { cancelRef.current = true; };
  }, [projectId]);

  const dirty = content !== savedContent;
  const empty = content.trim().length === 0;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await Instruction.write(projectId, content);
      setSavedContent(content);
      showToast('项目背景已保存', 'success');
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: GAP.lg, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
        加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: GAP.lg, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.error }}>
        加载失败：{error}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: 0,
      padding: GAP.lg,
      gap: GAP.sm,
    }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
        color: COLOR.text,
      }}>项目背景</div>
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        lineHeight: 1.5,
      }}>
        AI 进每次 session 自动读到这里写的指令（设计风格、品牌约束、受众等）。
        保存后下一轮对话生效。<span style={{ color: COLOR.dim }}>workspace/.claude/CLAUDE.md</span>
      </div>

      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="# 项目说明..."
        style={{
          flex: 1,
          minHeight: 280,
          padding: GAP.md,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
          color: COLOR.text, lineHeight: 1.55,
          background: '#fff',
          border: `1px solid ${COLOR.borderMd}`,
          borderRadius: 6,
          outline: 'none',
          resize: 'none',
          boxSizing: 'border-box',
          whiteSpace: 'pre-wrap',
        }}
      />

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: GAP.sm,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10,
          color: dirty ? COLOR.warn : COLOR.sub,
        }}>
          {empty ? '空（agent 不会看到任何项目指令）'
            : dirty ? '未保存的修改'
            : '已保存'}
        </span>
        <button
          onClick={save}
          disabled={!dirty || saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: !dirty || saving ? COLOR.sub : COLOR.btnText,
            background: !dirty || saving ? 'rgba(0,0,0,0.05)' : COLOR.btn,
            border: `1px solid ${!dirty || saving ? COLOR.borderMd : COLOR.btn}`,
            borderRadius: 6,
            cursor: !dirty || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving
            ? <Loader2 size={12} style={{ animation: 'nd-bg-spin 1s linear infinite' }} />
            : <Save size={12} />}
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <style>{`@keyframes nd-bg-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
