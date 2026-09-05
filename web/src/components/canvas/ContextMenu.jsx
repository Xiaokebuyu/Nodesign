import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SANS, FONT_SIZE, alpha } from '../../lib/theme.js';

/**
 * ContextMenu —— 画布的右键菜单（2026-08-08）。
 *
 * 用户的话是「照着 windows 桌面设计语言，右键点击创建文件夹」。所以这里刻意
 * 不发明交互：**在哪儿右键就在哪儿弹，点一下执行，点别处 / ESC 关掉**。
 *
 * 之前全仓一个 `onContextMenu` 都没有 —— 画布上所有"新建"动作要么没有入口
 * （文件夹压根建不了，只有 agent mkdir 才会出现一个），要么藏在浮动工具栏的
 * 模式组里（写字、涂鸦）。桌面这个隐喻里，空白处右键就是最短的那条路。
 *
 * ## 位置
 *
 * 用**屏幕坐标**定位（fixed），不跟画布一起缩放 —— 菜单是界面不是内容，
 * 缩到 30% 时它不该也跟着缩成看不清。落点的世界坐标由调用方在打开时算好传进来。
 *
 * 贴边翻转：靠右边不够宽就朝左展开，靠下同理。不翻的话在画布右下角右键，
 * 菜单一半在屏幕外。
 *
 * ## ⚠️ 必须 portal 到 body
 *
 * 画布 section 上有 `isolation: 'isolate'`（那是为了让产物窗关在画布里、
 * 聊天栏永远压得住它）。副作用是**菜单的 z-index 也出不去那个层叠上下文** ——
 * 菜单标着 9000，可它只在画布这一格里算数，聊天栏在外面照样盖住它。
 * 表现极隐蔽：菜单看得见，右半截（压在聊天栏底下那部分）点了没反应，
 * 菜单还开着，像是"这一项坏了"。2026-08-13 用检查通道量出来的。
 */

const MENU_W = 176;
const ITEM_H = 30;

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [flip, setFlip] = useState({ x: false, y: false });

  useEffect(() => {
    const h = Math.max(1, items.filter(i => !i.divider).length) * ITEM_H
      + items.filter(i => i.divider).length * 9 + GAP.xs * 2;
    setFlip({
      x: x + MENU_W + 8 > window.innerWidth,
      y: y + h + 8 > window.innerHeight,
    });
  }, [x, y, items]);

  // 点别处 / ESC / 滚轮 都关掉。**捕获阶段**监听：不然点在卡片上时卡片自己的
  // handler 先跑，会在菜单还开着的时候把选中态改掉。
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

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
        width: MENU_W, zIndex: 9000,
        background: COLOR.bg,
        borderRadius: RADIUS.lg,
        boxShadow: SHADOW.menu,
        padding: `${GAP.xs}px`,
        fontFamily: FONT_SANS,
        animation: 'ndPopIn 120ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {items.map((it, i) => (it.divider ? (
        <div key={`d${i}`} style={{ height: 1, background: COLOR.borderLt, margin: `4px ${GAP.xs}px` }} />
      ) : (
        <button
          key={it.id}
          disabled={it.disabled}
          onClick={() => { onClose(); it.onClick?.(); }}
          style={{
            display: 'flex', alignItems: 'center', gap: GAP.sm,
            width: '100%', height: ITEM_H, padding: `0 ${GAP.sm}px`,
            border: 'none', background: 'transparent', borderRadius: RADIUS.md,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
            color: it.disabled ? COLOR.sub : (it.danger ? COLOR.error : COLOR.text),
            textAlign: 'left', cursor: it.disabled ? 'default' : 'pointer',
            opacity: it.disabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (!it.disabled) e.currentTarget.style.background = alpha(it.danger ? COLOR.error : COLOR.text, 0.07);
          }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          {it.icon ? <it.icon size={13} strokeWidth={1.75} /> : <span style={{ width: 13 }} />}
          <span style={{ flex: 1 }}>{it.label}</span>
          {it.hint && (
            <span style={{ fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{it.hint}</span>
          )}
        </button>
      )))}
    </div>
  ), document.body);
}
