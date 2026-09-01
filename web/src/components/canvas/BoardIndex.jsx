/**
 * BoardIndex —— 这块板的目录（2026-09-01 叠纸刀 5）
 *
 * 叠纸之后「板上有什么」不再是看一眼就知道的：一摞纸只画得出最上面那一张，
 * 底下那几页在屏幕上完全不存在。缩小也看不见 —— 它们本来就在同一块地上。
 * 所以叠纸必须配一份目录，否则用户找不回自己刚才读到的那一页。
 *
 * 每张纸都有标题（真板实测 103 张里 95 张有），所以目录不用另攒数据，
 * 列出来就能读。点一行 = 翻到那一页并把镜头带过去。
 *
 * ⚠️ 只列摞和页，不列每一页里有什么。「这一页写了什么」是内容，画布本身在答；
 * 目录答的是「有哪几页、我在第几页」。
 */
import { PAPER, P, INK_SURFACE } from '../../lib/paper.js';
import { GAP, FONT_SIZE, RADIUS } from '../../lib/theme.js';

export default function BoardIndex({ piles, sheets, shownOf, currentPile, onPick, onClose }) {
  if (!piles?.length) return null;
  return (
    <div
      data-board-index="panel"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute', right: GAP.md, bottom: 64, zIndex: 60,
        maxHeight: '60%', overflowY: 'auto', overscrollBehavior: 'contain',
        minWidth: 200, maxWidth: 300, padding: GAP.sm,
        background: INK_SURFACE.bg, color: INK_SURFACE.text,
        border: `1px solid ${P('pencil', 0.35)}`, borderRadius: RADIUS.md,
        boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: FONT_SIZE.xxs, color: INK_SURFACE.textDim, marginBottom: GAP.xs,
      }}>
        <span>目录</span>
        <button
          type="button" data-board-action aria-label="收起目录" onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px' }}
        >×</button>
      </div>
      {piles.map((pile) => {
        const shown = shownOf(pile.name);
        return (
          <div key={pile.name} style={{ marginBottom: GAP.xs }}>
            <div style={{ fontSize: FONT_SIZE.xxs, color: PAPER.pencil, padding: '2px 4px' }}>
              {pile.title || pile.name}{pile.sheets.length > 1 ? ` · ${pile.sheets.length} 页` : ''}
              {pile.name === currentPile ? ' ·' : ''}
            </div>
            {pile.sheets.map((id, i) => (
              <button
                key={id}
                type="button"
                data-board-action
                data-board-index="page"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onPick(pile, id)}
                /**
                 * 中键 / Alt 点 = 回到铺这一页时那段对话（叠纸刀 8）。
                 * ⚠️ 做成副动作而不是第二颗按钮：目录的主职责是「翻到那一页」，
                 * 一行两颗钮在手机上按不准，而"回对话"是低频的。会话删了 sid 就
                 * 指不到，那时静默不响应 —— 板上的字不该因为对话没了变成坏链接。
                 */
                onAuxClick={(e) => {
                  const sid = sheets?.[id]?.sid;
                  if (e.button !== 1 || !sid) return;
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent('nd:open-session', { detail: { sid } }));
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', marginBottom: 1,
                  minHeight: 30,               // 触屏按钮下限（08-21）
                  background: id === shown ? P('pencil', 0.16) : 'transparent',
                  border: 'none', borderRadius: RADIUS.sm,
                  fontSize: FONT_SIZE.xs, color: INK_SURFACE.text,
                  cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {/* 纸有标题就用标题（真板 103 张里 95 张有）；架那一摞的「页」是
                    物件，退回文件名 */}
                {i + 1}. {sheets?.[id]?.title || String(id).split('/').pop() || id}
                {sheets?.[id]?.sid ? <span style={{ color: PAPER.pencil, marginLeft: 6 }} title="中键点：回到铺这一页时那段对话">·</span> : null}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
