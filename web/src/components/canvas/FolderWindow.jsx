import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, ChevronLeft } from 'lucide-react';
import { COLOR, FONT_KAI, FONT_SIZE } from '../../lib/theme.js';
import { FOLDER_CARD, packRow } from '../../lib/board-geometry.js';
import { sizeOf } from '../../lib/board-kinds.js';
import ArtifactWindow from './ArtifactWindow.jsx';
import { GENERATED_DIR, GENERATED_TITLE } from '../../lib/generated-folder.js';

/**
 * FolderWindow —— 打开一个文件夹（2026-08-13）。
 *
 * ## 它替掉的是什么
 *
 * 「进文件夹 = 整块桌面换成它那一层」（cwd 模型）。用户拍板改成**用统一那扇窗
 * 打开**：桌面不动，文件夹在窗里摊开，关掉就回来。差别在心智上：换层的时候
 * 你**离开了**桌面，得记住自己在第几层、怎么退回去；开窗的时候桌面还在那儿，
 * 窗只是暂时盖住它。
 *
 * 窗壳直接用 ArtifactWindow —— deck / 站点 / 世界都用它。文件夹是第四种"打开
 * 一件东西"，没有理由长成第四种样子。
 *
 * ## 里面是网格，不是自由版面
 *
 * 桌面那一层是自由摆位（坐标存 board.json），窗里是**算出来的网格**。这是取舍
 * 不是省事：一扇会随窗宽变化的容器里，绝对坐标要么被裁掉要么留下大片空白，
 * 而"我把这张卡放在右下角"这种记忆在一个可关可开的窗里也立不住。自由版面留给
 * 桌面这一层。
 *
 * ## 卡片是**同一批组件**
 *
 * 产物卡和文件夹卡都由调用方（BoardCanvas）用它自己那套 render 函数画进来 ——
 * 窗只负责算位置。抄一套"窗内简版卡"就是第二个真相源：hover 工具条、标注按钮、
 * 缩略图闸门、双击语义，每一样都要在两个地方各修一遍。
 */

/** 内容四周留白 */
const PAD = 24;

export default function FolderWindow({
  dir,
  /** (dir) => { folders:[{id,title,count,peek,…}], items:[物件] } */
  list,
  /** 面包屑上一级（null = 已在最外层，返回键关窗）*/
  onUp,
  onClose,
  onNewFolder,
  /** (o, pos) => ReactNode —— 产物卡（BoardCanvas 那套 handler 原样带过来）*/
  renderObject,
  /** (z, pos) => ReactNode —— 文件夹卡 */
  renderFolder,
  onContextMenu,
  onToolbarGroups,
}) {
  const bodyRef = useRef(null);
  const [width, setWidth] = useState(0);

  // 网格按**真实内容宽**排。写死一个宽度的话，窄屏上卡会溢出、宽屏上右边空一大块
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /**
   * ⚠️ 工具组**必须 memo**，不能在 JSX 里现写一个字面量。
   *
   * ArtifactWindow 那条 effect 的依赖里有 `groups`，而它的清理函数会
   * `onToolbarGroups(null)`。每次渲染都给一个新数组 = 每次渲染都触发
   * 「清空 → 重设」两次状态变更，而状态变更又引起渲染 —— 死循环，
   * React 报 "Maximum update depth exceeded"（2026-08-13 真跑撞到，
   * 检查通道二分出来的）。deck / 站点那几扇窗一直是 memo 的，所以没事。
   */
  const groups = useMemo(() => ([{
    id: 'folder',
    items: [
      ...(onUp ? [{ id: 'up', icon: ChevronLeft, label: '上一层', title: '回到上一层文件夹', onClick: onUp }] : []),
      // 生成图文件夹里不建子夹（服务端也拒：它在 assets/ 下）
      ...(dir === GENERATED_DIR ? [] : [{ id: 'new', icon: FolderPlus, label: '新建文件夹', title: '在这个文件夹里新建一个', onClick: () => onNewFolder?.(dir) }]),
    ],
  }]), [onUp, onNewFolder, dir]);

  const { folders = [], items = [] } = list(dir) || {};

  // 文件夹在前、产物在后（跟"这一层装了什么"的直觉一致：容器先，内容后）
  const cells = [
    ...folders.map(z => ({ kind: 'folder', z, w: FOLDER_CARD.w, h: FOLDER_CARD.h })),
    ...items.map((o) => { const sz = sizeOf(o); return { kind: 'object', o, w: sz.w, h: sz.h }; }),
  ];
  // packRow 按固定列宽铺（COL_W/COL_GAP 在 board-geometry 里），跟桌面上
  // 新产物自动落位用的是同一个函数 —— 两处网格长得一样不是巧合，是同一个实现
  const packed = packRow(
    cells.map((c, i) => ({ id: String(i), w: c.w, h: c.h })),
    { width: Math.max(320, width) - PAD * 2, xMin: PAD, yTop: PAD },
  );
  const slots = new Map(packed.slots.map(s => [s.id, s]));

  const empty = !cells.length;

  return (
    <ArtifactWindow
      kind="folder"
      title={dir === GENERATED_DIR ? GENERATED_TITLE : (dir.split('/').pop() || '文件夹')}
      subtitle={dir.includes('/') ? dir : null}
      onClose={onClose}
      onToolbarGroups={onToolbarGroups}
      groups={groups}
      /**
       * ⚠️ `scrollbarGutter: stable` 不是美化，是**防死循环**：网格按容器宽排，
       * 而 `overflow:auto` 的滚动条一出一进会让 clientWidth 抖 15px —— 宽了排得下
       * 于是没有滚动条、窄了排不下于是又有，两个状态互相触发，React 直接报
       * "Maximum update depth exceeded"（2026-08-13 真跑撞到）。留着滚动条的位，
       * 宽度就是常数。
       */
      contentStyle={{ overflowY: 'scroll', overflowX: 'hidden', scrollbarGutter: 'stable', background: 'transparent' }}
    >
      {/* `data-folder-window` 是**身份标记**：右键菜单据它判断"这一下发生在窗里"
          （窗里的空白右键该建在这一层，而不是掉进画布那套几何命中） */}
      <div
        ref={bodyRef}
        data-folder-window={dir}
        // 窗在画布 pane 之外，pane 上那个 onContextMenu 到不了这儿 —— 不接这条，
        // 窗里右键弹的是浏览器自带菜单
        onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e); }}
        style={{ position: 'relative', minHeight: '100%', width: '100%' }}
      >
        {empty ? (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          }}>
            这个文件夹是空的
          </div>
        ) : cells.map((c, i) => {
          const s = slots.get(String(i)) || { x: PAD, y: PAD };
          const pos = { x: s.x, y: s.y };
          return (
            <div key={c.kind === 'folder' ? c.z.id : c.o.id}>
              {c.kind === 'folder'
                ? renderFolder(c.z, pos)
                : renderObject(c.o, pos)}
            </div>
          );
        })}
        {/* 底部留白：最后一行的卡不贴着窗底，滚到底时看得出"到头了" */}
        <div style={{ position: 'absolute', top: packed.bottom + PAD, height: 1, width: 1 }} />
      </div>
    </ArtifactWindow>
  );
}

/** 一层文件夹的路径 → 面包屑用的上一级（'' = 根，返回 null 表示已经在最外层）*/
export function parentDir(dir) {
  // 生成图文件夹住在 assets/ 下面，而 assets/ 不是用户的文件夹：它的上一层就是桌面（09-18）
  if (dir === GENERATED_DIR) return null;
  const i = String(dir || '').lastIndexOf('/');
  return i > 0 ? dir.slice(0, i) : null;
}
