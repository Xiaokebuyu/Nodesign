import { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, Bot, Wrench, Check, EyeOff, Trash2, RotateCcw, Bug, Lightbulb, Monitor } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { Desk } from './desk.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Admin } from '../lib/api-admin.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo } from '../lib/helpers.js';
import { PAPER_SHADOW } from '../lib/paper.js';

/**
 * Issues — harness 问题库（/admin/issues，admin 才有意义，后端 adminGuard 兜底）
 *
 * 两个来源写同一张表：
 *   auto  PostToolUseFailure 自动记的工具失败 —— 不依赖 agent 自觉，
 *         抓得到"某工具这周失败 40 次但从没人提"
 *   agent report_friction 主动报的摩擦 —— 补"为什么难受、期望怎样"，
 *         这是自动层拿不到、但真正指向修法的那半句
 *
 * 默认按次数降序：一眼看到最该修的那个。
 */
const SOURCE_META = {
  auto: { label: '自动', icon: Wrench, color: COLOR.sub },
  agent: { label: 'agent 上报', icon: Bot, color: COLOR.brown },
  // 09-07 客户端中继（hosted/relay/issues.js）：桌面版 agent 的上报与桌面壳自己的事件
  client: { label: '桌面版 agent', icon: Bot, color: COLOR.blue },
  desktop: { label: '桌面壳', icon: Monitor, color: COLOR.blue },
};

// kind 轴（08-02 上报扩容）：bug=行为错了 / friction=能用但绕路 / idea=改进想法
const KIND_META = {
  bug: { label: '故障', icon: Bug, color: COLOR.error },
  friction: { label: '摩擦', icon: Wrench, color: COLOR.warn },
  idea: { label: '想法', icon: Lightbulb, color: COLOR.gold },
};

export default function Issues() {
  return (
    <AppShell breadcrumb={[{ label: 'Harness 问题库' }]}>
      {/* 只要光，不要台面 —— 见 desk.jsx 的 .ndd-plain */}
      <Desk plain>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <header style={{ marginBottom: GAP.xl }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.sm }}>
            <AlertTriangle size={18} color={COLOR.warn} />
            <h1 style={{
              fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700,
              color: `var(--desk-ink, ${COLOR.text})`, letterSpacing: '-0.01em', margin: 0,
            }}>Harness 问题库</h1>
          </div>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: `var(--desk-ink-2, ${COLOR.text2})`,
            lineHeight: 1.65, margin: 0, maxWidth: 680,
          }}>
            工具失败自动进这里（不依赖 agent 说），agent 也能主动报绕路和期望。
            同类累加计数，按次数排序——排在前面的是最值得修的。
          </p>
        </header>
        <IssuesPanel />
      </div>
      </Desk>
    </AppShell>
  );
}

/** 问题库主体（筛选 + 工具聚合 + 列表）。控制台页嵌成一个 tab，独立路由也用它 */
export function IssuesPanel() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('open');
  const [source, setSource] = useState('all');
  const [kind, setKind] = useState('all');
  const showToast = useGlobalStore(s => s.showToast);

  const load = () => {
    Admin.issues({
      status: status === 'all' ? undefined : status,
      source: source === 'all' ? undefined : source,
      kind: kind === 'all' ? undefined : kind,
    })
      .then(setData)
      .catch(err => { showToast(`拉取失败：${err.message}`, 'error'); setData({ issues: [], stats: [] }); });
  };
  useEffect(load, [status, source, kind]);   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id, next) => {
    try {
      if (next === 'delete') await Admin.removeIssue(id);
      else await Admin.setIssueStatus(id, next);
      load();
    } catch (err) {
      showToast(`操作失败：${err.message}`, 'error');
    }
  };

  const topTools = useMemo(() => (data?.stats || []).slice(0, 6), [data]);

  return (
    <>
      {topTools.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.sm, marginBottom: GAP.xl }}>
            {topTools.map((s, i) => (
              <span key={i} style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2,
                padding: `${GAP.xs}px ${GAP.md}px`,
                background: 'rgba(43,33,23,0.035)', borderRadius: RADIUS.pill,
              }}>
                {shortTool(s.toolName)}
                <b style={{ color: COLOR.text }}>{s.total}</b>
                <span style={{ color: COLOR.sub }}>/ {s.kinds} 类</span>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: GAP.lg, marginBottom: GAP.lg, flexWrap: 'wrap' }}>
          <Segmented onDesk value={status} onChange={setStatus} options={[
            ['open', '待处理'], ['ack', '已知'], ['ignored', '忽略'], ['closed', '已修'], ['all', '全部'],
          ]} />
          <Segmented onDesk value={source} onChange={setSource} options={[
            ['all', '全部来源'], ['auto', '自动'], ['agent', 'agent 上报'], ['client', '桌面版 agent'], ['desktop', '桌面壳'],
          ]} />
          <Segmented onDesk value={kind} onChange={setKind} options={[
            ['all', '全部类型'], ['bug', '故障'], ['friction', '摩擦'], ['idea', '想法'],
          ]} />
        </div>

        {!data ? (
          <div style={emptyStyle}>加载中…</div>
        ) : data.issues.length === 0 ? (
          <div style={emptyStyle}>这个筛选下没有记录。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
            {data.issues.map(issue => (
              <IssueRow key={issue.id} issue={issue} onAct={act} />
            ))}
          </div>
        )}
    </>
  );
}

function shortTool(name) {
  if (!name) return '（无工具）';
  return name.replace(/^mcp__nodesign__/, '');
}

function IssueRow({ issue, onAct }) {
  const [open, setOpen] = useState(false);
  const meta = SOURCE_META[issue.source] || SOURCE_META.auto;
  const kindMeta = KIND_META[issue.kind] || KIND_META.friction;
  const KindIcon = kindMeta.icon;
  const Icon = meta.icon;
  const hot = issue.count >= 5;
  const isIdea = issue.kind === 'idea';

  return (
    <div style={{
      background: COLOR.bgWhite,
      boxShadow: PAPER_SHADOW.far,
      borderLeft: `3px solid ${isIdea ? COLOR.gold : hot ? COLOR.warn : COLOR.border}`,
      borderRadius: 2,
      padding: `${GAP.md}px ${GAP.lg}px`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: GAP.md }}>
        <Icon size={13} color={meta.color} style={{ flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text, lineHeight: 1.5,
            }}
          >{issue.summary}</button>

          <div style={{
            display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap',
            marginTop: GAP.xs, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            <span style={{ color: hot ? COLOR.warn : COLOR.text2, fontWeight: 600 }}>×{issue.count}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: kindMeta.color }}>
              <KindIcon size={10} />{kindMeta.label}
            </span>
            <span>{shortTool(issue.toolName)}</span>
            <span>{meta.label}</span>
            <span>最近 {timeAgo(issue.lastSeen)}</span>
            {issue.status !== 'open' && <span style={{ color: COLOR.dim }}>[{issue.status}]</span>}
          </div>

          {open && (
            <div style={{
              marginTop: GAP.md,
              padding: `${GAP.md}px ${GAP.lg}px`,
              background: 'rgba(43,33,23,0.025)', borderRadius: RADIUS.lg,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2,
              lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {issue.detail || '（无详情）'}
              {issue.expectation && (
                <div style={{ marginTop: GAP.md, paddingTop: GAP.md, borderTop: `1px solid ${COLOR.borderLt}` }}>
                  <b style={{ color: COLOR.text3 }}>期望：</b>{issue.expectation}
                </div>
              )}
              <div style={{ marginTop: GAP.md, color: COLOR.dim }}>
                首次 {issue.firstSeen} · {issue.projectId || '无项目'} · {issue.sessionId || '无会话'}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: GAP.xxs, flexShrink: 0 }}>
          {issue.status !== 'closed'
            ? <IconBtn title="标记已修" onClick={() => onAct(issue.id, 'closed')}><Check size={13} /></IconBtn>
            : <IconBtn title="重新打开" onClick={() => onAct(issue.id, 'open')}><RotateCcw size={13} /></IconBtn>}
          {issue.status !== 'ignored' && (
            <IconBtn title="忽略（噪音）" onClick={() => onAct(issue.id, 'ignored')}><EyeOff size={13} /></IconBtn>
          )}
          <IconBtn title="删除" onClick={() => onAct(issue.id, 'delete')} danger><Trash2 size={13} /></IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, title, onClick, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: RADIUS.md,
        background: 'transparent', border: 0, cursor: 'pointer',
        color: danger ? COLOR.error : COLOR.sub,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >{children}</button>
  );
}

/**
 * 分段选择。
 *
 * ⭐ `onDesk` = 这一支**直接坐在页面背景上**（不是在卡片里）。素台面夜里背景是黑的，
 *   那时"没选中"这一档得从压一点墨翻成提一点白，容器那层淡底同理。
 * ⛔ 默认 false，因为同一个零件也用在**卡片里**（管理台的档位编辑）——
 *   在浅色的纸上换粉笔等于把字擦掉。谁坐在背景上，由调用方说了算。
 */
export function Segmented({ value, onChange, options, onDesk = false }) {
  const tint = onDesk ? 'var(--desk-tint, rgba(43,33,23,0.04))' : 'rgba(43,33,23,0.04)';
  const off = onDesk ? `var(--desk-pencil, ${COLOR.sub})` : COLOR.sub;
  return (
    <div style={{ display: 'inline-flex', gap: GAP.xxs, padding: GAP.xxs, background: tint, borderRadius: RADIUS.lg }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: `${GAP.xs}px ${GAP.md}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
            color: value === v ? COLOR.text : off,
            background: value === v ? COLOR.bgWhite : 'transparent',
            border: 0, borderRadius: RADIUS.md, cursor: 'pointer',
            boxShadow: value === v ? '0 1px 2px rgba(43,33,23,0.06)' : 'none',
          }}
        >{label}</button>
      ))}
    </div>
  );
}

const emptyStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`,
  textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};
