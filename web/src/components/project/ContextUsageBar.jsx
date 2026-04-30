import { Cpu, Wrench, Plug, Users } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_MONO } from '../../lib/theme.js';

/**
 * ContextUsageBar —— 显示 SDK init 时返回的元信息
 *
 * 数据来自 run.system_init 事件（C1 events.js + C17 Project.jsx state）：
 *   { model, tools, mcp_servers, agents, permissionMode, skills, plugins, ... }
 *
 * UI：一行 chip，每个 chip 显示一类信息。鼠标 hover 看详情（title）。
 *
 * P0+ stage 1 范围：仅显示元信息（system init 一次性快照）。
 * stage 2 加 SDK Query.getContextUsage() 的实时 token 用量（需要后端
 * 加 endpoint + 维护活跃 query Map）。
 */
export default function ContextUsageBar({ info }) {
  if (!info) return null;

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
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: GAP.xs,
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderRadius: 6,
      background: 'rgba(0,0,0,0.03)',
      fontFamily: FONT_MONO,
      fontSize: 11,
      color: COLOR.text2,
      letterSpacing: '0.02em',
    }}>
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
          <it.icon size={11} color={COLOR.sub} />
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}
