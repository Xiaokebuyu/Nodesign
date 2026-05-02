import { Cpu, Wrench, Plug, Users, Activity } from 'lucide-react';
import { COLOR, GAP, FONT_MONO } from '../../lib/theme.js';

/**
 * ContextUsageBar —— 元信息 chip + 实时上下文用量进度条
 *
 * 数据源：
 *   - info（一次性元信息）：来自 run.system_init 事件（model / tools /
 *     mcp_servers / agents 数）。SDK init 时一次。
 *   - liveUsage（实时用量）：来自 run.context_usage 事件（A2.1 后端 loop.js
 *     每个 assistant message 后 emit）。每个 assistant 块更新一次。
 *     字段见 events.js Events.contextUsage（轻量化 SDKControlGetContextUsageResponse）。
 *
 * 视觉：
 *   - liveUsage 不空：左侧渲细进度条 + 百分比 + token 数（当前/maxToken）
 *     - 阶梯色：< 60% green / 60-85% warn / ≥ 85% error
 *     - hover title 展开 breakdown（toolCallsByType top 3 + 类目级聚合）
 *   - liveUsage 空：进度条隐藏，只显示元信息 chip
 *   - 元信息 chip 始终显示在右侧（model / tools 数 / mcp 数 / agents 数）
 *
 * 一行紧凑布局，跟 Claude Code 顶栏视觉对齐。
 */
export default function ContextUsageBar({ info, liveUsage, variant = 'compact' }) {
  if (!info && !liveUsage) return null;

  const isFull = variant === 'full';

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: GAP.sm,
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderRadius: 6,
      background: 'rgba(0,0,0,0.03)',
      fontFamily: FONT_MONO,
      fontSize: 11,
      color: COLOR.text2,
      letterSpacing: '0.02em',
    }}>
      {liveUsage
        ? <UsageProgress usage={liveUsage} isFull={isFull} />
        : info && (
            <span
              style={{ color: COLOR.sub, fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title="SDK control request 还没返回 — Kimi binary 可能不实现 getContextUsage"
            >
              <Activity size={11} strokeWidth={1.5} />
              等待 context 数据…
            </span>
          )
      }
      {info && liveUsage && (
        <span style={{ width: 1, height: 12, background: COLOR.borderMd }} />
      )}
      {info && <InfoChips info={info} />}
    </div>
  );
}

function UsageProgress({ usage, isFull = false }) {
  const pct = clamp(usage.percentage || 0, 0, 100);
  const totalK = (usage.totalTokens / 1000).toFixed(1);
  const maxK = (usage.maxTokens / 1000).toFixed(0);
  const barColor = pct >= 85 ? COLOR.error : pct >= 60 ? COLOR.warn : COLOR.success;

  // 阈值标记（autoCompact 触发线，相对 maxTokens 的位置）
  const threshold = usage.autoCompactThreshold;
  const thresholdPct = threshold && usage.maxTokens
    ? clamp((threshold / usage.maxTokens) * 100, 0, 100)
    : null;

  // hover 详情：toolCallsByType top 3 + 类目级
  const breakdown = usage.messageBreakdown;
  const topTools = breakdown?.toolCallsByType?.slice(0, 3) || [];
  const tooltipLines = [
    `${totalK}k / ${maxK}k tokens (${pct.toFixed(1)}%)`,
    threshold ? `autoCompact 阈值: ${(threshold / 1000).toFixed(0)}k${usage.isAutoCompactEnabled ? '' : '（关）'}` : null,
    breakdown ? '' : null,
    breakdown ? `assistant: ${formatK(breakdown.assistantMessageTokens)}` : null,
    breakdown ? `user: ${formatK(breakdown.userMessageTokens)}` : null,
    breakdown ? `tool calls: ${formatK(breakdown.toolCallTokens)} / results: ${formatK(breakdown.toolResultTokens)}` : null,
    breakdown && breakdown.attachmentTokens ? `attachments: ${formatK(breakdown.attachmentTokens)}` : null,
    topTools.length > 0 ? '' : null,
    topTools.length > 0 ? `top tools by token：` : null,
    ...topTools.map(t => `  ${t.name}: call ${formatK(t.callTokens)} + result ${formatK(t.resultTokens)}`),
    usage.mcpToolsTokens ? `MCP tools: ${formatK(usage.mcpToolsTokens)}` : null,
    usage.agentsTokens ? `subagents: ${formatK(usage.agentsTokens)}` : null,
    usage.memoryFilesTokens ? `memory: ${formatK(usage.memoryFilesTokens)}` : null,
  ].filter(s => s !== null).join('\n');

  return (
    <span
      title={tooltipLines}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'help',
      }}
    >
      {/* 进度条 */}
      <span style={{
        position: 'relative',
        width: isFull ? 200 : 80, height: isFull ? 8 : 6,
        background: 'rgba(0,0,0,0.08)',
        borderRadius: 3,
        overflow: 'hidden',
      }}>
        {/* 填充 */}
        <span style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`,
          background: barColor,
          transition: 'width 0.3s ease, background 0.2s',
        }} />
        {/* autoCompact 阈值竖线 */}
        {thresholdPct !== null && (
          <span style={{
            position: 'absolute', top: -1, bottom: -1,
            left: `${thresholdPct}%`,
            width: 1,
            background: COLOR.text4,
            opacity: 0.5,
          }} />
        )}
      </span>
      <span style={{ color: barColor, fontWeight: 500, minWidth: 28, textAlign: 'right' }}>
        {pct.toFixed(0)}%
      </span>
      <span style={{ color: COLOR.sub, fontSize: 10 }}>
        {totalK}k/{maxK}k
      </span>
    </span>
  );
}

function InfoChips({ info }) {
  const items = [];

  if (info.model) {
    items.push({
      icon: Cpu,
      label: info.model,
      title: `Model: ${info.model}`,
    });
  }

  if (Array.isArray(info.tools)) {
    items.push({
      icon: Wrench,
      label: `${info.tools.length}t`,
      title: `Tools (${info.tools.length}): ${info.tools.join(', ')}`,
    });
  }

  if (Array.isArray(info.mcpServers) && info.mcpServers.length > 0) {
    const names = info.mcpServers.map(s => s.name || s).filter(Boolean);
    items.push({
      icon: Plug,
      label: `${names.length}mcp`,
      title: `MCP servers: ${names.join(', ')}`,
    });
  }

  if (Array.isArray(info.agents) && info.agents.length > 0) {
    items.push({
      icon: Users,
      label: `${info.agents.length}a`,
      title: `Subagents: ${info.agents.join(', ')}`,
    });
  }

  if (items.length === 0) return null;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.xs }}>
      {items.map((it, i) => (
        <span
          key={i}
          title={it.title}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: `0 ${GAP.xs}px`,
            borderLeft: i > 0 ? `1px solid ${COLOR.borderMd}` : 'none',
            cursor: 'help',
          }}
        >
          <it.icon size={11} strokeWidth={1.5} color={COLOR.sub} />
          <span>{it.label}</span>
        </span>
      ))}
    </span>
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatK(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
