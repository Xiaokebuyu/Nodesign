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

/*
 * ⚠️ 这里曾有 ArchiveChip：画布右上角那颗「档案」文字钮，管根 CLAUDE.md 与
 * 记忆/ 的显隐。2026-08-30 用户拍板搬进顶栏的「⋯」，跟 08-07 那次
 * 「项目级四件套从画布顶带搬进 ⋯」是同一件事 —— 它是设置不是产物。
 *
 * **能力没删，换了个入口**：状态仍是 BoardCanvas 的 showArchive（存 localStorage，
 * 按项目分），切换走 apiRef.toggleArchive，菜单读 uiState.showArchive 决定
 * 显示「显示档案卡」还是「收起档案卡」。
 */
