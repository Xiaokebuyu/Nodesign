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
import { Maximize2, Minus, Plus, MousePointer2, Move, Hand, Type, PenLine, NotebookPen, MessageSquarePlus } from 'lucide-react';

/**
 * @param {object} p
 * @param {string} p.tool / p.drawMode        当前工具与涂鸦子模式
 * @param {Function} p.setTool / p.setDrawMode
 * @param {number} p.scale                    当前缩放（只用来印百分比）
 * @param {Function} p.zoomFit / p.zoomBy / p.zoomTo   **要传 ref 转过手的稳定引用**
 * @param {object} [p.filterGroup]  按类别过滤那颗漏斗（`{id, node}`，自己带 JSX ——
 *   本文件是 .js 且"只造数据不渲染"，所以节点在 board-filter.jsx 里造好了递进来）
 * @param {'phone'|'tablet'|'desktop'} [p.deviceClass]  见 lib/device-class.js
 *
 * ## 手机上少哪几颗（2026-08-31 起只剩手机这一档）
 *
 * 08-28 这里撤的是**整个触屏档**的指针 / 文字 / 涂鸦，理由写的是「它们在触屏上
 * 按了没反应」：useBoardCamera 的 shouldPan 里手指一落下就推画面，落不了笔。
 *
 * ⭐ 08-31 把那条规矩本身换掉了（两指永远归相机、单指归当前工具，理由在
 * useBoardCamera 头上），平板于是走回桌面那套，这三颗跟着回来。**手机保留旧规矩**，
 * 因为 390 宽的屏上卡片几乎铺满，"先找一块空地才能推画面"等于推不动 ——
 * 所以手机上这三颗仍然按不出反应，仍然不给。
 *
 * ⭐ 手机只再少两颗：缩放的 −/+，捏合是更自然的那条路（百分比那颗点一下回 100%，留着）。
 * 「改板书」08-31 起**三档都有** —— 它原来手机上没有，理由是站主拍板「手机上只读 + 对话」，
 * 而同一天他拍板把它放回来（占掉下架的「黑板」那一格）。⚠️ 它跟 useBoardObjectDrag
 * 那条板书防误触闸是绑死的，改这一格必须同时改那一条，否则是个按了没反应的假开关。
 * （这里原来还有「整理」和「黑板」，2026-08-31 先后整颗下架，都不再分设备档。）
 */
export function buildBoardToolGroups({
  tool, setTool, drawMode, setDrawMode, scale,
  zoomFit, zoomBy, zoomTo, filterGroup,
  chalkEditMode = false, toggleChalkEdit = null,
  openCanvasNote = null,
  deviceClass = 'desktop',
  readGroup = null,
}) {
  const phone = deviceClass === 'phone';
  return dropLabelsOnPhone(phone, ([
    ...(filterGroup ? [filterGroup] : []),
    // 翻件（触屏才有；件在 ReadingPager.jsx）。排在最前 —— 手机上「我读到哪」
    // 比「缩放多少」更常看，而拇指够得最舒服的是这条的左半边
    ...(readGroup ? [readGroup] : []),
    {
      id: 'view',
      items: [
        // ⚠️ 「整理」2026-08-31 撤了（右键菜单那颗同批）。它删的是根层物件的**整条**
        // 布局记录（tag / by / seat / 实测 w,h 一起没），而版面归属今天分属 agent、
        // 用户、暂存架三方，一键全局重排必然越界。理由与两件旧功能的去处写在
        // BoardCanvas.jsx 那块墓碑注释上，别在这儿重造一颗。
        { id: 'fit', icon: Maximize2, label: '全部', title: '全部内容入镜（Shift+1）', onClick: zoomFit },
        ...(phone ? [] : [{ id: 'zoomOut', icon: Minus, title: '缩小（Ctrl -）', onClick: () => zoomBy(-1) }]),
        { id: 'zoomLevel', icon: null, label: `${Math.round(scale * 100)}%`, title: '回到 100%（Ctrl 0）', onClick: () => zoomTo(1) },
        ...(phone ? [] : [{ id: 'zoomIn', icon: Plus, title: '放大（Ctrl +）', onClick: () => zoomBy(1) }]),
        // ⚠️ 「黑板」2026-08-31 整颗下架。它是 08-23 的遗留：那时画布取代侧栏成为主窗口
        // 是一件要选的事，今天它就是这个产品本身，桌面和移动端一律在这个模式里。
        // 实证：全库 ui-config.json 里写过 blackboard_mode 的项目 **0 个** —— 上线至今
        // 没有任何人用这颗按钮关过它。模式本身没拆（默认 true，服务端 UserPromptSubmit
        // 照旧读它注入「主体内容落画布」，镜头跟随照旧），拆的只是这个选项。
        // 真要再给用户一个关它的口子，先想清楚关掉之后 agent 该把东西放哪。
        // 板书编辑开关（2026-08-24 用户提，防误触）：关着（默认）时板书对单击/
        // 拖拽是空地，双击才武装成可拖可编辑；开着时板书随时可选中、双击进编辑
        // 板书可移动（2026-08-31 站主拍板，占了「黑板」腾出来的那一格）：手机上从此也有。
        // 这一格的存在**同时解除了** useBoardObjectDrag 那条「板书一律不给拖」——
        // 08-29 立那条闸的理由原文是「它在桌面上有专门的防误触闸，而那颗按钮手机上撤掉了」，
        // 按钮回来了，理由就不成立了，两处必须一起改，只改一处就是留个假开关。
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
    ...(phone ? [] : [{
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
    }]),
    // 拿着笔时多出的子模式组：落笔 / 摆放（见 drawMode 的说明）
    ...(tool === 'draw' && !phone ? [{
      id: 'drawMode',
      type: 'mode',
      value: drawMode,
      onChange: setDrawMode,
      items: [
        { id: 'ink', icon: PenLine, label: '落笔', title: '只管画 —— 不会碰到已有的墨迹' },
        { id: 'arrange', icon: Move, label: '摆放', title: '挪动/缩放已有墨迹 —— 不会落笔' },
      ],
    }] : []),
  ]));
}

/**
 * 手机上按钮只留图标（2026-08-28）。
 *
 * 390 宽的屏上，「整理 全部 − 84% + 黑板 改板书 评论」这一条量到 **80px 两行**，
 * 常驻压着内容。折行的主因是那几个中文标签 —— 一个「黑板」比它的图标宽出一倍多。
 * 撤掉标签之后同样这些功能一行放得下。
 * （那一条里的「整理」08-31 已整颗下架。原话照抄是为了留住当时量到的那条基线。）
 *
 * ⚠️ **没有图标的那颗不许动**（缩放百分比 icon:null label:'84%'）—— 撤了它的标签
 * 就是一颗空按钮。所以判据是「有图标才撤标签」，不是「一律撤」。
 * title 一律留着：那是它剩下的唯一自我说明，长按/读屏都靠它。
 */
function dropLabelsOnPhone(phone, groups) {
  if (!phone) return groups;
  return groups.map((g) => (g.items
    ? { ...g, items: g.items.map((it) => (it.icon ? { ...it, label: undefined } : it)) }
    : g));
}
