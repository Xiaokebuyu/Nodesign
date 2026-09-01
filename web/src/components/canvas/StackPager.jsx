/**
 * StackPager —— 一摞纸翻到第几页（2026-09-01 叠纸刀 5）
 *
 * ## 为什么它不是 ReadingPager 的第二个模式
 *
 * ReadingPager 翻的是「板上的下一件东西」，翻的手段是**飞相机** —— 那套在纸横着
 * 排、竖着长的年代成立：东西在别处，镜头就得过去。叠纸之后一摞纸占同一块地，
 * 「下一页」根本不在别的地方，它就在原地，换的是**画哪一张**。相机一动不动。
 *
 * 两件事的手段不同，所以是两个件。板上没有叠起来的摞时照旧走 ReadingPager
 * （存量板全是那样），有摞才换成这个。
 *
 * ## 形态：一行，左右箭头翻页，中间点开目录
 *
 * 工具栏在手机上只有 38px 一行（08-29 从 122px 两行收敛下来的），塞不下两组箭头。
 * 所以这里只放**高频的那一轴**（翻当前这一摞的页），换摞交给目录和手势。
 * ⚠️ 中间那块是按钮不是标签：它是目录唯一的入口，长得像标签就没人点。
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { INK_SURFACE } from '../../lib/paper.js';
import { TOOL_BTN } from '../ui/ToolbarButton.jsx';

const HIT = 40;

function Arrow({ dir, disabled, onClick, label }) {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-board-action
      data-stack-pager={dir < 0 ? 'prev' : 'next'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{
        width: HIT, height: TOOL_BTN.height, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: 'none', padding: 0,
        borderRadius: TOOL_BTN.radiusIcon,
        color: disabled ? INK_SURFACE.textDim : INK_SURFACE.text,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon size={20} />
    </button>
  );
}

/**
 * @param {object} pile     当前这一摞（board-paging 的 pilesOf 出品）
 * @param {number} index    这一摞里第几页（0 起）
 * @param {Function} onFlip (dir) => void
 * @param {Function} onIndex 点中间那块 = 开目录
 */
export default function StackPager({ pile, index, onFlip, onIndex }) {
  const total = pile?.sheets?.length || 0;
  const at = Math.max(1, index + 1);
  // 摞名太长会把工具栏挤折行（08-29 收敛出来的一行不能再破），所以截断
  const label = (pile?.title || pile?.name || '').slice(0, 6);
  return (
    <div data-stack-pager="bar" style={{ display: 'flex', alignItems: 'center' }}>
      <Arrow dir={-1} disabled={at <= 1} onClick={() => onFlip(-1)} label="上一页" />
      <button
        type="button"
        data-board-action
        data-stack-pager="index"
        aria-label="这块板的目录"
        title="目录：所有的摞和页"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onIndex}
        style={{
          height: TOOL_BTN.height, padding: '0 8px', flexShrink: 0,
          background: 'transparent', border: 'none',
          borderRadius: TOOL_BTN.radiusIcon,
          fontSize: TOOL_BTN.fontSize, letterSpacing: '0.02em',
          color: INK_SURFACE.text, whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        {label ? `${label} ` : ''}{at}/{total}
      </button>
      <Arrow dir={1} disabled={at >= total} onClick={() => onFlip(1)} label="下一页" />
    </div>
  );
}
