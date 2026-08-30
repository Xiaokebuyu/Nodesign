import { Sparkles, X } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';

/**
 * SuggestionChip —— 显示 SDK 预测的下条 user prompt
 *
 * 数据来自 SDK promptSuggestions: true 选项 + run.prompt_suggestion 事件
 * （C1 events.js + C17 Project.jsx state）。
 *
 * UI：composer 顶部一颗 chip
 *   ✨ 「下一步可能想说：xxxx」  [使用]  [×]
 *
 * 点击 chip 主体 / "使用" → onAccept(suggestion)（父级把 suggestion
 * 直接发送或填入 textarea）
 * 点击 × → onDismiss()（隐藏直到下次新 suggestion 来）
 */
export default function SuggestionChip({ suggestion, onAccept, onDismiss }) {
  if (!suggestion) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: GAP.sm,
      padding: `${GAP.sm}px ${GAP.md}px`,
      background: 'rgba(43,33,23, 0.05)',
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: RADIUS.xl,
      fontFamily: FONT_SANS,
      fontSize: FONT_SIZE.sm,
      color: COLOR.text2,
    }}>
      <Sparkles size={13} color={COLOR.text4} style={{ flexShrink: 0, marginTop: GAP.xxs }} />

      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <div style={{ fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.xxs, letterSpacing: '0.02em' }}>
          下一步可能想说
        </div>
        <div>{suggestion}</div>
      </div>

      <div style={{ display: 'flex', gap: GAP.xs, alignItems: 'center', flexShrink: 0 }}>
        <button
          onClick={() => onAccept?.(suggestion)}
          title="使用这条建议"
          style={{
            padding: `${GAP.xs}px ${GAP.sm + 2}px`,
            background: COLOR.btn,
            color: COLOR.btnText,
            border: 'none',
            borderRadius: RADIUS.md,
            fontFamily: FONT_SANS,
            fontSize: FONT_SIZE.xs,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          使用
        </button>
        <button
          onClick={onDismiss}
          title="忽略"
          style={{
            width: 22,
            height: 22,
            background: 'transparent',
            border: 'none',
            borderRadius: RADIUS.sm,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLOR.sub,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.05)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
