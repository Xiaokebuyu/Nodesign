/**
 * AnnotationNote —— 画布标注消息上面那行小字（2026-08-28）
 *
 * 用户在板上圈一段字回话时，前端拼的那条里带着路径、作者、原文摘录、reply_to 指令。
 * 那些是**给 agent 的**（它要靠它们接线程、知道那段字说了什么），发出去的内容一个字不动；
 * 但侧边栏原样显示，用户自己那句话就淹在机械里 —— 用户报的就是这个。
 *
 * 所以只管显示：机械折起来，留一行「标注 · 板书「第一章-放学后」」，点开能看全。
 * 拆分判据在 lib/annotation-message.js（有单测，认不出就不折叠，绝不猜着切）。
 */
import { ChevronDown } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../../lib/theme.js';

export default function AnnotationNote({ desc, what = [], open, onToggle }) {
  return (
    <>
      <button
        onClick={onToggle}
        title={open ? '收起给 agent 的那段' : '看看发给 agent 的完整内容'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          marginBottom: GAP.xs,
          padding: 0, background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs || 11,
          color: COLOR.sub, maxWidth: '100%',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {what.length ? `标注 · ${what.join('、')}` : '画布标注'}
        </span>
        <ChevronDown size={11} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div style={{
          marginBottom: GAP.xs,
          padding: `${GAP.sm}px ${GAP.md}px`,
          background: COLOR.bgCard, color: COLOR.text2,
          border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.md,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs || 11, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{desc}</div>
      )}
    </>
  );
}
