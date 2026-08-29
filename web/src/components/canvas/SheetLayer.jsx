/**
 * SheetLayer —— 纸（2026-08-29 纸范式刀 5）
 *
 * agent 的工作区矩形画成**垫在物件下面的一张纸**：纸内是 agent 手排的版面，
 * 纸与纸之间的沟是拼贴的节奏（登录墙那条经验：动作顺在卡内、格子感在卡间）。
 * 脸用全站同一份纸质字典（paperCard，与登录墙/首页同族），压得最平的一档影子
 * —— 它是垫底的东西，不跟物件抢层次。
 *
 * 纯展示层：不吃指针（pointerEvents:none），用户拖东西进出纸完全自由 ——
 * 纸约束 agent 的产出，不约束人。标题写在纸的左上边距里（楷体小字，像页眉）。
 */
import React from 'react';
import { paperCard } from '../../lib/paper.js';
import { FONT_KAI } from '../../lib/theme.js';

export default function SheetLayer({ sheets }) {
  const entries = Object.entries(sheets || {});
  if (!entries.length) return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, zIndex: 0, pointerEvents: 'none' }} data-sheet-layer>
      {entries.map(([id, s]) => (
        <div
          key={id}
          data-sheet={id}
          style={{
            position: 'absolute', left: s.x, top: s.y, width: s.w, height: s.h,
            ...paperCard('far'),
            // 纸比台面亮一点、比物件卡素一点；左侧一道极淡的装订痕（首页稿纸同语言）
            boxSizing: 'border-box',
          }}
        >
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 1,
            background: 'rgba(155,60,44,0.16)', marginLeft: 18,
          }} />
          {(s.title || id) && (
            <div style={{
              position: 'absolute', left: 28, top: 4,
              fontFamily: FONT_KAI, fontSize: 12, color: 'rgba(43,33,23,0.38)',
              userSelect: 'none', whiteSpace: 'nowrap',
            }}>
              {s.title ? `${s.title} · ${id}` : id}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
