import { useState, useEffect } from 'react';
import { Plus, GitBranch, Edit2, Tag as TagIcon, Trash2, MoreHorizontal, Check } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Sessions } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { timeAgo } from '../../lib/helpers.js';

/**
 * SessionListModal —— 项目内 session 历史列表（S4）
 *
 * 列出 SDK listSessions 返回的所有 session（按 lastModified 倒序）。
 * 用户可：
 *   - 切换到某 session（click row 主体 → onSwitch(sid) → 关 modal）
 *   - 开新会话（点 "+ 新会话" → onSwitch(null) → 下次发 chat 时 SDK 自动建新 sid）
 *   - 每条 session 的 ⋯ 菜单：fork（复制完整内容到新 session）/ rename / tag / delete
 *
 * 当前会话用 ✓ 标识。
 */
export default function SessionListModal({
  show,
  onClose,
  projectId,
  currentSessionId,
  onSwitch,
}) {
  const showToast = useGlobalStore(s => s.showToast);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [menuOpenSid, setMenuOpenSid] = useState(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const { sessions: list = [] } = await Sessions.list(projectId, { limit: 50 });
      setSessions(list);
    } catch (err) {
      setError(err.message || 'load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!show || !projectId) return;
    reload();
    setMenuOpenSid(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, projectId]);

  const handleNew = () => {
    onSwitch?.(null);
    onClose?.();
  };

  const handleSwitch = (sid) => {
    if (sid === currentSessionId) {
      onClose?.();
      return;
    }
    onSwitch?.(sid);
    onClose?.();
  };

  const handleFork = async (s) => {
    setMenuOpenSid(null);
    try {
      const { sessionId } = await Sessions.fork(projectId, s.sessionId, {
        title: `${s.customTitle || s.summary || 'session'} (fork)`,
      });
      showToast('已 fork 新会话', 'success');
      await reload();
      onSwitch?.(sessionId);
      onClose?.();
    } catch (err) {
      showToast(`Fork 失败：${err.message}`, 'error');
    }
  };

  const handleRename = async (s) => {
    setMenuOpenSid(null);
    const next = window.prompt('重命名会话：', s.customTitle || s.summary || '');
    if (next == null || !next.trim()) return;
    try {
      await Sessions.update(projectId, s.sessionId, { title: next.trim() });
      showToast('已重命名', 'success');
      await reload();
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };

  const handleTag = async (s) => {
    setMenuOpenSid(null);
    const next = window.prompt('标签（留空清除）：', s.tag || '');
    if (next == null) return;
    const tag = next.trim() ? next.trim() : null;
    try {
      await Sessions.update(projectId, s.sessionId, { tag });
      showToast(tag ? `标签设为「${tag}」` : '已清除标签', 'success');
      await reload();
    } catch (err) {
      showToast(`设置标签失败：${err.message}`, 'error');
    }
  };

  const handleDelete = async (s) => {
    setMenuOpenSid(null);
    const title = s.customTitle || s.summary || s.sessionId.slice(0, 8);
    if (!window.confirm(`删除会话「${title}」？此操作不可撤销。`)) return;
    try {
      await Sessions.remove(projectId, s.sessionId);
      showToast('已删除', 'info');
      // 删的是当前 session → 切到 null（"新会话"待用户发起）
      if (s.sessionId === currentSessionId) {
        onSwitch?.(null);
      }
      await reload();
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <Modal show={show} onClose={onClose} title="会话历史" width={560}>
      <div style={{ padding: `${GAP.md}px ${GAP.lg}px` }}>
        <button
          onClick={handleNew}
          style={{
            display: 'flex', alignItems: 'center', gap: GAP.sm,
            width: '100%',
            padding: `${GAP.md}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: COLOR.btnText,
            background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`,
            borderRadius: 8,
            cursor: 'pointer',
            marginBottom: GAP.md,
          }}
        >
          <Plus size={14} />
          + 新会话
          <span style={{
            marginLeft: 'auto', fontSize: 10, opacity: 0.7, fontFamily: FONT_MONO,
          }}>下次发送时创建</span>
        </button>

        {loading && (
          <div style={{ padding: GAP.lg, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
            加载中…
          </div>
        )}
        {error && (
          <div style={{ padding: GAP.lg, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.error }}>
            加载失败：{error}
          </div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <div style={{ padding: GAP.lg, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, textAlign: 'center' }}>
            还没有会话历史。在下方对话框输入开始第一个会话。
          </div>
        )}
        {!loading && !error && sessions.length > 0 && (
          <div style={{
            maxHeight: 460,
            overflow: 'auto',
            border: `1px solid ${COLOR.borderLt}`,
            borderRadius: 8,
          }}>
            {sessions.map(s => (
              <SessionRow
                key={s.sessionId}
                session={s}
                isCurrent={s.sessionId === currentSessionId}
                menuOpen={menuOpenSid === s.sessionId}
                onMenuToggle={() => setMenuOpenSid(menuOpenSid === s.sessionId ? null : s.sessionId)}
                onMenuClose={() => setMenuOpenSid(null)}
                onSwitch={() => handleSwitch(s.sessionId)}
                onFork={() => handleFork(s)}
                onRename={() => handleRename(s)}
                onTag={() => handleTag(s)}
                onDelete={() => handleDelete(s)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SessionRow({ session, isCurrent, menuOpen, onMenuToggle, onMenuClose, onSwitch, onFork, onRename, onTag, onDelete }) {
  const [hover, setHover] = useState(false);
  const title = session.customTitle || session.summary || session.firstPrompt || session.sessionId.slice(0, 8);
  const ts = session.lastModified ? timeAgo(new Date(session.lastModified).toISOString()) : '';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); onMenuClose?.(); }}
      style={{ position: 'relative', borderBottom: `1px solid ${COLOR.borderLt}` }}
    >
      <button
        onClick={onSwitch}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
          width: '100%',
          padding: `${GAP.md}px ${GAP.lg}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          color: COLOR.text2,
          background: isCurrent ? 'rgba(45,36,24,0.04)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'rgba(0,0,0,0.025)'; }}
        onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
      >
        <div style={{
          width: 14, height: 14, flexShrink: 0, marginTop: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {isCurrent && <Check size={12} color={COLOR.success} strokeWidth={2.25} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 500,
            color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginBottom: 2,
          }}>
            {title}
          </div>
          <div style={{
            display: 'flex', gap: GAP.sm, alignItems: 'center',
            fontFamily: FONT_MONO, fontSize: 10, color: COLOR.sub,
          }}>
            <span>{ts}</span>
            {session.tag && (
              <span style={{
                padding: '1px 6px',
                background: 'rgba(45,36,24,0.06)',
                borderRadius: 3,
                color: COLOR.text2,
              }}>
                {session.tag}
              </span>
            )}
            <span style={{ opacity: 0.6 }}>{session.sessionId.slice(0, 8)}</span>
          </div>
        </div>
      </button>
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onMenuToggle(); }}
          title="操作"
          style={{
            position: 'absolute',
            top: GAP.md, right: GAP.md,
            width: 26, height: 26, borderRadius: 4,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 2,
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      )}
      {menuOpen && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 40, right: GAP.md,
            minWidth: 140,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
            padding: 4,
            zIndex: 5,
          }}>
          <MenuItem icon={<GitBranch size={12} />} label="Fork" onClick={onFork} />
          <MenuItem icon={<Edit2 size={12} />} label="重命名" onClick={onRename} />
          <MenuItem icon={<TagIcon size={12} />} label="设置标签" onClick={onTag} />
          <MenuItem icon={<Trash2 size={12} />} label="删除" onClick={onDelete} danger />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md + 2}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: danger ? COLOR.error : COLOR.text2,
        background: 'transparent',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon} {label}
    </button>
  );
}
