import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Wrench } from 'lucide-react';

/** P1 占位：Skill 注册表（P6 实现）*/
export default function SkillList() {
  return (
    <AppShell breadcrumb={[{ label: 'Skill' }]}>
      <div style={{
        maxWidth: 800, margin: '0 auto', padding: `${GAP.page * 1.5}px ${GAP.page}px`,
        textAlign: 'center',
      }}>
        <Wrench size={48} color={COLOR.dim} style={{ marginBottom: GAP.xl }} />
        <h1 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
          color: COLOR.text, marginBottom: GAP.lg,
        }}>Skill 注册表</h1>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, color: COLOR.text2, lineHeight: 1.6 }}>
          多 skill 可插拔。已安装的 skill 在这里管理，支持新增 / 切换默认 / 查看 SKILL.md。
        </p>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, marginTop: GAP.lg }}>
          当前 P1 阶段：占位页。
        </p>
      </div>
    </AppShell>
  );
}
