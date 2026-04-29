import { Link } from 'react-router-dom';
import { Plus, Sparkles, FileText, Layers, Wrench } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { MOCK_PROJECTS } from '../mock/projects.js';
import { timeAgo } from '../lib/helpers.js';

export default function Home() {
  return (
    <AppShell
      actions={
        <>
          <Link to="/design-systems" style={iconBtnStyle}><Layers size={14} /> 设计系统</Link>
          <Link to="/skills" style={iconBtnStyle}><Wrench size={14} /> Skill</Link>
          <button style={primaryBtnStyle} onClick={() => alert('P2 实现：创建项目 modal')}>
            <Plus size={14} /> 新建项目
          </button>
        </>
      }
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        {/* Hero / 入口卡片 */}
        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: GAP.xl, marginBottom: GAP.page }}>
          <EntryCard
            icon={<Sparkles size={20} color={COLOR.btn} />}
            title="自由创作"
            desc="输入 brief，agent 从 metaphor 推审美生成 deck"
            action="开始"
          />
          <EntryCard
            icon={<FileText size={20} color={COLOR.accent || COLOR.brown} />}
            title="参照模式"
            desc="上传 PPT/PDF/HTML 或选已有设计系统，按品牌生成"
            action="选参考"
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
              {MOCK_PROJECTS.length} 个项目（mock 数据）
            </span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: GAP.lg,
          }}>
            {MOCK_PROJECTS.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function EntryCard({ icon, title, desc, action }) {
  return (
    <div style={{
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
  const dot = project.status === 'running' ? COLOR.warn : project.status === 'failed' ? COLOR.error : COLOR.success;
  return (
    <Link to={`/projects/${project.id}`} style={{
      display: 'block',
      padding: GAP.lg,
      background: '#fff',
      border: `1px solid ${COLOR.border}`,
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
      transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; e.currentTarget.style.borderColor = COLOR.borderMd; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.03)'; e.currentTarget.style.borderColor = COLOR.border; }}
    >
      {/* Thumbnail 占位 */}
      <div style={{
        height: 120,
        background: COLOR.bgCard,
        borderRadius: 8,
        marginBottom: GAP.lg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim,
      }}>{project.summary}</div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.sm }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {project.name}
        </div>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0, marginLeft: GAP.md }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{project.skill}</span>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{timeAgo(project.updatedAt)}</span>
      </div>
    </Link>
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
