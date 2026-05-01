import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { Sessions } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * ProjectHub — 项目控制台二级页（H1 占位版）
 *
 * URL: /projects/:id
 *
 * 参考 Anthropic Projects 设计：项目元数据 header + new task input + sessions
 * 列表（左主体）+ 右侧 Memory / Instructions / Files 三卡片。
 *
 * H1 只做最小可用版：header + sessions list + "进工作台" 入口。
 * H2 加 input box + 嵌入式 sessions list 完整版。
 * H3 加右侧三卡片。
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

  return (
    <AppShell breadcrumb={[{ label: '项目', to: '/' }, { label: project.name }]}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        {/* 顶部 ← All projects */}
        <Link to="/" style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          padding: `${GAP.xs}px ${GAP.sm}px ${GAP.xs}px 0`,
          marginBottom: GAP.lg,
          textDecoration: 'none',
        }}>
          <ArrowLeft size={14} /> All projects
        </Link>

        {/* 项目 name + description */}
        <div style={{ marginBottom: GAP.xl }}>
          <h1 style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
            color: COLOR.text, letterSpacing: '-0.01em',
            margin: `0 0 ${GAP.sm}px`,
          }}>{project.name}</h1>
          {project.description && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base,
              color: COLOR.text2, lineHeight: 1.55,
            }}>
              {project.description}
            </div>
          )}
        </div>

        {/* 进工作台主入口（H1 占位 — H2 改成真正的 input box）*/}
        <button
          onClick={() => navigate(`/projects/${id}/work`)}
          style={{
            display: 'flex', alignItems: 'center', gap: GAP.sm,
            padding: `${GAP.lg}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.btnText, background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`, borderRadius: 10,
            cursor: 'pointer',
            marginBottom: GAP.xxl,
          }}
        >
          <Plus size={16} /> 开新会话
        </button>

        {/* sessions 列表（H1 简版） */}
        <h2 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
          color: COLOR.text, letterSpacing: '-0.01em',
          margin: `0 0 ${GAP.lg}px`,
        }}>会话历史 <span style={{ color: COLOR.sub, fontWeight: 400 }}>({sessions.length})</span></h2>

        {sessions.length === 0 ? (
          <div style={{
            padding: `${GAP.page}px ${GAP.page}px`,
            textAlign: 'center',
            background: '#fff',
            border: `1px dashed ${COLOR.borderMd}`,
            borderRadius: 12,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
          }}>
            还没有会话——点上面"开新会话"开始。
          </div>
        ) : (
          <div style={{
            display: 'flex', flexDirection: 'column',
            background: '#fff',
            border: `1px solid ${COLOR.border}`,
            borderRadius: 10,
            overflow: 'hidden',
          }}>
            {sessions.map((s, i) => (
              <Link
                key={s.sessionId}
                to={`/projects/${id}/sessions/${s.sessionId}`}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: `${GAP.md}px ${GAP.lg}px`,
                  borderBottom: i < sessions.length - 1 ? `1px solid ${COLOR.borderLt}` : 'none',
                  textDecoration: 'none',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.025)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
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
                  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                }}>
                  <span>Last message {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}</span>
                  {s.tag && (
                    <span style={{
                      padding: '1px 6px',
                      background: 'rgba(45,36,24,0.06)',
                      borderRadius: 3,
                      color: COLOR.text2,
                    }}>{s.tag}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

const loadingStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: '60vh',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
};
