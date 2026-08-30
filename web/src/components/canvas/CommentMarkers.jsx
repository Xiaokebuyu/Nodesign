import { useEffect, useState, useMemo } from 'react';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { overlayBase, toOverlayXY } from '../../lib/overlay-rect.js';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, EDITOR, alpha } from '../../lib/theme.js';

/**
 * CommentMarkers — 已评论元素的视觉标记（橙色框 + 右上角"已评论"标签）
 *
 * 2026-05-07 新增：用户对某元素评论后，元素被持久标橙框 + 标签，
 * 让用户一眼看出哪些地方提了反馈。
 *
 * 实现思路（参考 EditOverlay）：
 *   - 按 anchor 去重（同元素多条评论合并显示一条标签 + count）
 *   - 实时 findElementByAnchor + getBoundingClientRect → 外层 absolute overlay
 *   - 监听 iframe scroll / window resize → setTick 重渲染
 *   - resolved 评论不渲染（避免噪音）
 *   - 标签 pointer-events: auto，点一下选中该 anchor（onSelectAnchor）
 */
export default function CommentMarkers({
  comments = [],
  iframeRef,
  zoom = 1,
  onSelectAnchor,
}) {
  const [, setTick] = useState(0);

  // 同 EditOverlay 的滚动 / resize 触发
  useEffect(() => {
    if (comments.length === 0) return undefined;
    const iframe = iframeRef?.current;
    if (!iframe) return undefined;
    const win = iframe.contentWindow;
    if (!win) return undefined;

    let rafId = null;
    const trigger = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setTick(t => t + 1);
      });
    };

    try {
      win.addEventListener('scroll', trigger, { passive: true, capture: true });
      win.addEventListener('resize', trigger);
      window.addEventListener('resize', trigger);
    } catch { /* cross-origin */ }

    return () => {
      try {
        win.removeEventListener('scroll', trigger, { capture: true });
        win.removeEventListener('resize', trigger);
        window.removeEventListener('resize', trigger);
      } catch { /* */ }
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [comments.length, iframeRef]);

  // 按 anchor 去重 + 过滤 resolved
  const groups = useMemo(() => {
    const map = new Map();
    for (const c of comments) {
      if (c.status === 'resolved') continue;
      if (!c.anchor) continue;
      const key = c.anchor.dataId || c.anchor.path;
      if (!key) continue;
      if (!map.has(key)) map.set(key, { anchor: c.anchor, items: [] });
      map.get(key).items.push(c);
    }
    return [...map.values()];
  }, [comments]);

  if (groups.length === 0 || !iframeRef?.current) return null;

  const iframe = iframeRef.current;
  const doc = iframe.contentDocument;
  if (!doc) return null;

  const iframeRect = iframe.getBoundingClientRect();
  const base = overlayBase(iframe);
  if (!base) return null;

  const win = iframe.contentWindow;
  const innerW = win?.innerWidth ?? iframeRect.width / zoom;
  const innerH = win?.innerHeight ?? iframeRect.height / zoom;

  return (
    <>
      {groups.map((g, idx) => {
        const el = findElementByAnchor(g.anchor, doc.body);
        if (!el) return null;
        const elRect = el.getBoundingClientRect();
        if (
          elRect.bottom <= 0 ||
          elRect.top >= innerH ||
          elRect.right <= 0 ||
          elRect.left >= innerW
        ) {
          return null;
        }

        const { top, left } = toOverlayXY(base, elRect.left, elRect.top, zoom);
        const width = elRect.width * zoom;
        const height = elRect.height * zoom;

        const count = g.items.length;
        const firstText = g.items[0]?.text || '';
        const previewText = firstText.length > 28 ? firstText.slice(0, 28) + '…' : firstText;

        return (
          // ⚠️ top/left: 0 不能省（2026-07-31）。这层 wrapper 一旦 position:absolute
          // 却不写偏移，用的就是「静态位置」——而它的父容器是 display:flex +
          // justify-content:center，按规范绝对定位子元素的静态位置由对齐方式决定，
          // 于是 wrapper 落在**容器水平中心**。里面两个子元素的包含块又是这层
          // wrapper，整组标记就整体右移半个容器宽（实测 ~730px）。
          // 垂直方向静态位置是内容盒顶部、偏移为 0，所以症状是"y 对、x 错"。
          <div key={idx} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
            {/* 橙色边框 */}
            <div
              style={{
                position: 'absolute',
                pointerEvents: 'none',
                top: top - 3,
                left: left - 3,
                width: width + 6,
                height: height + 6,
                border: `2px solid ${ORANGE}`,
                borderRadius: RADIUS.sm,
                boxShadow: `0 0 0 3px ${ORANGE_GLOW}`,
                zIndex: 9,
              }}
            />
            {/* 右上角标签 — 可点击选中该 anchor */}
            <button
              onClick={() => onSelectAnchor?.(g.anchor)}
              title={count > 1 ? `${count} 条评论 — 点击查看` : `已评论：${firstText}`}
              style={{
                position: 'absolute',
                pointerEvents: 'auto',
                top: top - 12,
                left: left + width - 8,
                transform: 'translateX(-100%)',
                padding: `${GAP.xxs}px ${GAP.sm}px`,
                fontFamily: FONT_MONO,
                fontSize: FONT_SIZE.xs, lineHeight: '14px', fontWeight: 500,
                color: COLOR.bgWhite,
                background: ORANGE,
                border: 'none',
                borderRadius: RADIUS.xs,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                boxShadow: SHADOW.crisp,
                zIndex: 11,
                maxWidth: Math.max(60, width),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {count > 1 ? `已评论 ${count}` : (previewText || '已评论')}
            </button>
          </div>
        );
      })}
    </>
  );
}

const ORANGE = EDITOR.orange;
const ORANGE_GLOW = alpha(EDITOR.orange, 0.18);
