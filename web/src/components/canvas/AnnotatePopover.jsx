import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Send, PenLine, Layers } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_KAI, FONT_SIZE } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { isImeEnter } from '../../lib/helpers.js';

/**
 * AnnotatePopover —— 就地标注（2026-08-13，E3；同日二改收成唯一入口）。
 *
 * 在一个画布物件/文件夹上写一句话。入口两处：**右键菜单**和**卡片右上角的
 * 标注按钮**。写完有三个出口：
 *
 *   - **发给 agent**（主）：起一轮，agent 立刻来处理这句话。
 *   - **攒着**（2026-08-13 用户提）：进 pending-changes buffer，右下角那条
 *     「发给 agent（N 条标注）」浮钮攒够了一次发。走查画布时的真实节奏是
 *     "这张不对、那张也不对、还有那个"，逐条起轮 = 三轮并发抢同一批文件。
 *   - **留在画布**（次）：落成一段画布文字 + 一条 `annotates` 关系线，
 *     agent 不知道 —— 这是给自己/给以后看的记号。
 *
 * ## 为什么工具栏那个「标注(C)」被删了
 *
 * 在这之前同一件事有两套：工具栏的 C（点物件 → 写字 → 只留在画布）和这张纸
 * （右键 → 写字 → 只发给 agent）。两套各缺对方那一半，用户还得先知道自己
 * 想要哪一半才能选对入口。收成一处的判据是：**标注的对象永远是一个具体的
 * 东西**，所以它属于那个东西的菜单，而不属于「要先在空地上起手势」的工具栏。
 *
 * 位置/portal/关闭规则照 ContextMenu：屏幕坐标 fixed、portal 到 body
 * （画布 section 的 isolation 会把 z-index 关在里面）、贴边翻转、
 * Esc / 点别处关掉。
 */

const POP_W = 320;

export default function AnnotatePopover({ x, y, target, roleTarget = null, onSubmit, onKeep, onQueue, onClose }) {
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [flip, setFlip] = useState({ x: false, y: false });

  useEffect(() => {
    setFlip({ x: x + POP_W + 8 > window.innerWidth, y: y + 150 + 8 > window.innerHeight });
  }, [x, y]);

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // 捕获阶段：画布自己的 Esc 是"回上一层"，不拦住的话关个浮层顺便换了层
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onClose();
    onSubmit(t);
  };

  const keep = () => {
    const t = text.trim();
    if (!t) return;
    onClose();
    onKeep?.(t);
  };

  const queue = () => {
    const t = text.trim();
    if (!t) return;
    onClose();
    onQueue?.(t);
  };

  return createPortal((
    <div
      ref={ref}
      data-no-pan
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: flip.x ? undefined : x,
        right: flip.x ? window.innerWidth - x : undefined,
        top: flip.y ? undefined : y,
        bottom: flip.y ? window.innerHeight - y : undefined,
        width: POP_W, zIndex: 9000,
        background: PAPER.paper, backgroundImage: GRAIN,
        borderRadius: 2, boxShadow: PAPER_SHADOW.near,
        padding: GAP.md,
        animation: 'ndPopIn 120ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <div style={{
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.sub,
        marginBottom: GAP.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        标注 · {target.typeLabel}「{target.title}」
      </div>
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();   // 画布的单键换工具不能在打字时触发
          // 同 ChatComposer 的惯例：Enter 发送、Shift+Enter 换行（IME 守卫必带）
          if (e.key === 'Enter' && !e.shiftKey) {
            if (isImeEnter(e)) return;
            e.preventDefault();
            submit();
          }
        }}
        placeholder="想怎么改 / 想让它变成什么…"
        style={{
          width: '100%', resize: 'none', boxSizing: 'border-box',
          border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.sm,
          padding: GAP.sm, outline: 'none',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, lineHeight: 1.6,
          color: COLOR.text, background: COLOR.bgWhite,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', marginTop: GAP.sm, gap: GAP.xs, justifyContent: 'flex-end' }}>
        {/* 次出口：写下的话不发出去，落在画布上（一段字 + 一条连到它的线）。
            做成朴素文字按钮而不是第二个实心钮 —— 一张纸上两个同样重的按钮，
            用户每次都要停下来读一遍才知道按哪个。 */}
        {onKeep && (
          <button
            onClick={keep}
            disabled={!text.trim()}
            title="不发消息，只在画布上留一条连到它的标注"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              border: 'none', borderRadius: RADIUS.sm, background: 'transparent',
              color: text.trim() ? COLOR.sub : COLOR.borderLt,
              cursor: text.trim() ? 'pointer' : 'default',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            }}
          >
            <PenLine size={12} /> 留在画布
          </button>
        )}
        {onQueue && (
          <button
            onClick={queue}
            disabled={!text.trim()}
            title={roleTarget
              ? `攒着会发给主控，不是${roleTarget.who}——想直接说给它就用右边那颗`
              : '先记下，攒够了从右下角那条浮钮一次发给 agent'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              padding: `${GAP.xs}px ${GAP.sm}px`,
              border: 'none', borderRadius: RADIUS.sm, background: 'transparent',
              color: text.trim() ? COLOR.sub : COLOR.borderLt,
              cursor: text.trim() ? 'pointer' : 'default',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            }}
          >
            <Layers size={12} /> 攒着
          </button>
        )}
        <button
          onClick={submit}
          disabled={!text.trim()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs}px ${GAP.md}px`,
            border: 'none', borderRadius: RADIUS.sm,
            background: text.trim() ? COLOR.text : COLOR.borderLt,
            color: PAPER.paper, cursor: text.trim() ? 'pointer' : 'default',
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          }}
        >
          <Send size={12} /> {roleTarget ? `说给${roleTarget.who}` : '发给 agent'}
        </button>
      </div>
    </div>
  ), document.body);
}
