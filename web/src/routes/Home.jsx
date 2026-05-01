import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, Layers, Wrench, MoreHorizontal, Copy, Trash2, Edit2 } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import CreateProjectModal from '../components/project/CreateProjectModal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo } from '../lib/helpers.js';

export default function Home() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const error = useProjectStore(s => s.error);
  const hydrate = useProjectStore(s => s.hydrate);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate().catch(() => { /* error 由 store 记录 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  // C30：移除 mode 区分（agent 自己根据输入判断）
  const openCreate = () => setCreateOpen(true);

  return (
    <AppShell
      actions={
        <>
          <Link to="/design-systems" style={iconBtnStyle}><Layers size={14} /> 设计系统</Link>
          <Link to="/skills" style={iconBtnStyle}><Wrench size={14} /> Skill</Link>
          <button style={primaryBtnStyle} onClick={openCreate}>
            <Plus size={14} /> 新建项目
          </button>
        </>
      }
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        {/* C30：单入口（不再分自由 vs 参照模式 —— agent 自己判断怎么用附件）*/}
        <section style={{ marginBottom: GAP.page }}>
          <EntryCard
            icon={<Sparkles size={20} color={COLOR.btn} />}
            title="开始一个新项目"
            desc="描述想做什么，可选附素材；agent 看了输入会自己判断要不要参考"
            action="开始"
            onClick={openCreate}
          />
        </section>

        {/* 最近项目 */}
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.lg }}>
            <h2 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>最近项目</h2>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              {projects.length} 个项目
            </span>
          </div>

          {!hydrated && hydrating ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message={error} onRetry={() => hydrate().catch(() => {})} />
          ) : projects.length === 0 ? (
            <EmptyState onCreate={openCreate} />
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: GAP.lg,
            }}>
              {projects.map(p => <ProjectCard key={p.id} project={p} />)}
            </div>
          )}
        </section>
      </div>

      <CreateProjectModal
        show={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(proj, hasFirstChat) => {
          // H1：有首跑 chat → 直接进 work 页看流；没填 brief → 进 Hub 让用户配置
          navigate(hasFirstChat ? `/projects/${proj.id}/work` : `/projects/${proj.id}`);
        }}
      />
    </AppShell>
  );
}

function EntryCard({ icon, title, desc, action, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: GAP.xl + 4,
        background: '#fff',
        border: `1px solid ${COLOR.border}`,
        borderRadius: 16,
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        display: 'flex',
        gap: GAP.lg,
        alignItems: 'flex-start',
        cursor: 'pointer',
        transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.04)'; }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: COLOR.bgCard, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600, color: COLOR.text, marginBottom: GAP.sm }}>{title}</div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2, lineHeight: 1.5, marginBottom: GAP.lg }}>{desc}</div>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500, color: COLOR.btn }}>{action} →</span>
      </div>
    </div>
  );
}

function ProjectCard({ project }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const navigate = useNavigate();
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const showToast = useGlobalStore(s => s.showToast);

  const dot = project.status === 'running' ? COLOR.warn : project.status === 'failed' ? COLOR.error : COLOR.success;

  const handleRename = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    const next = window.prompt('重命名为：', project.name);
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) showToast(`已复制为「${copy.name}」`, 'success');
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    if (!window.confirm(`删除「${project.name}」？此操作不可撤销。`)) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false); }}
      style={{ position: 'relative' }}
    >
      <Link to={`/projects/${project.id}`} style={{
        display: 'block',
        padding: GAP.lg,
        background: '#fff',
        border: `1px solid ${COLOR.border}`,
        borderRadius: 12,
        boxShadow: hover ? '0 6px 18px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.03)',
        borderColor: hover ? COLOR.borderMd : COLOR.border,
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
      }}>
        {/* Thumbnail 占位 */}
        <div style={{
          height: 120,
          background: COLOR.bgCard,
          borderRadius: 8,
          marginBottom: GAP.lg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim,
        }}>{project.summary || '新项目'}</div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.sm }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {project.name}
          </div>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0, marginLeft: GAP.md }} />
        </div>
        {project.description && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
            lineHeight: 1.5,
            marginBottom: GAP.sm,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {project.description}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{project.skill}</span>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{timeAgo(project.updatedAt)}</span>
        </div>
      </Link>

      {/* Hover 时显示 ⋯ */}
      {hover && (
        <button
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 28, height: 28, borderRadius: 6,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
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
            position: 'absolute', top: 40, right: 8,
            minWidth: 140,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
            padding: 4,
            zIndex: 5,
          }}>
          <MenuItem icon={<Edit2 size={12} />} label="重命名" onClick={handleRename} />
          <MenuItem icon={<Copy size={12} />} label="复制" onClick={handleDuplicate} />
          <MenuItem icon={<Trash2 size={12} />} label="删除" onClick={handleDelete} danger />
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

function LoadingState() {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
    }}>
      加载项目中…
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      background: '#fff',
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: 12,
    }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, color: COLOR.error, marginBottom: GAP.sm }}>
        加载失败
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub, marginBottom: GAP.xl }}>
        {message || '后端可能没启动。检查 server 是否在 :4001 上跑。'}
      </div>
      <button onClick={onRetry} style={{
        padding: `${GAP.md}px ${GAP.xxl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
        color: '#fff', background: COLOR.btn,
        border: `1px solid ${COLOR.btn}`,
        borderRadius: 8,
      }}>
        重试
      </button>
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{
      padding: `${GAP.page * 1.5}px ${GAP.page}px`,
      textAlign: 'center',
      background: '#fff',
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: 12,
    }}>
      <Sparkles size={36} color={COLOR.dim} style={{ marginBottom: GAP.lg }} />
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, color: COLOR.text2, marginBottom: GAP.sm }}>
        还没有项目
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub, marginBottom: GAP.xl }}>
        从一份 brief 开始你的第一个 deck
      </div>
      <button onClick={onCreate} style={{
        padding: `${GAP.md}px ${GAP.xxl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
        color: '#fff', background: COLOR.btn,
        border: `1px solid ${COLOR.btn}`,
        borderRadius: 8,
      }}>
        + 新建项目
      </button>
    </div>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: 8,
  background: 'transparent',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  padding: `${GAP.sm + 1}px ${GAP.xl}px`,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 8,
};
