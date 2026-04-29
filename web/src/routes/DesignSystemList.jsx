import { Link, useNavigate } from 'react-router-dom';
import { Plus, Layers } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { MOCK_DESIGN_SYSTEMS } from '../mock/design-systems.js';
import { timeAgo } from '../lib/helpers.js';

export default function DesignSystemList() {
  const navigate = useNavigate();
  return (
    <AppShell
      breadcrumb={[{ label: '设计系统' }]}
      actions={
        <button
          onClick={() => navigate('/design-systems/new')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.sm + 1}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.btnText, background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`,
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          <Plus size={14} /> 新建设计系统
        </button>
      }
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <div style={{ marginBottom: GAP.xl }}>
          <h1 style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
            color: COLOR.text, marginBottom: GAP.sm,
          }}>设计系统</h1>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, margin: 0,
          }}>
            上传 PPT / PDF / HTML / 品牌资产 → Nodesign 抽取 design tokens、components、layout patterns。<br />
            发布后，新项目自动使用，不必每次重写 brief 描述风格。
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: GAP.lg,
        }}>
          {MOCK_DESIGN_SYSTEMS.map(ds => <DSCard key={ds.id} ds={ds} />)}
        </div>

        <div style={{
          marginTop: GAP.page,
          padding: `${GAP.lg}px ${GAP.xl}px`,
          background: COLOR.bgCard,
          border: `1px dashed ${COLOR.borderMd}`,
          borderRadius: 12,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          ⓘ <strong style={{ color: COLOR.text2 }}>P2 阶段为 mock 数据。</strong>
          P6 接通：上传 → 流式抽取 token / component / pattern → 设计师 review → 发布；新建项目时可绑定。
        </div>
      </div>
    </AppShell>
  );
}

function DSCard({ ds }) {
  const statusColor = ds.status === 'published' ? COLOR.success : COLOR.warn;
  const statusLabel = ds.status === 'published' ? '已发布' : '草稿';

  return (
    <Link to={`/design-systems/${ds.id}`} style={{
      display: 'block',
      padding: GAP.lg,
      background: '#fff',
      border: `1px solid ${COLOR.border}`,
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
      transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.03)'; }}
    >
      {/* Token swatch row */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: GAP.lg,
      }}>
        {(ds.tokenSwatch || []).map((c, i) => (
          <div key={i} style={{
            flex: 1, height: 36, borderRadius: 4,
            background: c,
            border: '1px solid rgba(0,0,0,0.05)',
          }} />
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.xs }}>
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600, color: COLOR.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ds.name}</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontFamily: FONT_MONO, fontSize: 10, color: statusColor,
          padding: '1px 7px',
          background: ds.status === 'published' ? 'rgba(74,138,74,0.1)' : 'rgba(184,92,26,0.1)',
          borderRadius: 100, flexShrink: 0,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: 3, background: statusColor }} />
          {statusLabel}
        </span>
      </div>

      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        marginBottom: GAP.sm,
      }}>{ds.version}</div>

      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
        lineHeight: 1.5, marginBottom: GAP.lg,
        minHeight: 36,
      }}>{ds.summary}</div>

      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub,
      }}>
        <span>来源：{ds.source}</span>
        <span>{timeAgo(ds.updatedAt)}</span>
      </div>
    </Link>
  );
}
