import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Sparkles } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { findMockDS } from '../mock/design-systems.js';
import { useGlobalStore } from '../stores/globalStore.js';

export default function DesignSystemDetail() {
  const { id } = useParams();
  const ds = findMockDS(id);
  const showToast = useGlobalStore(s => s.showToast);

  if (!ds) {
    return (
      <AppShell breadcrumb={[{ label: '设计系统', to: '/design-systems' }, { label: '未找到' }]}>
        <div style={{ padding: GAP.page, textAlign: 'center' }}>
          <h1 style={{ fontFamily: FONT_MONO, color: COLOR.text }}>找不到 {id}</h1>
          <Link to="/design-systems" style={{ color: COLOR.btn }}>返回列表</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      breadcrumb={[
        { label: '设计系统', to: '/design-systems' },
        { label: ds.name },
      ]}
      actions={
        <button
          onClick={() => showToast('P6：Remix 进入 chat 改这个 DS', 'info')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.sm + 1}px ${GAP.xl}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: COLOR.btnText, background: COLOR.btn,
            border: `1px solid ${COLOR.btn}`,
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          <Sparkles size={13} /> Remix
        </button>
      }
    >
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        <Link to="/design-systems" style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text4,
          marginBottom: GAP.lg,
        }}>
          <ArrowLeft size={13} /> 返回列表
        </Link>

        <h1 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
          color: COLOR.text, marginBottom: GAP.xs,
        }}>{ds.name}</h1>
        <div style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          marginBottom: GAP.page,
        }}>
          {ds.version} · {ds.status === 'published' ? '已发布' : '草稿'} · 来源：{ds.source}
        </div>

        {/* tokens */}
        <Section label="Tokens">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.lg }}>
            {(ds.tokenSwatch || []).map((c, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 6,
                  background: c, border: `1px solid ${COLOR.borderLt}`,
                  marginBottom: GAP.xs,
                }} />
                <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLOR.text4 }}>{c}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* components 占位 */}
        <Section label="Components">
          <Placeholder text="按钮 / 卡片 / 模态 / 表单 / 列表 …（P6 真接 design-system extraction 后填充）" />
        </Section>

        {/* layout patterns 占位 */}
        <Section label="Layout Patterns">
          <Placeholder text="hero / two-column / card grid / pricing tiers …（P6 真接 extraction 后填充）" />
        </Section>

        {/* assets 占位 */}
        <Section label="Approved Assets">
          <Placeholder text="logos / 配图 / 图标库（P6 + 接资产 CDN 后填充）" />
        </Section>
      </div>
    </AppShell>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: GAP.page }}>
      <h2 style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
        color: COLOR.text, marginBottom: GAP.lg,
      }}>{label}</h2>
      {children}
    </div>
  );
}

function Placeholder({ text }) {
  return (
    <div style={{
      padding: GAP.xl,
      background: COLOR.bgCard,
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: 8,
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
      textAlign: 'center',
    }}>{text}</div>
  );
}
