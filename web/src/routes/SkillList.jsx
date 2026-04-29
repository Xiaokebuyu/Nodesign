import { Link } from 'react-router-dom';
import { Wrench, Plus } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { MOCK_SKILLS } from '../mock/design-systems.js';
import { timeAgo } from '../lib/helpers.js';
import { useGlobalStore } from '../stores/globalStore.js';

const STATUS_LABEL = {
  active: '激活',
  paused: '暂停',
  experimental: '实验中',
};
const STATUS_COLOR = {
  active: '#4A8A4A',
  paused: '#8A7A62',
  experimental: '#B85C1A',
};

export default function SkillList() {
  const showToast = useGlobalStore(s => s.showToast);
  return (
    <AppShell
      breadcrumb={[{ label: 'Skill' }]}
      actions={
        <button
          onClick={() => showToast('P6 实现：从本地路径 / GitHub URL 安装 skill', 'info')}
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
          <Plus size={14} /> 安装 Skill
        </button>
      }
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <div style={{ marginBottom: GAP.xl }}>
          <h1 style={{
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
            color: COLOR.text, marginBottom: GAP.sm,
          }}>Skill 注册表</h1>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, margin: 0,
          }}>
            多 skill 可插拔。每个 skill 有自己的 SKILL.md、references、转换器（→ page-spec）。<br />
            探索新 skill 流程，反过来优化老 skill —— Nodesign 的核心 belief。
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
          {MOCK_SKILLS.map(s => <SkillRow key={s.id} skill={s} />)}
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
          ⓘ <strong style={{ color: COLOR.text2 }}>P2 阶段为 mock。</strong>
          P3+：从 server/skills/installed/ 真实读取；P4：跑 skill 时按 id 加载 SKILL.md + references → 拼 system prompt。
        </div>
      </div>
    </AppShell>
  );
}

function SkillRow({ skill }) {
  const statusLabel = STATUS_LABEL[skill.status] || skill.status;
  const statusColor = STATUS_COLOR[skill.status] || COLOR.sub;
  const successRatePct = (skill.successRate * 100).toFixed(0);
  const lowRate = skill.successRate < 0.6;

  return (
    <div style={{
      padding: `${GAP.lg}px ${GAP.xl}px`,
      background: '#fff',
      border: `1px solid ${COLOR.border}`,
      borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: GAP.lg,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 8,
        background: COLOR.bgCard,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Wrench size={16} color={COLOR.text4} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: 2 }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600, color: COLOR.text }}>
            {skill.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
            {skill.version}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: FONT_MONO, fontSize: 10, color: statusColor,
            padding: '1px 7px',
            background: 'rgba(0,0,0,0.04)',
            borderRadius: 100,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 3, background: statusColor }} />
            {statusLabel}
          </span>
        </div>
        <div style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
          lineHeight: 1.5,
        }}>{skill.description}</div>
      </div>

      <div style={{
        display: 'flex', gap: GAP.lg, alignItems: 'center',
        flexShrink: 0,
      }}>
        <Stat label="跑次" value={skill.runs} />
        <Stat label="成功率" value={`${successRatePct}%`} warn={lowRate} />
        <span style={{
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          minWidth: 56, textAlign: 'right',
        }}>{timeAgo(skill.updatedAt)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500,
        color: warn ? COLOR.error : COLOR.text,
      }}>{value}</div>
      <div style={{ fontFamily: FONT_SANS, fontSize: 10, color: COLOR.sub }}>{label}</div>
    </div>
  );
}
