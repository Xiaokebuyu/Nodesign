/**
 * 画布那条常驻工具栏的内容（2026-08-17 从 BoardCanvas 拆出 —— 行数棘轮）。
 *
 * **这里只造数据，不渲染**。全项目只有一条工具栏，活在 CanvasFrame，内容跟
 * 当前焦点走（没开窗是这一份，开了窗是那扇窗的）—— 这个结构 2026-08-13 定的，
 * 病根是"同一件东西有多个实例"，别在这儿再画一条出来。
 *
 * 调用方仍然要用 useMemo 包住它，而且**镜头动作必须先经 ref 转一手**：理由
 * 记在 BoardCanvas 那个 memo 的头上（每帧换身份 → 死循环，build 和单测都照不出来）。
 */
import { Maximize2, Minus, Plus, MousePointer2, Move, Hand, Type, PenLine, LayoutGrid, Presentation, NotebookPen, MessageSquarePlus } from 'lucide-react';

/**
 * @param {object} p
 * @param {string} p.tool / p.drawMode        当前工具与涂鸦子模式
 * @param {Function} p.setTool / p.setDrawMode
 * @param {number} p.scale                    当前缩放（只用来印百分比）
 * @param {Function} p.tidyBoard              整理
 * @param {Function} p.zoomFit / p.zoomBy / p.zoomTo   **要传 ref 转过手的稳定引用**
 * @param {object} [p.filterGroup]  按类别过滤那颗漏斗（`{id, node}`，自己带 JSX ——
 *   本文件是 .js 且"只造数据不渲染"，所以节点在 board-filter.jsx 里造好了递进来）
 */
export function buildBoardToolGroups({
  tool, setTool, drawMode, setDrawMode, scale,
  tidyBoard, zoomFit, zoomBy, zoomTo, filterGroup,
  blackboardMode = false, toggleBlackboard = null,
  chalkEditMode = false, toggleChalkEdit = null,
  openCanvasNote = null,
}) {
  return ([
    ...(filterGroup ? [filterGroup] : []),
    {
      id: 'view',
      items: [
        {
          id: 'tidy', icon: LayoutGrid, label: '整理',
          title: '重排这块画布上的产物（自动排版只在新产物到货时跑一次，别的时候不动你摆的位置）',
          onClick: tidyBoard,
        },
        { id: 'fit', icon: Maximize2, label: '全部', title: '全部内容入镜（Shift+1）', onClick: zoomFit },
        { id: 'zoomOut', icon: Minus, title: '缩小（Ctrl -）', onClick: () => zoomBy(-1) },
        { id: 'zoomLevel', icon: null, label: `${Math.round(scale * 100)}%`, title: '回到 100%（Ctrl 0）', onClick: () => zoomTo(1) },
        { id: 'zoomIn', icon: Plus, title: '放大（Ctrl +）', onClick: () => zoomBy(1) },
        // 黑板模式（2026-08-23）：画布取代侧栏成为主窗口 —— agent 每轮主体内容落画布、
        // 聊天只留一两句，草图落下时镜头跟过去。开关是项目级偏好（ui-config.json）。
        ...(toggleBlackboard ? [{
          id: 'blackboard', icon: Presentation, label: '黑板', active: blackboardMode,
          title: blackboardMode
            ? '黑板模式：开 —— agent 把想法画在画布上、聊天只旁白、镜头跟着新图走。点一下关'
            : '黑板模式：关 —— 开了以后 agent 默认把讨论画到画布上，聊天只留一两句，镜头跟着新图走',
          onClick: toggleBlackboard,
        }] : []),
        // 板书编辑开关（2026-08-24 用户提，防误触）：关着（默认）时板书对单击/
        // 拖拽是空地，双击才武装成可拖可编辑；开着时板书随时可选中、双击进编辑
        ...(toggleChalkEdit ? [{
          id: 'chalkEdit', icon: NotebookPen, label: '改板书', active: chalkEditMode,
          title: chalkEditMode
            ? '板书编辑：开 —— 板书随时可拖动，双击进编辑。点一下关'
            : '板书编辑：关 —— 板书防误触：对手势是空地（框选仍可整批选中拖动）。要动板书就点开，agent 也会替你开',
          onClick: toggleChalkEdit,
        }] : []),
        // 常驻评论钮（2026-08-25 用户提）：画布态也要有开口说话的地方 —— 选中了
        // 东西就标注选中集，没选就对整块画布说一句（发给 agent / 攒着两条路照旧）
        ...(openCanvasNote ? [{
          id: 'canvasNote', icon: MessageSquarePlus, label: '评论',
          title: '对选中的东西（没选就对整块画布）说一句：发给 agent 立刻处理，或先攒着一起发',
          onClick: openCanvasNote,
        }] : []),
      ],
    },
    {
      id: 'tools',
      type: 'mode',
      value: tool,
      onChange: setTool,
      items: [
        {
          id: 'select', icon: MousePointer2,
          // 「按住空格」原来只写在抓手的 tooltip 上 —— 抓手退役了，那句唯一的
          // 告示得有地方接住，否则等于拿一个隐藏功能换掉一个可见功能。
          title: '指针：选中和挪动东西（V）。拖空地挪镜头；画面塞满没空地时按住空格拖',
        },
        { id: 'text', icon: Type, title: '写一段字（T）：双击空地落输入框，单击照常选中/拖动' },
        { id: 'draw', icon: PenLine, title: '涂鸦（P）' },
        // 标注 2026-08-13 从这儿撤了：它的对象永远是一个具体物件，
        // 所以入口在物件自己身上（右键菜单 / 卡片右上角的标注按钮），
        // 工具栏只留"要在空地上起手势"的那几种。
        //
        // 抓手 2026-08-17 退役：挪镜头本来就有五条路（滚轮/触控板两指、指针拖
        // 空地、中键拖、按住空格拖、抓手），它是第五条，唯一独有的只是"不用按
        // 住任何键"。而它换来的是模式工具的通病 —— 选了忘了切回来，画布就变得
        // 什么都点不动。空格态（isHandMode）留着，它才是"没空地时"的正解。
      ],
    },
    // 拿着笔时多出的子模式组：落笔 / 摆放（见 drawMode 的说明）
    ...(tool === 'draw' ? [{
      id: 'drawMode',
      type: 'mode',
      value: drawMode,
      onChange: setDrawMode,
      items: [
        { id: 'ink', icon: PenLine, label: '落笔', title: '只管画 —— 不会碰到已有的墨迹' },
        { id: 'arrange', icon: Move, label: '摆放', title: '挪动/缩放已有墨迹 —— 不会落笔' },
      ],
    }] : []),
  ]);
}
