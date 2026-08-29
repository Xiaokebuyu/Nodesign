/**
 * RollLayer —— 卷卡（2026-08-27 收纳器；BoardCanvas 行数棘轮拆件）。
 *
 * 收着的组（board.rolls 有条目）渲染层不画，由这里在组包络左上角放一张卷卡：
 * 名字 + 件数，单击展开。卷卡是**合成物**，不进 board.json 的 objects ——
 * 一进就要过形态注册表全家（那个已经漏到第五处的写死表家族）。
 *
 * 座位原样留在 layout 里（展开即归位）；服务端落位照旧把它们当障碍，
 * 所以永远不会有新东西压进卷里 —— 这层只管"看不见"，不管"在不在"。
 */
import { useCallback, useMemo } from 'react';
import { Archive } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../lib/paper.js';
import { TEXT_FONT_CSS } from '../../lib/text-fonts.js';

/** 卷卡数据：每个收着的 tag 一张，站在成员包络左上角 */
export function computeRollCards(rolls, layout) {
  return Object.entries(rolls || {}).map(([tag, r]) => {
    const members = Object.entries(layout || {}).filter(([, e]) => e?.tag === tag && Number.isFinite(e?.x));
    if (!members.length) return null;
    return {
      tag,
      x: Math.min(...members.map(([, e]) => e.x)),
      y: Math.min(...members.map(([, e]) => e.y)),
      count: members.length,
      label: (r && r.label) || tag,
    };
  }).filter(Boolean);
}

/** 收/展开的动作（本地乐观更新 + patchBoard 落盘） */
export function useRollActions(projectId, setRolls) {
  const rollGroup = useCallback((tag) => {
    setRolls(prev => ({ ...prev, [tag]: { by: 'user', at: new Date().toISOString() } }));
    Assets.patchBoard(projectId, { rolls: { [tag]: { by: 'user' } } }).catch(() => {});
  }, [projectId, setRolls]);
  const unrollGroup = useCallback((tag) => {
    setRolls(prev => { const n = { ...prev }; delete n[tag]; return n; });
    Assets.patchBoard(projectId, { rolls: { [tag]: null } }).catch(() => {});
  }, [projectId, setRolls]);
  return { rollGroup, unrollGroup };
}

export default function RollLayer({ rolls, layout, onUnroll }) {
  const cards = useMemo(() => computeRollCards(rolls, layout), [rolls, layout]);
  if (!cards.length) return null;
  return cards.map(rc => (
    <div
      key={`roll:${rc.tag}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onUnroll(rc.tag)}
      title={`展开 #${rc.tag}（${rc.count} 件都在原位）`}
      style={{
        position: 'absolute', left: rc.x, top: rc.y, zIndex: 60,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', cursor: 'pointer',
        background: PAPER.bg, border: `1.5px solid ${alpha(PAPER.ink, 0.35)}`,
        borderRadius: 10, boxShadow: PAPER_SHADOW,
        transform: 'rotate(-0.6deg)',
        fontFamily: TEXT_FONT_CSS.kai, fontSize: 14, color: PAPER.ink,
        whiteSpace: 'nowrap', userSelect: 'none',
      }}
    >
      <Archive size={14} style={{ opacity: 0.55, flexShrink: 0 }} />
      <span>{rc.label}</span>
      <span style={{ opacity: 0.5, fontSize: 12 }}>{rc.count} 件 · 点开</span>
    </div>
  ));
}

/**
 * 档案钮（2026-08-27 档案面；与卷卡同为"画布收纳"件，随棘轮拆件同住）。
 * 根 CLAUDE.md / 记忆/ 默认不上画布 —— 右上角这颗板书样文字钮显形/收起。
 */
export function ArchiveChip({ showArchive, onToggle }) {
  return (
    <button
      type="button" data-board-action
      title={showArchive
        ? '收起项目档案（根 CLAUDE.md 与 记忆/）'
        : '显示项目档案（根 CLAUDE.md 与 记忆/ —— agent 的项目档案和长期记忆）'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      style={{
        position: 'absolute', top: 12, right: 12, zIndex: 320,
        fontFamily: TEXT_FONT_CSS.kai, fontSize: 13, lineHeight: 1.4, cursor: 'pointer',
        padding: '3px 10px', borderRadius: 8,
        border: `1px solid ${alpha(PAPER.ink, showArchive ? 0.55 : 0.28)}`,
        background: showArchive ? PAPER.paper : 'transparent',
        color: PAPER.ink, opacity: showArchive ? 1 : 0.72,
        transform: 'rotate(-0.4deg)',
        boxShadow: showArchive ? PAPER_SHADOW.near : 'none',
        whiteSpace: 'nowrap',
      }}
    >档案</button>
  );
}
