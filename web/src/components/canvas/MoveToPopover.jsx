import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, Folder, Check } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SANS, FONT_KAI, FONT_SIZE, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, GRAIN } from '../../lib/paper.js';
import { PORTAL_Z } from '../../lib/z-layers.js';

/**
 * MoveToPopover —— 「移动到…」的目标选择（2026-08-13）。
 *
 * ## 它替掉的是什么
 *
 * 「拖到空白处就搬出当前文件夹」。那条在当前目录模型下是必然误触的（判据
 * 拿两个不同坐标空间的数字在比，详见 BoardCanvas 里那段墓志铭），而用户要的
 * 是**更明确**：「也许移出方式可以换为右键选择移动到哪个位置」。
 *
 * ## 为什么是一张浮层而不是右键菜单里的一串项
 *
 * 目标数量不封顶（文件夹可以嵌套、可以很多）。塞进右键菜单意味着菜单长度
 * 跟着项目规模长，而右键菜单是"几件固定动作"的地方。浮层可以滚、可以缩进
 * 显示层级，还能一次服务多件（批量移动传一组 id 进来，标题变成"移动 5 件"）。
 *
 * ## 目标列表的规矩
 *
 * - **桌面永远在第一个**：工作区根不是"某个文件夹"，它是回到最外面那一层。
 * - 缩进 = 层级，名字取路径末段（id 就是路径，这跟画布上的文件夹卡同一套）。
 * - 当前所在的那层标成"已在这儿"并禁用 —— 它是选项，只是选了等于没选。
 * - `exclude` 里的（自己、自己的子孙）根本不列：把文件夹搬进自己肚子里，
 *   服务端会拒（400），但让用户点得到一个必然失败的选项本身就是设计缺陷。
 */

const POP_W = 244;
const MAX_H = 320;

export default function MoveToPopover({ x, y, folders = [], current = '', exclude = [], count = 1, onPick, onClose }) {
  const ref = useRef(null);
  const [flip, setFlip] = useState({ x: false, y: false });

  useEffect(() => {
    setFlip({ x: x + POP_W + 8 > window.innerWidth, y: y + MAX_H + 8 > window.innerHeight });
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

  const blocked = new Set(exclude);
  const targets = folders
    .filter(f => !blocked.has(f) && ![...blocked].some(b => f.startsWith(`${b}/`)))
    .sort((a, b) => a.localeCompare(b));

  const row = (id, label, Icon, depth) => {
    const here = (id || '') === (current || '');
    return (
      <button
        key={id || '__root__'}
        disabled={here}
        onClick={() => { onClose(); onPick(id); }}
        style={{
          display: 'flex', alignItems: 'center', gap: GAP.sm,
          width: '100%', height: 30, padding: `0 ${GAP.sm}px 0 ${GAP.sm + depth * 12}px`,
          border: 'none', background: 'transparent', borderRadius: RADIUS.md,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
          color: here ? COLOR.sub : COLOR.text,
          textAlign: 'left', cursor: here ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => { if (!here) e.currentTarget.style.background = alpha(COLOR.text, 0.07); }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon size={13} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {here && <Check size={12} />}
      </button>
    );
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
        width: POP_W, maxHeight: MAX_H, zIndex: PORTAL_Z.POPOVER,
        display: 'flex', flexDirection: 'column',
        background: PAPER.paper, backgroundImage: GRAIN,
        borderRadius: 2, boxShadow: PAPER_SHADOW.near,
        padding: GAP.xs,
        animation: 'ndPopIn 120ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <div style={{
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        padding: `${GAP.xs}px ${GAP.sm}px`,
      }}>
        移动到{count > 1 ? ` · ${count} 件` : ''}
      </div>
      <div style={{ overflowY: 'auto', minHeight: 0 }}>
        {row('', '桌面', Monitor, 0)}
        {targets.map(f => row(f, f.split('/').pop(), Folder, f.split('/').length - 1))}
      </div>
    </div>
  ), document.body);
}
