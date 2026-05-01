import { useEffect, useState, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUp, MoreHorizontal, Pin, Plus, Lock, Pencil, FileText } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
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

  useEffect(() => {
    if (!hydrated || hydrateError || !project) return;
    let cancelled = false;
    Sessions.list(id, { limit: 50 })
      .then(({ sessions: list = [] }) => { if (!cancelled) setSessions(list); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [id, hydrated, hydrateError, project?.id]);

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
            <ArrowLeft size={14} /> All projects
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

          <SessionList projectId={id} sessions={sessions} />
        </div>

        {/* ── 右栏 cards（H3 接通后端） ── */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          gap: GAP.lg,
          position: 'sticky',
          top: GAP.xl,
        }}>
          <SidebarCard
            title="Memory"
            icon={<Lock size={11} />}
            iconLabel="Only you"
            actionIcon={<Pencil size={13} />}
            placeholder="agent 在 session 中按需记录的长期记忆。还没有内容。"
            disabled
          />
          <SidebarCard
            title="Instructions"
            actionIcon={<Plus size={14} />}
            placeholder="Add instructions to tailor Claude's responses"
            disabled
          />
          <SidebarCard
            title="Files"
            actionIcon={<Plus size={14} />}
            placeholder="Add PDFs, documents, or other text to reference in this project."
            illustration={<FilesIllustration />}
            disabled
          />
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
        placeholder="How can I help you today?"
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

// ── SessionList ── 参考图无边框 list view，每条间距宽松

function SessionList({ projectId, sessions }) {
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sessions.map((s, i) => (
        <Link
          key={s.sessionId}
          to={`/projects/${projectId}/sessions/${s.sessionId}`}
          style={{
            display: 'flex', flexDirection: 'column', gap: 4,
            padding: `${GAP.lg}px 0`,
            borderTop: i === 0 ? 'none' : `1px solid ${COLOR.borderLt}`,
            textDecoration: 'none',
            transition: 'background 0.15s, padding-left 0.15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(0,0,0,0.018)';
            e.currentTarget.style.paddingLeft = `${GAP.sm}px`;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.paddingLeft = 0;
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
            <span>Last message {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}</span>
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
      ))}
    </div>
  );
}

// ── SidebarCard ── H3 占位

function SidebarCard({ title, icon, iconLabel, actionIcon, placeholder, illustration, disabled }) {
  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${COLOR.borderLt}`,
      borderRadius: 12,
      padding: `${GAP.lg}px ${GAP.lg}px`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: GAP.sm,
        marginBottom: GAP.sm,
      }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: COLOR.text,
        }}>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs }}>
          {iconLabel && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              padding: '1px 6px',
              background: 'rgba(45,36,24,0.05)',
              borderRadius: 4,
              fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
            }}>
              {icon}{iconLabel}
            </span>
          )}
          {actionIcon && (
            <button
              disabled={disabled}
              style={{
                width: 24, height: 24, borderRadius: 4,
                background: 'transparent',
                color: disabled ? COLOR.dim : COLOR.text2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
              title={disabled ? 'H3 接通' : ''}
            >
              {actionIcon}
            </button>
          )}
        </div>
      </div>
      {illustration ? (
        <div style={{
          padding: `${GAP.lg}px 0`,
          background: 'rgba(45,36,24,0.025)',
          borderRadius: 8,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: GAP.sm,
          color: COLOR.sub,
        }}>
          {illustration}
          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: COLOR.sub,
            textAlign: 'center',
            padding: `0 ${GAP.lg}px`,
            lineHeight: 1.55,
          }}>{placeholder}</span>
        </div>
      ) : (
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.55,
        }}>{placeholder}</div>
      )}
    </div>
  );
}

function FilesIllustration() {
  return (
    <div style={{
      display: 'flex', gap: -8, alignItems: 'flex-end', padding: `${GAP.sm}px 0`,
    }}>
      <div style={fileTileStyle(-6, '#fff', COLOR.borderMd)}><FileText size={20} color={COLOR.dim} /></div>
      <div style={fileTileStyle(0, '#fff', COLOR.borderMd)}><FileText size={22} color={COLOR.dim} /></div>
      <div style={fileTileStyle(6, '#faf8f4', COLOR.borderLt, true)}><Plus size={18} color={COLOR.dim} /></div>
    </div>
  );
}

function fileTileStyle(rotate, bg, border, dashed) {
  return {
    width: 44, height: 56,
    borderRadius: 6,
    background: bg,
    border: `${dashed ? '1px dashed' : '1px solid'} ${border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transform: `rotate(${rotate}deg)`,
    margin: '0 -3px',
  };
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
