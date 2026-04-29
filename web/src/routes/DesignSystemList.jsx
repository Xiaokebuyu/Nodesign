import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Layers } from 'lucide-react';

/** P1 占位：设计系统列表（P6 实现）*/
export default function DesignSystemList() {
  return (
    <AppShell breadcrumb={[{ label: '设计系统' }]}>
      <div style={{
        maxWidth: 800, margin: '0 auto', padding: `${GAP.page * 1.5}px ${GAP.page}px`,
        textAlign: 'center',
      }}>
        <Layers size={48} color={COLOR.dim} style={{ marginBottom: GAP.xl }} />
        <h1 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
          color: COLOR.text, marginBottom: GAP.lg,
        }}>设计系统</h1>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, color: COLOR.text2, lineHeight: 1.6 }}>
          P6 实现。上传 PPT / PDF / HTML / 品牌资产，自动抽取 design tokens、components、layout patterns。
        </p>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, marginTop: GAP.lg }}>
          当前 P1 阶段：占位页。
        </p>
      </div>
    </AppShell>
  );
}
