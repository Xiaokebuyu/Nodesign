import { useState, useEffect, useCallback } from 'react';
import { Lock, Pencil, Trash2 } from 'lucide-react';
import Modal, { ModalFooter } from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Memory } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * MemoryCard —— Hub 右栏卡片：项目级 agent memory 概要
 *
 * mount 列所有 agent 的 memory 概要（含 _root 顶层 + 各 agentType 子目录）。
 * 点铅笔弹 modal 编辑（用户可覆盖 agent 写的长期记忆）；点 🗑 删整个 agent
 * 子目录。
 *
 * 数据落 shared/.claude/agent-memory/，agent 通过软链 / additionalDirectories
 * 跨 session 共享读写。
 */
export default function MemoryCard({ projectId }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [memory, setMemory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await Memory.list(projectId);
      setMemory(result?.memory || []);
    } catch (err) {
      console.warn('[MemoryCard] list failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (agentType) => {
    const label = agentType || 'main agent';
    if (!window.confirm(`删除「${label}」的 memory？此操作不可撤销。`)) return;
    try {
      await Memory.remove(projectId, agentType || '_root');
      showToast('已删除', 'info');
      await refresh();
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <>
      <div style={cardStyle}>
        <div style={cardHeader}>
          <span style={cardTitle}>Memory</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px',
              background: 'rgba(45,36,24,0.05)',
              borderRadius: 4,
              fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
            }}>
              <Lock size={10} /> Only you
            </span>
            <button
              onClick={() => setEditingType('_root')}
              title="编辑顶层 memory（main agent）"
              style={iconBtnStyle}
            >
              <Pencil size={13} />
            </button>
          </div>
        </div>

        {loading && <div style={emptyHint}>加载中…</div>}

        {!loading && memory.length === 0 && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            lineHeight: 1.55,
          }}>
            agent 在 session 中按需记录的长期记忆。还没有内容。
          </div>
        )}

        {!loading && memory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xs }}>
            {memory.map(m => (
              <MemoryRow
                key={m.agentType || '_root'}
                entry={m}
                onEdit={() => setEditingType(m.agentType || '_root')}
                onDelete={() => handleDelete(m.agentType)}
              />
            ))}
          </div>
        )}
      </div>

      <MemoryEditModal
        show={!!editingType}
        onClose={() => setEditingType(null)}
        projectId={projectId}
        agentType={editingType}
        onSaved={() => refresh()}
      />
    </>
  );
}

function MemoryRow({ entry, onEdit, onDelete }) {
  const [hover, setHover] = useState(false);
  const label = entry.agentType || 'main';
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: `${GAP.xs + 1}px ${GAP.sm}px`,
        borderRadius: 6,
        background: hover ? 'rgba(0,0,0,0.025)' : 'transparent',
        transition: 'background 0.15s',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        marginBottom: 2,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, fontWeight: 500,
          color: COLOR.text,
          flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        <span style={{
          fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
        }}>
          {formatSize(entry.size)}
        </span>
        {hover && (
          <>
            <button onClick={onEdit} title="编辑" style={miniBtn}>
              <Pencil size={11} />
            </button>
            <button onClick={onDelete} title="删除" style={miniBtn}>
              <Trash2 size={11} color={COLOR.error} />
            </button>
          </>
        )}
      </div>
      {entry.preview && (
        <div style={{
          fontFamily: FONT_SANS, fontSize: 11, color: COLOR.sub,
          lineHeight: 1.5,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entry.preview.replace(/\s+/g, ' ').trim()}
        </div>
      )}
    </div>
  );
}

function MemoryEditModal({ show, onClose, projectId, agentType, onSaved }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show || !agentType) return;
    setLoading(true);
    Memory.read(projectId, agentType)
      .then(r => {
        setContent(r?.content || '');
        setInitialContent(r?.content || '');
      })
      .catch(err => showToast(`读取失败：${err.message}`, 'error'))
      .finally(() => setLoading(false));
  }, [show, projectId, agentType, showToast]);

  const dirty = content !== initialContent;
  const label = agentType === '_root' ? 'main agent' : agentType;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await Memory.write(projectId, agentType, content);
      onSaved?.();
      showToast('memory 已保存', 'success');
      onClose?.();
    } catch (err) {
      showToast(`保存失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title={`Memory — ${label || ''}`} width={680}>
      <div style={{ padding: `${GAP.md}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.md }}>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          lineHeight: 1.55,
        }}>
          agent 在 session 中按需写入的长期记忆，跨 session 共享。
          你可以手动覆盖这份内容（或删整个文件），下一轮 session agent 自动看到。
        </div>
        <textarea
          value={loading ? '加载中…' : content}
          disabled={loading}
          onChange={e => setContent(e.target.value)}
          placeholder="（空 — agent 还没记录任何 memory）"
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
          }}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onConfirm={save}
        confirmDisabled={!dirty || saving || loading}
        confirmLabel={saving ? '保存中…' : '保存'}
      />
    </Modal>
  );
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  width: 24, height: 24, borderRadius: 4,
  background: 'transparent', border: 'none',
  color: COLOR.text2,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const miniBtn = {
  width: 18, height: 18, borderRadius: 3,
  background: 'transparent', border: 'none', color: COLOR.sub,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
};
const emptyHint = {
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
};
