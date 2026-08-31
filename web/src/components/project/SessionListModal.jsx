import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, GitBranch, Edit2, Tag as TagIcon, Trash2, MoreHorizontal, Check } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';
import { Sessions } from '../../lib/api.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { timeAgo } from '../../lib/helpers.js';
import { useHoverReveal } from '../../lib/use-hover-reveal.js';

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
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);
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
    const next = await prompt({
      title: '重命名会话',
      initialValue: s.customTitle || s.summary || '',
      placeholder: '会话标题',
      validate: (v) => v.trim() ? null : '不能为空',
    });
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
    const next = await prompt({
      title: '会话标签',
      message: '留空清除标签',
      initialValue: s.tag || '',
      placeholder: '标签',
    });
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
    if (!(await confirm({
      title: '删除会话',
      message: `删除会话「${title}」？它的任务文件夹和里面的产出会一起删掉（任务和会话一对一，不单独存在）。此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return;
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
            borderRadius: RADIUS.lg,
            cursor: 'pointer',
            marginBottom: GAP.md,
          }}
        >
          <Plus size={14} />
          + 新会话
          <span style={{
            marginLeft: 'auto', fontSize: FONT_SIZE.xs, opacity: 0.7, fontFamily: FONT_MONO,
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
            borderRadius: RADIUS.lg,
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
  const { revealed, hoverProps } = useHoverReveal({ onLeave: () => { if (!menuOpen) onMenuClose?.(); } });
  // 菜单曾经是 absolute 挂在行里 → 被列表的 overflow 裁掉，得滚动才看得见，
  // 而一滚鼠标离开行菜单又关了。改成 fixed + 按钮实际坐标（2026-07-28）
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => onMenuClose?.();
    const onDown = (e) => { if (!e.target.closest?.('[data-session-menu]')) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menuOpen, onMenuClose]);

  useEffect(() => { if (!menuOpen) setMenuPos(null); }, [menuOpen]);

  // 渲染出来再按真实高度夹回视口内（估高度容易估错，量一次最准）
  useEffect(() => {
    if (!menuOpen || !menuPos || !menuRef.current) return;
    const h = menuRef.current.getBoundingClientRect().height;
    const maxTop = window.innerHeight - h - 8;
    if (menuPos.top > maxTop) setMenuPos(prev => ({ ...prev, top: Math.max(8, maxTop) }));
  }, [menuOpen, menuPos]);
  const title = session.customTitle || session.summary || session.firstPrompt || session.sessionId.slice(0, 8);
  const ts = session.lastModified ? timeAgo(new Date(session.lastModified).toISOString()) : '';

  return (
    <div
      {...hoverProps}
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
          background: isCurrent ? 'rgba(43,33,23,0.04)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'rgba(43,33,23,0.025)'; }}
        onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
      >
        <div style={{
          width: 14, height: 14, flexShrink: 0, marginTop: GAP.xxs,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {isCurrent && <Check size={12} color={COLOR.success} strokeWidth={2.25} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 500,
            color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginBottom: GAP.xxs,
          }}>
            {title}
          </div>
          <div style={{
            display: 'flex', gap: GAP.sm, alignItems: 'center',
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            <span>{ts}</span>
            {session.tag && (
              <span style={{
                padding: `1px ${GAP.sm}px`,
                background: 'rgba(43,33,23,0.06)',
                borderRadius: RADIUS.xs,
                color: COLOR.text2,
              }}>
                {session.tag}
              </span>
            )}
            <span style={{ opacity: 0.6 }}>{session.sessionId.slice(0, 8)}</span>
          </div>
        </div>
      </button>
      {revealed && (
        <button
          data-session-menu
          onClick={(e) => {
            e.stopPropagation();
            // 用点击点定位：菜单渲染在 body 坐标系（fixed），躲开列表的 overflow 裁剪
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
            onMenuToggle();
          }}
          title="操作"
          style={{
            position: 'absolute',
            top: GAP.md, right: GAP.md,
            width: 26, height: 26, borderRadius: RADIUS.sm,
            background: 'rgba(255,254,246,0.95)',
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
      {menuOpen && menuPos && createPortal((
        <div
          data-session-menu
          ref={menuRef}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: menuPos.top, right: menuPos.right,
            minWidth: 140,
            background: COLOR.bgWhite,
            borderRadius: RADIUS.md,
            boxShadow: SHADOW.pop,
            padding: GAP.xs,
            zIndex: 1200,
          }}>
          <MenuItem icon={<GitBranch size={12} />} label="Fork" onClick={onFork} />
          <MenuItem icon={<Edit2 size={12} />} label="重命名" onClick={onRename} />
          <MenuItem icon={<TagIcon size={12} />} label="设置标签" onClick={onTag} />
          <MenuItem icon={<Trash2 size={12} />} label="删除" onClick={onDelete} danger />
        </div>
      ), document.body)}
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
        borderRadius: RADIUS.sm,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(43,33,23,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon} {label}
    </button>
  );
}
