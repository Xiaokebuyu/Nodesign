import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowUp, MoreHorizontal, Pin, Plus,
  GitBranch, Edit2, Trash2, Tag as TagIcon,
} from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import InstructionsCard from '../components/project/InstructionsCard.jsx';
import FilesCard from '../components/project/FilesCard.jsx';
import MemoryCard from '../components/project/MemoryCard.jsx';
import BrandCard from '../components/project/BrandCard.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Sessions } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * ProjectHub —— 项目控制台二级页（参考 Anthropic Projects 二级页面布局）
 *
 * URL: /projects/:id
 *
 * 两栏布局（max-width 1200，桌面）：
 *   ┌─ 左主体 (flex) ────────────────────────────────────┐  ┌─ 右栏 (340px) ──┐
 *   │ ← All projects                                     │  │  Memory          │
 *   │ <项目名>                                  [⋯][📌] │  │  Instructions    │
 *   │ <description>                                       │  │  Files           │
 *   │                                                     │  │                  │
 *   │ ┌─────── input box ────────────────────────┐       │  │                  │
 *   │ │ How can I help you today?                 │       │  │                  │
 *   │ │ [+]                  [model][↑]            │       │  │                  │
 *   │ └────────────────────────────────────────────┘       │  │                  │
 *   │                                                     │  │                  │
 *   │ <session list, 无边框分隔, 间距宽松>                │  │                  │
 *   └─────────────────────────────────────────────────────┘  └─────────────────┘
 *
 * H2 完成两栏布局 + input box + sessions list 风格对齐参考图
 * H3 把右栏三卡片接通后端（Instruction / Memory / Files）
 */
export default function ProjectHub() {
  const { id } = useParams();
  const navigate = useNavigate();
  const project = useProjectStore(s => s.projects.find(p => p.id === id));
  const hydrateOne = useProjectStore(s => s.hydrateOne);
  const [hydrated, setHydrated] = useState(false);
  const [hydrateError, setHydrateError] = useState(null);
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setHydrateError(null);
    hydrateOne(id)
      .then(() => { if (!cancelled) setHydrated(true); })
      .catch((err) => { if (!cancelled) { setHydrated(true); setHydrateError(err); } });
    return () => { cancelled = true; };
  }, [id, hydrateOne]);

  const reloadSessions = useCallback(async () => {
    try {
      const { sessions: list = [] } = await Sessions.list(id, { limit: 50 });
      setSessions(list);
    } catch (err) {
      console.warn('[Hub] reload sessions failed:', err.message);
    }
  }, [id]);

  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    reloadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, hydrateError, project?.id]);

  if (!hydrated) {
    return (
      <AppShell breadcrumb={[{ label: '加载中...' }]}>
        <div style={loadingStyle}>加载项目中…</div>
      </AppShell>
    );
  }
  if (hydrateError || !project) {
    return (
      <AppShell breadcrumb={[{ label: '未找到' }]}>
        <div style={loadingStyle}>项目不存在或已删除。</div>
      </AppShell>
    );
  }

  const handleStart = (text) => {
    if (text && text.trim()) {
      navigate(`/projects/${id}/work`, { state: { initialMessage: text.trim() } });
    } else {
      navigate(`/projects/${id}/work`);
    }
  };

  return (
    <AppShell breadcrumb={[{ label: '项目', to: '/' }, { label: project.name }]}>
      <div style={{
        maxWidth: 1200, margin: '0 auto',
        padding: `${GAP.xl}px ${GAP.page}px`,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 340px',
        gap: GAP.xxl,
        alignItems: 'start',
      }}>
        {/* ── 左主体 ── */}
        <div style={{ minWidth: 0 }}>
          <Link to="/" style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            padding: `${GAP.xs}px 0`,
            marginBottom: GAP.lg,
            textDecoration: 'none',
          }}>
            <ArrowLeft size={14} /> 全部项目
          </Link>

          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: GAP.md,
            marginBottom: GAP.sm,
          }}>
            <h1 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em',
              margin: 0,
              minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{project.name}</h1>
            <div style={{ display: 'flex', gap: GAP.xs, flexShrink: 0 }}>
              <IconButton icon={<MoreHorizontal size={14} />} title="更多操作" disabled />
              <IconButton icon={<Pin size={14} />} title="钉到首页（占位）" disabled />
            </div>
          </div>

          {project.description && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
              color: COLOR.text2, lineHeight: 1.55,
              marginBottom: GAP.xl,
            }}>
              {project.description}
            </div>
          )}

          <HubInput onStart={handleStart} />

          <SessionList projectId={id} sessions={sessions} onRefresh={reloadSessions} />
        </div>

        {/* ── 右栏 cards（H4b 真接通后端） ── */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          gap: GAP.lg,
          position: 'sticky',
          top: GAP.xl,
        }}>
          <MemoryCard projectId={id} />
          <InstructionsCard projectId={id} />
          <BrandCard projectId={id} />
          <FilesCard projectId={id} />
        </div>
      </div>
    </AppShell>
  );
}

// ── HubInput ──

/**
 * Hub 主入口的输入框：参考图样式。
 * Enter 跳 Workspace 并 auto-send；空文本时点按钮 = 直接进工作台。
 */
function HubInput({ onStart }) {
  const [text, setText] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [text]);

  const submit = () => {
    onStart?.(text);
    setText('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim();

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 16,
      padding: `${GAP.lg}px ${GAP.lg}px ${GAP.md}px`,
      marginBottom: GAP.xxl,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'border-color 0.15s, box-shadow 0.15s',
    }}>
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder="今天我能帮你做什么？"
        rows={1}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          resize: 'none',
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.lg,
          lineHeight: 1.55,
          color: COLOR.text,
          padding: `${GAP.sm}px 0 ${GAP.md}px`,
          maxHeight: 280,
          minHeight: 32,
          overflow: 'auto',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
        <button
          title="附加资料（占位 — 在工作台内上传）"
          disabled
          style={{
            width: 28, height: 28, borderRadius: 14,
            background: 'transparent',
            border: `1px solid ${COLOR.borderLt}`,
            color: COLOR.sub,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'not-allowed',
            opacity: 0.6,
          }}
        >
          <Plus size={14} />
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={submit}
          title={empty ? '直接进入工作台' : '发送（Enter）'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: COLOR.btnText,
            background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`,
            borderRadius: 10,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = COLOR.btnHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = COLOR.btn; }}
        >
          {empty ? '进入工作台' : '发送'}
          <ArrowUp size={13} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

// ── SessionList ── 参考图无边框 list view，每条间距宽松。
// hover 出 ⋯ 菜单：Fork / 重命名 / 设置标签 / 删除（与 SessionListModal 同 4 操作）。

function SessionList({ projectId, sessions, onRefresh }) {
  const navigate = useNavigate();
  const showToast = useGlobalStore(s => s.showToast);
  const [menuOpenSid, setMenuOpenSid] = useState(null);

  if (sessions.length === 0) {
    return (
      <div style={{
        padding: `${GAP.xl}px 0`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
      }}>
        还没有会话——上方输入框开始第一个对话。
      </div>
    );
  }

  const handleDelete = async (s) => {
    setMenuOpenSid(null);
    const title = s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8);
    if (!window.confirm(`删除会话「${title}」？此操作不可撤销。`)) return;
    try {
      await Sessions.remove(projectId, s.sessionId);
      showToast('已删除', 'info');
      onRefresh?.();
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  const handleRename = async (s) => {
    setMenuOpenSid(null);
    const next = window.prompt('重命名会话：', s.customTitle || s.summary || '');
    if (next == null || !next.trim()) return;
    try {
      await Sessions.update(projectId, s.sessionId, { title: next.trim() });
      showToast('已重命名', 'success');
      onRefresh?.();
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
      onRefresh?.();
    } catch (err) {
      showToast(`设置标签失败：${err.message}`, 'error');
    }
  };

  const handleFork = async (s) => {
    setMenuOpenSid(null);
    try {
      const { sessionId: newSid } = await Sessions.fork(projectId, s.sessionId, {
        title: `${s.customTitle || s.summary || 'session'} (fork)`,
      });
      showToast('已 fork 新会话', 'success');
      navigate(`/projects/${projectId}/sessions/${newSid}`);
    } catch (err) {
      showToast(`Fork 失败：${err.message}`, 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sessions.map((s, i) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          isFirst={i === 0}
          projectId={projectId}
          menuOpen={menuOpenSid === s.sessionId}
          onMenuToggle={() => setMenuOpenSid(menuOpenSid === s.sessionId ? null : s.sessionId)}
          onMenuClose={() => setMenuOpenSid(null)}
          onFork={() => handleFork(s)}
          onRename={() => handleRename(s)}
          onTag={() => handleTag(s)}
          onDelete={() => handleDelete(s)}
        />
      ))}
    </div>
  );
}

function SessionRow({
  session: s, isFirst, projectId,
  menuOpen, onMenuToggle, onMenuClose,
  onFork, onRename, onTag, onDelete,
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); onMenuClose?.(); }}
      style={{
        position: 'relative',
        borderTop: isFirst ? 'none' : `1px solid ${COLOR.borderLt}`,
      }}
    >
      <Link
        to={`/projects/${projectId}/sessions/${s.sessionId}`}
        style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: `${GAP.lg}px 0`,
          paddingLeft: hover ? GAP.sm : 0,
          paddingRight: hover ? 44 : 0,  // 让出 ⋯ 按钮空间
          textDecoration: 'none',
          background: hover ? 'rgba(0,0,0,0.018)' : 'transparent',
          transition: 'background 0.15s, padding-left 0.15s, padding-right 0.15s',
        }}
      >
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
          color: COLOR.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8)}
        </div>
        <div style={{
          display: 'flex', gap: GAP.sm, alignItems: 'center',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        }}>
          <span>最后消息 {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}</span>
          {s.tag && (
            <span style={{
              padding: '1px 6px',
              background: 'rgba(45,36,24,0.06)',
              borderRadius: 3,
              color: COLOR.text2,
              fontFamily: FONT_MONO,
            }}>{s.tag}</span>
          )}
        </div>
      </Link>
      {hover && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMenuToggle(); }}
          title="操作"
          style={{
            position: 'absolute',
            top: '50%', right: GAP.sm,
            transform: 'translateY(-50%)',
            width: 28, height: 28, borderRadius: 6,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 2,
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      {menuOpen && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% - 8px)', right: GAP.sm,
            minWidth: 140,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
            padding: 4,
            zIndex: 5,
          }}
        >
          <SessionMenuItem icon={<GitBranch size={12} />} label="Fork" onClick={onFork} />
          <SessionMenuItem icon={<Edit2 size={12} />} label="重命名" onClick={onRename} />
          <SessionMenuItem icon={<TagIcon size={12} />} label="设置标签" onClick={onTag} />
          <SessionMenuItem icon={<Trash2 size={12} />} label="删除" onClick={onDelete} danger />
        </div>
      )}
    </div>
  );
}

function SessionMenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(e); }}
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

function IconButton({ icon, title, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 30, height: 30, borderRadius: 6,
        background: 'transparent',
        border: 'none',
        color: disabled ? COLOR.dim : COLOR.text2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'rgba(0,0,0,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
    </button>
  );
}

const loadingStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '60vh',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
};
