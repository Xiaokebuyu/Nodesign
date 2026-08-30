import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, ChevronsUpDown, Focus, Group, Check, Download, Eraser, MessageSquarePlus, Archive } from 'lucide-react';
import RollLayer, { useRollActions } from './RollLayer.jsx';
import { Assets, Canvas, SessionConfig } from '../../lib/api.js';
import { exportCard } from './card-export.js';
import { joinRel } from '../../lib/paths.js';
import { orderWithGroups } from '../../lib/relation-order.js';
import { computeDesktopSeating } from '../../lib/board-seating.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, alpha } from '../../lib/theme.js';
import { PAPER, PAPER_SHADOW, paperCard } from '../../lib/paper.js';
import {
  DESKTOP_W, MARGIN_X, FOLDER_CARD,
  EASE, POP_IN, newStackedZoneRect, packRow, ROW_GAP,
} from '../../lib/board-geometry.js';
import { useLiveChalkSpots } from './use-live-chalk-spots.js';
import { useObjectClick } from './useObjectClick.js';
import {
  SIZES, sizeOf, actionsOf, isFileBacked, dragMovesFile, chromeOf, cardOf, annotTargetOf, cardIdOf, passesFilter, isDirArtifact, isArchivePath,
} from '../../lib/board-kinds.js';
import { deriveBoardObjects } from '../../lib/board-objects.js';
import BoardObject from './cards/BoardObject.jsx';
import FolderCard from './cards/FolderCard.jsx';
import TransformControls from './TransformControls.jsx';
import ChalkSizeHandles from './ChalkSizeHandles.jsx';
import Minimap from './Minimap.jsx';
import { useBoardCamera } from './useBoardCamera.js';
import { submitLinkPop, deleteLinkPop } from './link-pop-actions.js';
import { useBoardGroups } from './useBoardGroups.js';
import { useBlackboardWiring } from './useBlackboardMode.js';
import { eyeParams } from './eye-mode.js';
import { boxUnion } from '../../lib/board-camera.js';
import { objectRects, zoneRects } from '../../lib/board-rects.js';
import { emptyPresence, reducePresence, resolvePending, followTarget, rectFor as presenceRectFor, MAIN_AGENT_ID, colorFor, hintPresence, expireHint, slugOfPresence } from '../../lib/board-presence.js';
import { useStageState, splitStageCards, ChalkLiveInk, StageBoardLayer, StageDock, StageCardBody } from './StageLayer.jsx';
import { AmbientSpriteLayer, SpriteAskInput, useSpriteAmbient } from './SpriteSketchLayer.jsx';
import RoleSprites from './RoleSprites.jsx';
import { useReadingNav } from './ReadingPager.jsx';
import RoleTalkPanel from './RoleTalkPanel.jsx';
import { usePhantoms, claimPhantomSeat, phantomRects, PhantomCards } from './PhantomLayer.jsx';
import ShelfHint from './ShelfHint.jsx';
import { useBoardMoves } from './useBoardMoves.js';
import { buildBoardMenu } from './canvas-menus.js';
import { zoneOfObjectId, resolveObjectId } from '../../lib/stage.js';
import { onChrome, onObject } from '../../lib/board-hit.js';
import { TEXT_FONT_CSS, TEXT_SIZE_PX } from '../../lib/text-fonts.js';
import { splitNoteFaces, faceParts } from '../../lib/note-faces.js';
import BindingLayer from './BindingLayer.jsx';
import TagHullLayer from './TagHullLayer.jsx';
import { useBoardObjectDrag } from './useBoardObjectDrag.js';
import { staleControlIds } from '../../lib/board-controls.js';
import TextDraft from './TextDraft.jsx';
import ContextMenu from './ContextMenu.jsx';
import LinkPopover from './LinkPopover.jsx';
import AnnotatePopover from './AnnotatePopover.jsx';
import { soleRoleTarget } from '../../lib/role-target.js';
import MoveToPopover from './MoveToPopover.jsx';
import FolderWindow, { parentDir } from './FolderWindow.jsx';
import { BOARD_KEYFRAMES } from './board-keyframes.js';
import { useBoardAuthoring } from './useBoardAuthoring.js';
import { useBoardOpen } from './useBoardOpen.js';
import { usePreviewRequest } from './usePreviewRequest.js';
import { buildBoardToolGroups } from './board-tool-groups.js';
import { useMarquee } from './useMarquee.js';
import { useZoneGestures } from './useZoneGestures.js';
import { useCanvasTools, pointsToPath, pointsBounds, pathPoints, translatePath } from './useCanvasTools.js';
import { useBoardData } from './useBoardData.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import {
  ProjectPanelOverlay, MarkdownViewerOverlay, ImageDetailOverlay,
} from './BoardOverlays.jsx';
import OrchestrateSettings from './OrchestrateSettings.jsx';

/**
 * BoardCanvas —— 工作台空间画布（2026-07-27 分区版）
 *
 * Lovart 式画布：一切都是画布上可拖拽的物件。在 v1 之上加了「工作区」分区：
 *   - 每个 session 一块工作区（zone）：带标题的实体区域，画在物件下层，
 *     拖标题栏整区移动（成员跟着走）。zone 存 board.json，前端首次派生
 *     即持久化，agent 侧 pin_to_board 与这里共享同一份。
 *   - 归属 = 几何：物件中心落在区内就是这个任务的。生成图（meta.sessionId）
 *     和便签（frontmatter session）自动摆进所属工作区 —— 自动移入零操作；
 *     拖出 = 移出任务视野，拖入 = 加入，规则只有一条。
 *   - 双视图：整理模式 = 全画布自由混摆（所有 zone 可见）；工作模式 =
 *     镜头锁定当前 session 的工作区，区外物件隐藏。带 session 进入默认
 *     工作模式，纯项目入口默认整理模式。
 *   - deck 两态照旧：卡片态 ↔ 内嵌渲染态；元素级工具只在聚焦（✏️）后开放。
 *   - 「＋」统一语义 = 加入上下文托盘。
 *
 * 持久化：diff 式 PATCH（只发脏物件/脏 zone，debounce 800ms），与 agent 的
 * pin_to_board 写入互不覆盖；boardVersion 变化（board.updated 事件）时整份
 * 布局从服务端重拉，服务端为准。
 */

/**
 * 涂鸦墨色。**键必须跟服务端 `sanitizeCanvasData` 的白名单一字不差**
 * （['ink','red','pencil','brass']）—— 那边不认的颜色会被回落成 ink，
 * 这边不认的会渲染成默认色，两边不一致的表现是"我选了红色，存下来变黑"。
 */
/**
 * 约定目录的中文名。这些目录名是**给程序看的**（agent 按约定写、路由按约定扫），
 * 直接把 `notes` 印在画布上是把实现细节漏给用户。agent 自己建的收纳文件夹
 * 用它取的名字，不在这张表里，原样显示。
 */
const FOLDER_LABEL = {
  notes: '便利贴',
};

// SCRIBBLE_INK 随卡体搬去 cards/BoardObject.jsx（只有那边用；
// 它跟服务端 sanitizeCanvasData 的白名单是一对，断言在 board-kinds.test.js）


export default function BoardCanvas({
  projectId, currentSessionId, listVersion, fileVersions, boardVersion, onAddToContext, onFocusDeck,
  // 工具栏合并（2026-07-27）：画布自己不再渲工具条 —— 通过 apiRef 暴露操作、
  // onUiState 上报状态，控件统一画在外层 CanvasToolbar
  apiRef, onUiState,
  /** 把画布的工具组交给外层那条常驻工具栏（2026-08-13 范式改造） */
  onToolbarGroups,
  /**
   * 窗的工具组走**另一条线**（CanvasFrame 里 board / win 是两个槽）。
   * 混用一条的话，文件夹窗一开就把画布自己的工具组顶掉，关窗也回不来。
   */
  onWindowToolbarGroups,
  /** 每件东西攒了几条待发标注：{ [id]: n } —— 卡片左上角那枚角标 */
  noteCounts = {},
  // 舞台层（2026-07-28）：ProjectWorkspace 把 run.* 事件经这个 ref 转发进来，
  // 画布把 agent 的实时动作演出来（代码直播 / 终端 / shimmer / chip / 角标）
  stageRef,
  // 编辑窗开着时 ESC 归它（关窗），画布不抢
  deckOpen = false,
  /** 开着哪扇产物窗（CanvasFrame 算的描述串，如 deck:主稿.html）—— 只用于视点上报 */
  openWindow = null,
  /** agent 落了草图（board.focus 事件）：{ rect, tag, at }，黑板模式下镜头跟过去 */
  focusRequest = null,
  /**
   * 「让 agent 在这儿做点什么」——**画布里的 agent 入口**（2026-08-08）。
   *
   * 用户要的是「寓 agent 于各处……像随处可见的管家，而不是需要劳心费神地跑到
   * 侧边栏去使用」。所以入口不止侧边栏一个，右键菜单是第一处落点。
   *
   * 参数是**上下文而不是文案**：`{ objects?: [id], folder?: rel, at?: {x,y} }`。
   * 画布只说"用户指着这里"，怎么翻译成一句话交给外层 —— 画布不该知道
   * 聊天栏长什么样。
   */
  onAskAgent,
  /** 精灵对话通道（2026-08-14）：点星芒就地写一句，text 原样递给会话
   *  （外层接 handleSend —— 跟聊天框同一条路，跑动中就是追加/排队语义） */
  onSpriteSay,
  /**
   * 就地标注（2026-08-13，E3）：右键物件/文件夹 →「标注给 agent」→ 浮层里
   * 写一句话直接发送，agent 立刻起一轮。参数 `{ target: { kind, id, title,
   * typeLabel }, text }` —— 翻译成消息还是外层的事，同 onAskAgent。
   */
  onAnnotate,
}) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);          // 纵向滚动容器（桌面的"视口"）

  // 数据层（加载 / 持有 / 落盘）—— 2026-08-13 拆进 useBoardData.js（刀 4 续）。
  // 派生（objects/folderView）留在本组件：它跟拖拽、影子区缠在一起。
  const {
    artifacts, tasks, folders, sessions, browse, filter, filterGroup,
    layout, setLayout, zones, setZones, bindings, setBindings, boardHero, roleNames,
    rolls, setRolls, sheets, shelf,
    guideText, fileCount,
    reload, scheduleSave, patchLayout,
    layoutRef, zonesRef, dirtyRef, layoutLoadedRef, zMaxRef,
  } = useBoardData({ projectId, listVersion, boardVersion, readOnly: !!eyeParams() });
  const eyeMode = !!eyeParams();   // 眼睛模式（look_at_board 截图）：只渲染板面内容
  // 影子工作区（2026-07-28）：agent 正在往一个还不存在的任务目录里写，产物列表
  // 要等这次写完才知道它存在。先在桌面上把这块区长出来（只在内存里，不落盘），
  // 舞台卡当场就有地方贴；真任务出现后 zone 派生 effect 接管、影子退场。
  const [ghostZones, setGhostZones] = useState({});
  /**
   * 打开着的文件夹窗（`null` = 没开）。
   *
   * ⚠️ 它替掉的是 `cwd`「当前目录」—— 那套的语义是**整块桌面换成某一层**，
   * 两代之前还是 `viewMode` + `focusZoneId`（整理/工作双视图）。用户
   * 2026-08-13 拍板改成"双击文件夹用统一那扇窗打开"：桌面永远是根，进哪一层
   * 是**窗**的事。于是"我在第几层"这个状态从画布身上挪到了窗身上，画布本身
   * 回到只有一层，简单了一大截（顺带删掉了 enterZone / exitToProject /
   * 换层就 zoomToFit / ESC 退层这一整串）。
   *
   * 顶栏面包屑照旧读它（uiState.cwd）—— 那条面包屑现在导航的是窗。
   */
  const [winDir, setWinDir] = useState(null);
  const winDirRef = useRef(null);
  winDirRef.current = winDir;
  /**
   * 正在搬家的 id。
   *
   * 搬家是乐观更新：先把坐标记到**新 id** 上、旧 id 撤掉，再等服务端。那一拍里
   * 产物清单还没重拉，旧 id 还在 `objects` 里而 `layout` 里已经没有它的坐标 ——
   * 于是首次落位那一趟把它当成"新来的"，给它排个座并**写进 board.json**，
   * 留下一条指向已经不存在的路径的死行。这类幽灵条目正是"摆好的版面偶尔自己
   * 回默认位置"的来源之一。
   */
  const movingRef = useRef(new Set());
  /** 正在就地改名的东西（文件夹路径 / 物件 id）—— 卡上的名字换成输入框 */
  const [renamingId, setRenamingId] = useState(null);
  const fittedKeyRef = useRef('');        // 换层之后把镜头带过去：每层只带一次
  // 交互态
  const dragRef = useRef(null);           // { kind:'object', ... }（桌面化后只剩物件拖拽）
  const scaleRef = useRef(1);
  const folderViewRef = useRef([]);
  const camApiRef = useRef(null);   // 相机 API（hook 在下方才调用，用 ref 让上面的回调也够得着）

  /**
   * 当前工具。`select` 是默认，其余是"手上拿着东西"的状态。
   *
   * 工具是**画布级**的一个模式，不是某个物件的属性 —— 所以它住在这里，
   * 由浮动工具栏的模式组切换（FloatingToolbar 的 type:'mode'）。
   *
   * `hand`（抓手）2026-08-08 从 select 拆出来、2026-08-17 又并回去 —— 它是第五
   * 条平移路，唯一独有的只是"不用按住任何键"，换来的却是模式工具的通病：选了
   * 忘了切回来，画布就什么都点不动。完整的账在 useBoardCamera.js 头上。
   */
  const [tool, setTool] = useState('select');
  /**
   * 涂鸦的子模式（2026-08-13 用户定的双控件）：
   *   ink      落笔 —— 只管画，绝不触碰已有墨迹的控制
   *   arrange  摆放 —— 挪动/缩放已有墨迹（走选中态那套手柄），绝不落笔
   * 两件事在同一支笔下打架打过一整轮（画一笔把卡拖走、想挪笔迹却又画一笔），
   * 拆成显式模式后各自纯粹。每次拿起笔重置回落笔 —— 选笔就是想画。
   */
  const [drawMode, setDrawMode] = useState('ink');
  const drawModeRef = useRef('ink');
  drawModeRef.current = drawMode;
  useEffect(() => { if (tool === 'draw') setDrawMode('ink'); }, [tool]);
  /** 手写文字用什么字体（设置里选，见 globalStore.canvasFont） */
  const canvasFont = useGlobalStore(st => st.canvasFont);
  /** 镜头跟不跟 agent 跑（设置里的开关，默认开） */
  const followAgent = useGlobalStore(st => st.followAgent);
  /** 正在改内容的手写文字：{ id, at:{x,y}, initial }（复用 TextDraft） */
  /**
   * 选中的东西（物件 id / 文件夹 id 混装）。
   *
   * 2026-08-13 从单选（`selectedId`，只收墨类）扩成一个集合 —— 用户要「长按
   * 拖动大范围框选 + 右键批量操作」。**只有一份真相**：单选是"集合里正好一件"
   * 的派生，不另开一个状态。变换控制器（旋转/缩放）照旧只认单选的墨类，
   * 那是它的语义（转一堆东西是另一件事，没做）。
   */
  const [selectedIds, setSelectedIds] = useState([]);
  const selectedIdsRef = useRef([]);
  selectedIdsRef.current = selectedIds;
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedId;
  const setSelectedId = useCallback((id) => setSelectedIds(id ? [id] : []), []);
  /**
   * 板书编辑模式（2026-08-24 用户提）：关着（默认）时板书防误触 —— 单击/拖
   * 它就是空地（挪镜头照常），**双击**才武装成可拖可编辑；开着时板书随时可
   * 选中、双击进编辑。开关住工具栏（board-tool-groups）。
   */
  const [chalkEditMode, setChalkEditMode] = useState(false);
  const chalkEditModeRef = useRef(false);
  chalkEditModeRef.current = chalkEditMode;
  // 持久化 + agent 可拨（08-25）：存 ui-config.chalk_edit；agent 的 edit_board
  // chalk_edit op 经 WS → ProjectWorkspace → 窗口事件 nd:chalk-edit 当场生效
  useEffect(() => {
    let alive = true;
    if (projectId) SessionConfig.read(projectId).then((r) => {
      if (alive && typeof r?.config?.chalk_edit === 'boolean') setChalkEditMode(r.config.chalk_edit);
    }).catch(() => {});
    const onAgent = (e) => setChalkEditMode(!!e.detail?.on);
    window.addEventListener('nd:chalk-edit', onAgent);
    return () => { alive = false; window.removeEventListener('nd:chalk-edit', onAgent); };
  }, [projectId]);
  const toggleChalkEdit = useCallback(() => {
    setChalkEditMode((v) => {
      SessionConfig.patch(projectId, { chalk_edit: !v }).catch(() => {});
      return !v;
    });
  }, [projectId]);
  /** 框选：{ a:{sx,sy,wx,wy}, b:{…} }（sx/sy 是画布视口内像素，wx/wy 是世界坐标）*/
  const handleDeleteNoteRef = useRef(null);   // Delete 键 effect 挂得早，函数定义在下面
  const [hoveredBinding, setHoveredBinding] = useState(null);
  // 在场表。（08-14 上午曾在这儿做过"主精灵 localStorage 常驻"，当天下午
  // 被日记本范式取代：闲时精灵改为跟随用户镜头写问候语，不再钉在上次
  // 工作的物件上 —— 存位置的那套连带拆除，别留空壳。）
  const [presence, setPresence] = useState(emptyPresence);
  /** 精灵输入行（对话通道）：{x,y} 世界坐标，null = 收起 */
  const [spriteAsk, setSpriteAsk] = useState(null);
  // 跟哪个角色对话（点它的精灵打开；侧栏永远是主 agent 的，路由拍板见 RoleTalkPanel）
  const [roleTalk, setRoleTalk] = useState(null);
  const toolRef = useRef('select');
  toolRef.current = tool;
  const positionedRef = useRef([]);
  const objectsRef = useRef([]);
  const primaryOpenRef = useRef(null);  // "双击打开"的引用（preview_deck 工具复用）
  const [addedPaths, setAddedPaths] = useState(() => new Set());
  const [detail, setDetail] = useState(null);       // 图片详情
  const [viewer, setViewer] = useState(null);       // { title, content, note? } markdown 阅读；note = 可编辑的任务便利贴
  const [orchestrate, setOrchestrate] = useState(null); // { dir } 演出编排设置页（编排.yaml 双击进）
  // （编辑草稿态住 MarkdownViewerOverlay 本地 —— 浮层关闭即弃稿，B5 抽出时下沉）
  const [projectPanel, setProjectPanel] = useState(null);   // 'guide'|'files'（08-24 起记忆/风格卡退役）
  // 拖拽实时落点提示：{ kind:'zone'|'folder', id, ghost?:{x,y,w,h} }（ghost=吸附预览格）
  const [dropHint, setDropHint] = useState(null);
  const dropHintRef = useRef(null);

  // 跟随：agent 动作发生时平滑滚动过去；用户任何操作立即接管、静置后恢复。
  // 2026-07-28 开关退役 —— 行为本来就只在"没被用户接管 + 目标可见"时才动镜头，
  // 为一个自己会让位的行为留开关收益太低。
  const followRef = useRef(true);
  const userHoldUntilRef = useRef(0);       // 用户接管截止时刻（pointerdown/wheel 后 +8s）
  // 拖拽期间关掉物件/工作区的 left/top 过渡（拖拽要逐帧跟手；agent 改布局要动画）
  const [dragActive, setDragActive] = useState(false);

  // ──（数据加载 reload / 布局持久化 scheduleSave·patchLayout：2026-08-13
  //    随数据层一起搬进 useBoardData.js —— 两条铁律的注释也在那边）──

  // ⚠️ 这里曾经有 zoneSession / sessionZone 两张对照表（工作区 ↔ 会话）。
  //
  // 它们服务的是「任务=会话一对一」：点进一个任务就是回到那次对话，一个会话
  // 只服务一个任务。2026-08-08 那条绑定整个废掉了 —— 会话现在归项目，所有会话
  // 面对同一个工作区、同一批文件。跟着没有意义的还有：会话 deck 卡（一个会话
  // 自带一张卡）、「会话分区」（没有文件夹撑着的那种）、以及「进文件夹 = 切
  // 会话」这条导航。文件夹就是文件夹，对话就是对话。

  // ── 物件派生（数据源 → 物件列表；布局只管摆放）──
  //
  // 2026-08-07 起有**两类**物件：
  //   - 磁盘产物的影子（下面这一大段）：本体是文件，board.json 只存它摆在哪
  //   - 画布原生（涂鸦）：board.json 就是本体，从 layout 里带 kind 的条目还原
  // 画布物件的派生搬去 lib/board-objects.js（2026-08-17 行数棘轮拆件）：
  // 它是纯数据变换（/artifacts 载荷 → 画布物件），没有 React、可单独测。
  // 档案面（2026-08-27 用户拍板）：根 CLAUDE.md / 记忆/ 默认不上画布 ——
  // 那是 agent 的后台档案，不是产出。右上角「档案」钮显形；状态存本地
  // （跟 board-filter 同一条理由：这是这个人此刻想看什么，不是画布的属性）。
  const [showArchive, setShowArchive] = useState(() => {
    try { return window.localStorage.getItem(`nd.showArchive.${projectId}`) === '1'; } catch { return false; }
  });
  const toggleArchive = useCallback(() => {
    setShowArchive((v) => {
      try { window.localStorage.setItem(`nd.showArchive.${projectId}`, v ? '0' : '1'); } catch { /* 隐私模式 */ }
      return !v;
    });
  }, [projectId]);

  const objects = useMemo(
    () => deriveBoardObjects({ tasks, artifacts, layout, browse })
      .filter(o => passesFilter(o, filter))
      .filter(o => showArchive || !isArchivePath(o.id))
      // 收卷（2026-08-27 收纳器，件在 RollLayer.jsx）：收着的组渲染层不画（卷卡替它
      // 站着）。座位仍在 layout 里 —— 服务端落位照旧把它们当障碍。
      .filter(o => { const t = o.tag || o.pos?.tag; return !t || !rolls[t]; }),
    [tasks, artifacts, layout, browse, filter, showArchive, rolls]);

  const { rollGroup, unrollGroup } = useRollActions(projectId, setRolls);

  // 顶带摘要（08-24 记忆体系改版：记忆/风格卡退役 —— 记忆住 记忆/、风格并进
  // 根 CLAUDE.md，都是画布上的普通文件；这里只剩项目档案与文件两张）
  const bandSummaries = useMemo(() => ({
    guide: guideText.trim() ? guideText.trim().slice(0, 60) : '还没写，点开写项目档案',
    files: fileCount == null ? '' : (fileCount ? `${fileCount} 个文件` : '还没有文件，点开上传'),
  }), [guideText, fileCount]);

  const sessionTitles = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      map.set(s.sessionId || s.id, s.customTitle || s.title || s.summary || s.firstPrompt || '未命名 deck');
    }
    return map;
  }, [sessions]);

  // 文件夹标题：zone id 就是工作区相对路径，末段即标题
  const taskTitles = useMemo(
    () => new Map(tasks.filter(t => t.id).map(t => [t.id, t.title])), [tasks]);

  /**
   * 真文件夹 + 影子文件夹（影子只活在内存里，真的一出现就退场）。
   *
   * **磁盘是权威**：board.json 里的文件夹条目只有在 `folders` 里还找得到才渲染。
   * 服务端也会剪一遍，但光靠那边不够 —— 前端手上有自己那份 `/board` 数据，剪枝
   * 跟它是两条并发的路，而且任何一次 patchZone 都会把手上这份写回去，剪了又活。
   * 所以判据要放在**渲染这一层**：画不出来的东西写不回去。
   *
   * 这么剪是安全的，因为文件夹有权威清单（磁盘扫描），物件没有 —— 物件那边
   * board.json 是稀疏的，"不在里面"是常态，不能反过来当"已经没了"。
   */
  const zonesEff = useMemo(() => {
    const live = new Set(folders);
    const out = {};
    for (const [zid, z] of Object.entries(zones)) if (live.has(zid)) out[zid] = z;
    // 影子：agent 刚 mkdir 出来、这一轮扫描还没看到的那个，先占个位
    for (const [zid, g] of Object.entries(ghostZones)) if (!out[zid]) out[zid] = g;
    // 档案面收起时 记忆/ 文件夹卡不上桌（zones state 原样留着，显形即归位；
    // 文件夹派生/剪枝都读 zones 原始表，这里滤掉不会引发删除写回）
    if (!showArchive) for (const zid of Object.keys(out)) if (isArchivePath(zid)) delete out[zid];
    return out;
  }, [zones, ghostZones, folders, showArchive]);
  const zonesEffRef = useRef(zonesEff); zonesEffRef.current = zonesEff;

  // 刚被用户删掉的 zone 墓碑：删任务后 tasks 列表要等 reload 才更新，这个
  // effect 会在窗口期把 zone 重建并回写 board.json（e2e 抓到的真 race，
  // 2026-07-30）。墓碑挡住重建；对应 id 从 needed 里消失后墓碑自动出清
  // （同名新任务照常建区）
  const removedZonesRef = useRef(new Set());

  // ── 文件夹派生：磁盘上每个文件夹在画布上有一张卡，缺的建出来并持久化 ──
  //
  // 权威是**磁盘**（服务端扫出来的 `folders`，工作区相对路径），不是会话，也不是
  // 产物。空文件夹也算 —— 你刚建的那个还没往里放东西的，不该等有了产物才显形。
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const needed = new Set(folders);
    for (const zid of [...removedZonesRef.current]) {
      if (!needed.has(zid)) removedZonesRef.current.delete(zid);
    }
    const missing = [...needed].filter(zid => !zones[zid] && !removedZonesRef.current.has(zid));
    if (!missing.length) return;
    setZones(prev => {
      const next = { ...prev };
      for (const zid of missing) {
        if (next[zid]) continue;
        // 影子区已经占过位就沿用它的矩形（真区接管时画面不跳）
        next[zid] = {
          ...(ghostZones[zid] || newStackedZoneRect(next, shelf, layoutRef.current)),
          // title 不写进 board.json：名字从路径读（见 folderView 那段）
        };
        dirtyRef.current.zones.add(zid);
      }
      scheduleSave();
      return next;
    });
  }, [folders, zones, ghostZones, taskTitles, scheduleSave, shelf]);

  // 影子退场：对应的真工作区已经建出来了就删掉影子
  useEffect(() => {
    const stale = Object.keys(ghostZones).filter(zid => zones[zid]);
    if (!stale.length) return;
    setGhostZones(prev => {
      const next = { ...prev };
      for (const zid of stale) delete next[zid];
      return next;
    });
  }, [zones, ghostZones]);

  /**
   * 舞台卡报来的目标（agent 正在写的文件）→ 保证它落脚的工作区存在。
   * 任务目录是 agent 现建的，产物列表这轮还看不到 —— 先用影子区占位。
   */
  const ensureZoneForTarget = useCallback((objectId) => {
    const zid = zoneOfObjectId(objectId);
    if (!zid) return;
    if (zonesRef.current[zid] || ghostZones[zid]) return;
    const title = zid.split('/').pop() || '文件夹';
    setGhostZones(prev => (prev[zid] ? prev : {
      ...prev,
      [zid]: { ...newStackedZoneRect({ ...zonesRef.current, ...prev }, shelf, layoutRef.current), title },
    }));
    // ⚠️ 影子文件夹是**不过磁盘权威剪枝**的（zonesEff 里 ghost 无条件并入），
    // 所以 zoneOfObjectId 一旦凭空造出一个不存在的 id，这里就会长出一块永不
    // 退场的虚线框（退场条件是"真的出现了"，而它永远不会）。寻址回落到
    // sessionId 那一支正是这么来的 —— 2026-08-13 已从 stage.js 拆掉。
  }, [ghostZones, shelf]);

  /**
   * 自动摆位 + 归属判定：
   *   1. 有 sid 且工作区存在的未摆放物件 → 区内网格自动入座（deck 先占第一格）
   *   2. 其余未摆放物件 → 画布下方的收纳带（文档架 / deck 架 / 素材 / 文件）
   *   3. 归属 = 物件中心落在工作区有效矩形内（区随内容向下自然生长）
   */
  /**
   * 当前这一层桌面（2026-08-13：「当前目录」模型）。
   *
   * ## 这里替掉了什么
   *
   * 原来这段是 250 行的区内几何：粗网格占位（grids/markCells）、两趟入座、
   * 区内 packRow、收纳分组带、收纳带兜底、一屏画幅、避让修正落盘。它服务的是
   * 「严格分区」那套 —— 文件夹是版面上一块摊开的地，成员摆在框里，所以框内
   * 需要一整套自己的排布。
   *
   * 现在文件夹是**方卡**，进文件夹是**换一层桌面**。于是：
   *   - 一层里只有两种东西：文件夹卡、产物卡。**同一套排布**，不分内外
   *   - 不需要区内坐标系（框里没有东西了），也就不需要分组带和一屏画幅
   *   - 不需要收纳带兜底（每件东西都有它的目录，根目录也是目录）
   *
   * ## 只有一条自动，而且**只算一次**
   *
   * 没有坐标的东西给个落脚点（agent 跑的时候用户不在场，十几张图总得有人定
   * 位置），摆过的一律不动 —— 2026-08-07 定的那条界线继续有效：
   * "给新东西一个落脚点" ≠ "持续重排"。
   *
   * ⚠️ **算出来的落点必须当场落盘**（下面那条 seatFixes effect），不能只活在
   * 这个 memo 里。理由是活生生的事故：坐标不落盘的话，"谁已摆放"这件事会随
   * 交互变化 —— 你一拖某张卡，它就有了坐标、变成"已摆放"，起排线跟着抬高，
   * **其余没坐标的卡每一帧重新排一次**。表现是你拖着 A 想摞到 B 上，B 自己在
   * 往下跑，怎么都对不准（2026-08-13 用检查通道逐帧量出来的：三帧里 deck 从
   * y=434 跑到 447）。
   *
   * 落盘之后这一趟只在"真有新东西"时跑，布局对交互免疫。
   */
  /**
   * 目录索引：哪一层装了哪些文件夹、哪些物件。
   *
   * **桌面和文件夹窗共用这一份**（2026-08-13）。两个地方各写一套"这一层装了
   * 什么"的判据，迟早对不上 —— 而这套判据一点都不平凡：归属要沿着祖先往上找
   * 第一个真文件夹（`notes/` `assets/` 是基础设施目录，不是用户的层），
   * 显式 `zone` 字段还要优先。抄一遍就是抄一个必然漂移的东西。
   */
  const dirIndex = useMemo(() => {
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; };
    /**
     * 它住在哪一层。
     *
     * ⚠️ **不是直接取上级目录就完事**：`notes/灵感.md`、
     * `assets/generated/星空.webp` 的上级目录压根不是"用户的文件夹"
     * （`notes/` `assets/` 是基础设施目录，服务端的文件夹清单里没有它们）。
     * 直接按上级目录归属的话，这些东西会落在一个**不存在的层**上 ——
     * 看不见，也没有任何入口能进去。
     *
     * 所以往上走，找到第一个真的是文件夹的祖先；一个都没有就归根。
     * 这也顺带覆盖了"文件夹层级超过扫描深度"那种情况。
     */
    const knownFolders = new Set(Object.keys(zonesEff));
    const homeOf = (path) => {
      let d = parentOf(path);
      while (d && !knownFolders.has(d)) d = parentOf(d);
      return d || '';
    };
    // 显式归属字段仍然优先（拖出来的写 ''）—— 它的去留见任务 #13
    const dirOf = (o) => {
      const stored = layout[o.id];
      if (stored && stored.zone !== undefined) return stored.zone || '';
      if (o.native) return stored?.zone || '';        // 画布原生物件跟着字段走
      if (typeof o.id !== 'string') return '';
      const c = o.id.indexOf(':');
      const path = (c > 0 && /^[a-z]+$/.test(o.id.slice(0, c))) ? o.id.slice(c + 1) : o.id;
      return homeOf(path);
    };

    const byDir = new Map();          // 目录 → 这一层的物件
    for (const o of objects) {
      const d = dirOf(o);
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(o);
    }
    const subsOf = new Map();         // 目录 → 直接子文件夹
    for (const zid of Object.keys(zonesEff)) {
      const p = parentOf(zid);
      if (!subsOf.has(p)) subsOf.set(p, []);
      subsOf.get(p).push(zid);
    }
    /**
     * 里面装了什么。**只看直接子级**（跟"打开它看到的那一层"一致）。
     *
     * 条目带完整物件引用 `o` —— 文件夹卡面是真缩略（用户要"看一眼知道装了
     * 什么"）。数据当场就有，一个额外请求都不用发；iframe 的账在 FolderFace
     * 里算：视口门 + 缩放门 + 每卡上限。
     */
    const peekIn = (dir) => {
      const subs = (subsOf.get(dir) || [])
        .map(id => ({ kind: 'folder', title: id.split('/').pop(), o: null }));
      const files = (byDir.get(dir) || [])
        .map(o => ({ kind: o.type, title: o.title || o.name || String(o.id).split('/').pop(), o }));
      const all = [...subs, ...files];
      return { count: all.length, peek: all.slice(0, 4) };
    };
    return { dirOf, byDir, subsOf, peekIn };
  }, [objects, zonesEff, layout]);

  /**
   * 一张文件夹卡的完整描述（名字 + 装了什么）。位置由调用方给：桌面读
   * board.json 的坐标，文件夹窗按网格算。
   */
  const folderCardOf = useCallback((id, pos) => ({
    id,
    kind: 'folder',
    x: pos?.x ?? 0,
    y: pos?.y ?? 0,
    w: FOLDER_CARD.w,
    h: FOLDER_CARD.h,
    /**
     * 名字**从路径读**，不读存档里的 `title`。
     *
     * id 就是路径，路径的最后一段就是名字 —— 再存一份 title 就是第二个真相源，
     * 改名之后它立刻过期（实测：`鉴赏页` 改成 `作品集`，zones 行的 title 还写着
     * 「鉴赏页」）。服务端 tasks 给的标题优先，那是它对形态的命名，不是位置的
     * 复制品。
     */
    title: taskTitles.get(id) || id.split('/').pop() || '文件夹',
    ...dirIndex.peekIn(id),
  }), [dirIndex, taskTitles]);

  /** 文件夹窗要的那一层清单（文件夹 + 物件，位置由窗自己排） */
  const listDir = useCallback((dir) => ({
    folders: (dirIndex.subsOf.get(dir) || []).sort().map(id => folderCardOf(id, null)),
    items: [...(dirIndex.byDir.get(dir) || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }), [dirIndex, folderCardOf]);

  // ⚠️ 这三条声明必须在下面那个入座 memo **之前** —— memo 依赖 lineageOpen，
  // 声明在后就是渲染时 TDZ 整页白屏（这文件的第五颗同型雷，_hook-order-check
  // 拦下的）。谱系收叠：用户点开的链尾集合（默认全折叠，版面上只留现役版）。
  const [lineageOpen, setLineageOpen] = useState(() => new Set());
  const toggleLineage = useCallback((tipId) => {
    setLineageOpen(prev => {
      const next = new Set(prev);
      if (next.has(tipId)) next.delete(tipId); else next.add(tipId);
      return next;
    });
  }, []);
  /** 悬停中的卡（路线5）：BindingLayer 点亮连着它的线 */
  const [hoverCardId, setHoverCardId] = useState(null);

  // 幻影表（PhantomLayer.jsx）：生图占位的座位账本。ref 给入座 memo 消费
  // （认领时在 memo 里标 consumedBy —— movingRef 同款用法），state 由
  // usePhantoms 管（声明在 useStageState 之后，它要吃 stageCards）。
  const phantomsRef = useRef(new Map());
  const phantomObstaclesRef = useRef([]);
  const phantomBottomRef = useRef(0);

  // 入座算法本体 2026-08-14 抽进 lib/board-seating.js（配单测）——语义没动，
  // 两个 ref 型依赖参数化：movingIds（搬家中不落盘）、claimSeat（幻影座位过户，
  // 认领即在 memo 里标记，ref 用法同 movingRef 有先例）。
  const { positioned, folderView, contentBottom, seatFixes, noteFixes } = useMemo(() => (
    computeDesktopSeating({
      dirIndex, zonesEff, layout, bindings, lineageOpen, boardHero, folderCardOf, shelf,
      movingIds: movingRef.current,
      claimSeat: (id) => claimPhantomSeat(phantomsRef, id),
      occupied: phantomRects(phantomsRef),   // 生图幻影占的地方：它让不开，只能排座这边躲它
    })
  ), [dirIndex, folderCardOf, layout, zonesEff, bindings, lineageOpen, boardHero, shelf]);
  positionedRef.current = positioned;
  folderViewRef.current = folderView;
  // 幻影找座的障碍表与起排线（跟这一趟入座同一份现实）
  phantomObstaclesRef.current = [...zoneRects(folderView), ...objectRects(positioned)];
  phantomBottomRef.current = contentBottom;
  // 全目录树的物件（不止桌面这一层）—— 文件夹窗里的右键要按 id 找得到它们
  objectsRef.current = objects;


  /**
   * 首次落点落盘。
   *
   * 只写"这一趟才算出来的"那些（`layout` 里没有的），所以第二帧就没得写了，
   * 不会来回。写完之后它们在 `layout` 里，布局对拖拽这类交互免疫。
   */
  useEffect(() => {
    const ids = Object.keys(seatFixes || {});
    const nIds = Object.keys(noteFixes || {});
    if (!ids.length && !nIds.length) return;
    /**
     * ⚠️ 有东西正在改身份（搬家 / 改名）时**一律不落位**。
     *
     * 改名是前缀改名：`鉴赏页` → `作品集` 之后，里面每一件的 id 都变了。产物
     * 清单和文件夹清单不是同一拍回来的，中间那一拍里 `作品集` 还不在文件夹
     * 清单里，于是归属规则往上走一直走到根 —— 里面的东西短暂地"出现在桌面上"，
     * 这一趟就给它们排座并写盘。等清单追上，它们回到文件夹里，却带着一组
     * 在根上算出来的坐标。
     *
     * 落位是"给新东西一个落脚点"，不是"给正在改名的东西重新安家"。等这一拍过去。
     */
    if (movingRef.current.size) return;
    setLayout(prev => {
      let touched = false;
      const next = { ...prev };
      for (const id of ids) {
        if (prev[id] && Number.isFinite(prev[id].x)) continue;   // 已经有坐标了
        // seat 默认 'auto'（出处四值 auto/user/agent/shelf，user 的永不被重排）；架上落的座 fix 自带 seat:'shelf'
        next[id] = { ...(prev[id] || {}), seat: 'auto', ...seatFixes[id], z: prev[id]?.z ?? 1 };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      // 批注跟随是**覆写**：手写字本来就有坐标，跟随的意义就是换个位置。
      // 只动还存在的（字可能刚被删）。
      for (const id of nIds) {
        if (!prev[id]) continue;
        if (prev[id].x === noteFixes[id].x && prev[id].y === noteFixes[id].y) continue;
        next[id] = { ...prev[id], ...noteFixes[id] };
        dirtyRef.current.objects.add(id);
        touched = true;
      }
      if (touched) scheduleSave();
      return touched ? next : prev;
    });
  }, [seatFixes, noteFixes, scheduleSave]);

  // ⚠️ 这里曾有「遮盖修正落盘」：区内避让把卡推开之后，把新坐标写回 board.json。
  // 区内避让 2026-08-07 起其实就没在跑了（`resolveZoneAvoidance` 是死导入、
  // `overlapFixes` 声明后从未被写入，这条 effect 一直在空转），2026-08-13
  // 随区内几何一起删除。

  // ⚠️ 这里曾经有「工作区堆叠」：一条 effect 每帧把所有 zone 按序纵向排成一列、
  // 宽度拉成整个桌面宽，被手动搬过的靠 `pinned` 标记退出队列。
  //
  // 那是「严格分区」时代的几何 —— 分区是版面上的一条带，不是桌面上的一个东西。
  // 方向变了：文件夹是**能自由摆在任意位置的卡**，那就不该有一支队伍每帧把它
  // 推回去。连带没有意义的还有 `pinned`（不再有"队列"可退出）和成员跟随平移
  // （区不再被系统挪动，成员自然不用跟着补偿）。
  //
  // 新建文件夹的落点：右键处（openContextMenu 里现算），或者 newStackedZoneRect
  // 给的栈底空位（agent 建的那种，用户不在场时总得有个不重叠的地方）。


  /**
   * 可见性 2026-08-13 起**不再是一件事** —— `positioned` 和 `folderView` 本来
   * 就只装当前这一层。以前要在这儿过滤两遍（聚焦模式看哪块区、收起的文件夹
   * 内容不铺开），是因为所有层的东西都摊在同一个坐标系里。
   */
  const draggingId = dragRef.current?.kind === 'object' ? dragRef.current.id : null;
  const visibleObjects = positioned;
  const visibleZones = folderView;

  // ── 桌面高度 / 镜头裁切（2026-07-28：空白画幅自适应）──
  //
  // 桌面坐标系是全局的（工作区一路往下堆），但工作视图只看一块区。之前直接把
  // 全局坐标铺给滚动容器 —— 聚焦第 3 块任务区时，上面两块的高度变成一片死空白，
  // 下面还挂着全部内容的余量，"进任务文件夹上下大片空画幅"就是这么来的。
  //
  // 现在工作视图给桌面一个偏移量：聚焦区被平移到桌面顶端（bandY），高度只按
  // 这块区自己的内容算。整理视图 offset=0，行为不变。
  // ── 内容边界（喂给相机约束）──────────────────────────────────────────
  //
  // 2026-08-07：`viewOffsetY` 那套「镜头裁切」连同 `boardH` 的一屏判定一起
  // **退役**。它们当初存在只有一个原因 —— 没有相机，所以只能靠平移内容和
  // 撑高占位壳来伪造取景。记忆里那条「viewOffsetY / zoneMinHOf / boardH
  // 这三个是一组，必须一起改」的陷阱，本质就是这个伪造的代价。
  //
  // 现在「聚焦区吃满一屏」由**镜头去框它**（flyToBox）实现：意图一模一样，
  // 但工作区的高度回归贴内容，三常量的联动整个消失。
  const contentBox = useMemo(() => {
    const boxes = visibleZones.map(z => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
    for (const o of visibleObjects) {
      const sz = sizeOf(o);
      boxes.push({ x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h });
    }
    // 一件东西都没有时给一个桌面大小的空板，不然相机没有可约束的东西
    return boxUnion(boxes) || { x: 0, y: 0, w: DESKTOP_W, h: 600 };
  }, [visibleZones, visibleObjects]);

  const camera = useBoardCamera({ paneRef: scrollRef, contentBox });
  const { cam } = camera;
  const scale = cam.z;
  scaleRef.current = scale;
  camApiRef.current = camera;

  // 黑板三件（视点上报 / 眼睛模式 / 黑板模式+跟随）→ useBlackboardMode.js
  const { blackboardMode, toggleBlackboard } = useBlackboardWiring({
    projectId, cam, viewport: camera.viewport, winDir, openWindow, selectedIds,
    camRef: camApiRef, positionedRef, focusRequest,
  });

  // ── 画布工具（选择 / 文字 / 笔 / 评论）────────────────────────────────
  //
  // 落点归属：新东西放进**当前聚焦的工作区**（有的话），否则算项目级散件。
  // 这跟拖放的归属规则是同一条 —— 谁的框套住它就是谁的。
  const zoneAtPoint = useCallback((w) => {
    const hit = folderViewRef.current.find(z =>
      w.x >= z.x && w.x < z.x + z.w && w.y >= z.y && w.y < z.y + z.h);
    return hit?.id || null;
  }, []);

  /** 写一段字 → 落成 .md（走便签那条路，agent 读得到） */
  // 造东西（写字 / 便利贴 / 画一笔）→ useBoardAuthoring.js。
  // editingText 跟着搬过去了：它是 commitTextEdit 的另一半。
  const {
    editingText, setEditingText,
    handleCreateText, openTextEditor, commitTextEdit,
    createNoteAt, handleCreateScribble,
  } = useBoardAuthoring({
    projectId, canvasFont,
    patchLayout, setLayout, reload, scheduleSave,
    layoutRef, dirtyRef, zMaxRef,
    positionedRef, zoneAtPoint,
  });

  const canvasTools = useCanvasTools({
    // 摆放模式下笔不落墨：喂给工具层一个它不认识的名字，所有分支自然闭合，
    // 指针事件穿回物件拖拽/选中那条路（下面守卫只对墨类放行）
    tool: tool === 'draw' && drawMode === 'arrange' ? 'arrange' : tool,
    toWorld: camera.toWorld,
    // 一次性工具（one-shot）：写完一段自动回到指针。想连写的人多按一次 T 的
    // 代价，远小于"忘了自己拿着笔，想挪字却弹出新输入框"的困惑（用户报）。
    onCreateText: (t, at) => { handleCreateText(t, at); setTool('select'); },
    onCreateScribble: handleCreateScribble,
  });

  /**
   * 关系线的端点解析：**物件和工作区都可以当端点**（用户明确要求文件夹之间
   * 也能连线）。拿不到矩形就返回 null，那条线这一帧不画 —— 端点可能被收进
   * 文件夹了、可能属于当前不可见的工作区，都不是异常。
   */
  const rectOfId = useCallback((id) => {
    const o = positionedRef.current.find(it => it.id === id);
    if (o) { const sz = sizeOf(o); return { x: o.pos.x, y: o.pos.y, w: sz.w, h: sz.h }; }
    const z = folderViewRef.current.find(zz => zz.id === id);
    if (z) return { x: z.x, y: z.y, w: z.w, h: z.h };
    return null;
  }, []);

  /** 给浮层/提示用的端点名字。手写字直接报内容 —— 它没有别的名字。 */
  const titleOfId = useCallback((id) => {
    const o = positionedRef.current.find(it => it.id === id) || objectsRef.current.find(it => it.id === id);
    if (o) {
      if (o.type === 'text') return `「${String(o.data?.t || '').slice(0, 14)}」`;
      if (o.type === 'scribble') return '一笔涂鸦';
      return o.title || id.split('/').pop() || id;
    }
    return id.split('/').pop() || id;   // 文件夹（zone）或还没摆上桌的产物
  }, []);

  /**
   * 标注的第二个出口：**留在画布** —— 一段文字 + 一条 `annotates` 关系。
   *
   * **批注是关系不是自由文字**：光写一段话飘在旁边，过两天就没人知道它在说谁；
   * 存成关系之后，被批注的东西一移动，批注跟着走，线自己重画。
   *
   * 2026-08-13 从工具栏的「标注(C)」搬到这儿 —— 那个工具连同它的 commentDraft
   * 输入框一起删了，两条标注路（留在画布 / 发给 agent）收成同一张浮层的两个
   * 按钮，见 AnnotatePopover 的说明。
   *
   * 落点**贴着目标右边**，不落在光标处：光标可能正压在卡上（右键菜单从卡上
   * 弹、标注按钮就长在卡的右上角），落在那儿等于把一段字盖在产物脸上。
   *
   * 批量标注（框选之后右键）落**一段字 + N 条线**：一句话说的是这一组，
   * 抄成 N 段一样的字是把同一件事记 N 遍，改一处还得改 N 处。
   */
  const keepAnnotation = useCallback((targetIds, fallbackAt, text) => {
    const t = (text || '').trim();
    const ids = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter(Boolean);
    if (!t || !ids.length) return;
    const rects = ids.map(rectOfId).filter(Boolean);
    // 落在整组的右边（取所有目标的最右沿、最上沿）
    const at = rects.length
      ? { x: Math.max(...rects.map(r => r.x + r.w)) + 24, y: Math.min(...rects.map(r => r.y)) }
      : fallbackAt;
    if (!at) return;
    const noteId = handleCreateText(t, at);
    if (!noteId) return;
    // 文字落好了才连线 —— 端点必须真实存在，否则画布上留一条通向虚空的线
    const stamp = `${Date.now().toString(36)}${Math.floor(performance.now() % 1000)}`;
    const links = {};
    ids.forEach((id, i) => { links[`b:${stamp}${i}`] = { type: 'annotates', from: noteId, to: id, by: 'user' }; });
    setBindings(prev => ({ ...prev, ...links }));
    Assets.patchBoard(projectId, { bindings: links }).catch(() => {});
  }, [rectOfId, handleCreateText, projectId, setBindings]);

  // 舞台层仍按世界坐标贴卡，夹取上界取内容外沿
  const stageBounds = {
    w: Math.max(DESKTOP_W, contentBox.x + contentBox.w),
    h: contentBox.y + contentBox.h,
  };

  // ── 镜头（相机导演）────────────────────────────────────────────────

  /** 用户接管：任何主动操作后 8s 内跟随不抢镜头 */
  const noteUserTakeover = useCallback(() => {
    userHoldUntilRef.current = Date.now() + 8000;
    camApiRef.current?.noteTakeover();
  }, []);

  /** 跟随 agent：把镜头飞到物件（跟随关 / 用户接管期 / 物件不可见时不动）*/
  const followToObject = useCallback((objectId) => {
    if (!followRef.current) return;
    if (Date.now() < userHoldUntilRef.current) return;
    // 桌面上找不到 = 它在某个文件夹里（桌面只画根这一层）→ 不跟：镜头飞到
    // 一个看不见的坐标上，用户只会看到画布莫名其妙滑走
    const o = positionedRef.current.find(it => it.id === objectId);
    if (!o) return;
    const sz = sizeOf(o);
    // 保持当前缩放，只把目标挪到视口中心 —— 跟随不该顺手改变用户的缩放，
    // 那会让"我正在看细节"突然被拉远。
    camApiRef.current?.flyToPoint({ x: o.pos.x + sz.w / 2, y: o.pos.y + sz.h / 2 });
  }, []);

  /**
   * 开局框一次景，之后镜头永远归用户。
   *
   * 以前这条是"换一层就重新框"（cwd 变化时跑）。桌面只剩一层之后没有"换层"
   * 这件事了，只剩挂载那一次。
   *
   * ⚠️ **不要改成"等内容到齐再框"**。试过，当场翻车：内容分两批到（文件夹一批、
   * 产物一批），等第一批就框会把镜头对到只有产物的那块矩形上，文件夹卡全被顶到
   * 视口上方看不见（检查通道量到 y=-118）。要么开局框（这时内容为空，等于不动
   * 镜头 —— 也就是现在这样），要么老老实实等两批都到齐再框。
   */
  useEffect(() => {
    if (fittedKeyRef.current === 'desktop') return;
    fittedKeyRef.current = 'desktop';
    camApiRef.current?.zoomToFit({ force: true });
  }, [folderView]);

  // 手机 / 平板的阅读导航（开局取景 + 翻件），整块在 useReadingNav.js
  const { readGroup, deviceEnv, touchLane } = useReadingNav({ camApiRef, camera, cam, visibleObjects, layout, sheets });

  // ⚠️ 这里曾有「切 session 就切视图」：有会话进工作模式聚焦它的区、回 /work
  // 回项目区。会话与产物 08-08 解绑、双视图 08-13 退役之后，切对话不该动你
  // 站在哪一层 —— 那是两件事。

  // ── 拖拽（物件 / 工作区 / 背景平移共用 pointer 流）──
  // 必须声明在 useMarquee 之前 —— 那个 hook 在 render 期就把它读走了。
  const recentDragMovedRef = useRef(false);
  // 长按框选 → useMarquee.js（框的状态和三个手势口都在那儿）
  const { marquee, armMarquee, moveMarquee, endMarquee } = useMarquee({
    camera, paneRef: scrollRef, toolRef, positionedRef, folderViewRef, setSelectedIds,
    recentDragMovedRef,
  });

  // 搬家家族（moveEntry/moveZone/moveManyTo/groupInto + 飞入动画）2026-08-14
  // 抽进 useBoardMoves.js —— 语义与注释原样搬走，改搬家行为去那看。
  const { flyingIds, moveEntry, moveZone, moveManyTo, groupInto } = useBoardMoves({
    projectId, reload, scheduleSave,
    setLayout, setZones, setBindings,
    layoutRef, dirtyRef, movingRef,
    positionedRef, objectsRef, zonesEffRef, folderViewRef,
  });

  // 控件失效判据②（08-25 两版：先按 tag 判、当天改显式 supersede —— 多个面板要能
  // 同时活着，背包和章节选项同 tag 会互相误杀）。判据①（until 定时）在 MdInk。
  const staleControls = useMemo(() => staleControlIds(
    positioned.filter(o => o.chalk && typeof o.text === 'string' && o.text.includes('```nd:controls')),
  ), [positioned]);

  // 就地标注浮层：{ x, y, target:{ kind, id, title, typeLabel } }（E3）
  // ⚠️ 它必须声明在 useObjectClick 之前：setAnnotate 是**当作入参传进去**的，
  //    而入参在渲染时就求值，写在下面就是 TDZ 白屏（08-30 真栽过一次，
  //    _hook-order-check 只查依赖数组、查不到 hook 入参，所以它放行了）。
  const [annotate, setAnnotate] = useState(null);

  // 在一件东西上点一下意味着什么（选中 + 开标注纸，以及为什么要压一个双击窗口）
  // → useObjectClick.js。语义和那几条踩过的坑都在那个文件头上。
  const { clickSelect, cancelPendingClick } = useObjectClick({
    camera, positionedRef, selectedIdsRef, setSelectedIds, setAnnotate, roleNames,
    windowOpen: deckOpen,
  });

  // 拖拽全家（pointerdown/move/up/相机补帧/边缘跟车/整组抓手/板书双按武装）
  // 2026-08-25 抽进 useBoardObjectDrag.js —— 语义与注释原样搬走，改拖拽行为去那看。
  const { onObjectPointerDown, onPointerMove, onPointerUp, onTagGrab, abortDrag } = useBoardObjectDrag({
    camera, cam, positioned, folderView, dragActive,
    dragRef, dropHintRef, setDropHint, setDragActive,
    recentDragMovedRef, layoutRef, setLayout, patchLayout, dirtyRef, scheduleSave,
    zMaxRef, toolRef, drawModeRef, chalkEditModeRef, selectedIdsRef,
    setSelectedIds, clickSelect, noteUserTakeover, camApiRef, scrollRef,
    moveEntry, groupInto,
  });

  const wasDrag = () => !!(dragRef.current?.moved || recentDragMovedRef.current);
  // 黑板组三动作（整组选 / 落定 / 擦）→ useBoardGroups.js
  const { selectGroup, commitGroup, eraseGroup, exportGraph } = useBoardGroups({ projectId, positionedRef, setSelectedIds, reload });

  const {
    handleAdd, openViewer, openFile, openOrchestrate,
    handleDeleteNote, focusDeck, primaryOpen,
  } = useBoardOpen({
    projectId, onAddToContext, onFocusDeck,
    setLayout, dirtyRef, scheduleSave, reload,
    setAddedPaths, setViewer, setOrchestrate, setDetail,
    openTextEditor, roleNames,
  });
  // 两个 ref 留在这儿赋值：挂得更早的 effect（Delete 键、preview_deck 工具）靠它们够到下面才定义的函数
  handleDeleteNoteRef.current = handleDeleteNote;
  primaryOpenRef.current = primaryOpen;

  // ESC = 退回项目区全景（编辑窗开着时归窗口自己处理，别抢）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || deckOpen) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 先关浮层（项目区面板 / 阅读 / 图片详情），都没开着才退回项目区全景。
      // 浮层开着时 stopImmediatePropagation：阅读器可能叠在文件夹窗上
      // （z=MODAL > 窗 500），这一下 ESC 只该关最上面的阅读器，不该连窗一起
      // 带走 —— ArtifactWindow 的 escToClose 也挂在 window 上，这里用 capture
      // 抢在它前面（08-24 案：以前两个一起关，用户连"阅读器藏在窗后面"都发现不了）
      if (projectPanel || viewer || detail || orchestrate) {
        e.stopImmediatePropagation();
        setProjectPanel(null); setViewer(null); setDetail(null); setOrchestrate(null);
        return;
      }
      // 有选中先取消选中（比"关窗"近一级的撤销）
      if (selectedIdsRef.current.length) { setSelectedIds([]); return; }
      // ⚠️ 文件夹窗的 ESC **不在这儿**：ArtifactWindow 自己挂了一条（escToClose），
      // 两边都挂的话按一下会同时收选中和关窗。
    };
    // capture:true —— 浮层关闭要抢在 ArtifactWindow 的 bubble 监听之前
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [deckOpen, projectPanel, viewer, detail, orchestrate]);

  /**
   * 换工具的单键快捷键。
   *
   * 工具栏的 title 里从一开始就写着「（V）（T）（P）（C）」，但**全仓没有一处
   * 监听过这些键** —— 提示写了一个不存在的功能，比不写更坏。2026-08-08 补上，
   * 抓手的 H 2026-08-17 随抓手一起退役（理由见 board-tool-groups.js）。
   *
   * 带修饰键的一律放行：Ctrl+V 是粘贴，不是换工具。
   */
  useEffect(() => {
    // c（标注）2026-08-13 退役：标注不再是一种"拿在手里的工具"，见 AnnotatePopover
    const KEYS = { v: 'select', t: 'text', p: 'draw' };
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // 全局唤出 agent（2026-08-08）：斜杠。用户要「不用找鼠标，沉浸在画布里
      // 随手支使」。选的是 `/` 而不是某个字母 —— 字母全被工具占了，而斜杠在
      // 各家工具里本来就是"开始输入命令"的意思。
      if (e.key === '/') { e.preventDefault(); onAskAgent?.({}); return; }
      const next = KEYS[e.key?.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAskAgent]);

  // Delete / Backspace 删掉选中的墨类物件（选中态 2026-08-13 才有，这键也是）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const sel = selectedIdRef.current;
      if (!sel) return;
      const o = positionedRef.current.find(x => x.id === sel);
      if (!o?.native) return;
      e.preventDefault();
      setSelectedId(null);
      handleDeleteNoteRef.current?.(o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * 打开一个文件夹 = 开那扇窗（2026-08-13）。
   *
   * ⚠️ 这儿曾是 `enterZone` / `exitToProject`（换层）。它们连同「ESC 退一层」
   * 一起删了 —— 打开和关闭现在是同一扇窗的两端，退回桌面不需要"退层"这个
   * 概念。窗内下钻也走这个函数（同一扇窗换 dir）。
   */
  const openFolder = useCallback((zid) => { if (zid) setWinDir(zid); }, []);
  /**
   * 窗里那两个回调必须是**稳定引用**：FolderWindow 拿它们 memo 工具组，而
   * ArtifactWindow 的 effect 依赖工具组、清理函数又会清空工具组 —— 每渲染一个
   * 新函数就等于每渲染跑一遍「清空→重设」，两次状态变更互相触发，死循环。
   */
  const folderGoUp = useCallback(() => setWinDir(d => parentDir(d)), []);
  const closeFolderWindow = useCallback(() => setWinDir(null), []);
  /**
   * 「整理」—— 现在是**手动**的一次动作，不再每帧自动跑（2026-08-07）。
   *
   * 做法故意选了最简单的一种：**把坐标忘掉**。没有坐标的物件会被入座那一趟
   * 重新排（packRow：列宽取最宽的卡、行高贴该行最高的、整块居中），所以
   * "整理"不需要第二套排版实现 —— 它就是让入座重来一遍。
   *
   * 两处不碰：
   * - **画布原生物件**（涂鸦）：它的坐标就是它本身，不是"摆在哪"。把一笔涂鸦
   *   流进网格等于毁了内容。
   * - 收起的文件夹：里面的东西没在渲染，排了也看不见，等展开时自然入座。
   *
   * **文件夹也一起排**（2026-08-08）：从左到右铺、排满换行，跟桌面上的图标一样。
   * 平时不动它们（你摆哪儿就是哪儿），但这是个显式动作 —— 你点了"整理"，
   * 意思就是"把这一桌收拾干净"。存量数据尤其需要：它们的坐标是旧的纵向堆叠
   * 写下来的，全挤在左边一列。
   */
  const tidyBoard = useCallback(() => {
    const targets = positionedRef.current.filter(o => isFileBacked(o));
    const zv = folderViewRef.current;
    if (!targets.length && !zv.length) return;

    setLayout(prev => {
      const next = { ...prev };
      for (const o of targets) { delete next[o.id]; dirtyRef.current.objects.add(o.id); }
      return next;
    });

    if (zv.length) {
      // 顶层文件夹进网格；嵌套的（`a/b`）不单独排 —— 它画在父文件夹里面，
      // 位置由父的排布决定，单独摆会跑到外面去
      const byZid = new Map(zv.filter(z => !z.id.includes('/')).map(z => [z.id, z]));
      const { order: topOrder, breakBefore: topBreaks } = orderWithGroups(
        [...byZid.values()].sort((a, b) => a.y - b.y || a.x - b.x).map(z => z.id),
        bindings,
      );
      const tops = topOrder.map(id => byZid.get(id));
      const GAP_X = 24; const GAP_Y = 24;
      const maxW = DESKTOP_W - MARGIN_X * 2;
      // 文件夹是**固定尺寸的方卡**（2026-08-13），排布退化成"一行一行摆格子"。
      // 以前这里要按内容算每块区的宽度，还得在同一趟里定死写进去 —— 那是
      // 「贴内容宽的实体区」时代的麻烦，随区几何一起没了。
      let cx = MARGIN_X; let cy = MARGIN_X; let rowH = 0;
      const patches = {};
      for (const z of tops) {
        const { w, h } = FOLDER_CARD;
        if (topBreaks.has(z.id) && cx > MARGIN_X) { cx = MARGIN_X; cy += rowH + GAP_Y; rowH = 0; }
        if (cx > MARGIN_X && cx + w > MARGIN_X + maxW) { cx = MARGIN_X; cy += rowH + GAP_Y; rowH = 0; }
        patches[z.id] = { x: cx, y: cy, w };
        cx += w + GAP_X; rowH = Math.max(rowH, h);
      }
      setZones(prev => {
        const next = { ...prev };
        for (const [zid, patch] of Object.entries(patches)) {
          if (!next[zid]) continue;
          next[zid] = { ...next[zid], ...patch };
          dirtyRef.current.zones.add(zid);
        }
        return next;
      });
    }
    scheduleSave();
    useGlobalStore.getState().showToast(
      `已整理 ${targets.length} 件产物` + (zv.length ? ` · ${zv.filter(z => !z.id.includes('/')).length} 个文件夹` : ''),
      'success');
  }, [scheduleSave, bindings]);

  const openFolderRef = useRef(null);
  openFolderRef.current = openFolder;

  // ── 工作区操作：收纳 ↔ 展开（文件夹两态）/ 聚焦 / 自建文件夹 ──
  const patchZone = useCallback((zid, patch) => {
    setZones(prev => (prev[zid] ? { ...prev, [zid]: { ...prev[zid], ...patch } } : prev));
    dirtyRef.current.zones.add(zid);
    scheduleSave();
  }, [scheduleSave]);

  // ⚠️ 这一段必须待在 patchZone 之后。它的 useCallback 依赖数组在**渲染时**
  // 求值，写在上面就是 TDZ —— 这个文件第四次栽在 hook 声明顺序上了
  // （前三次：绑定表 memo、splitStageCards、handlePresenceEvent）。
  // 症状一律是整页白屏 + "Cannot access 'X' before initialization"，
  // 而且 build 和单测都照过不误，只有真跑才看得见。
  // 文件夹卡的拖 / 单击 / 双击 + 删文件夹 → useZoneGestures.js
  const { draggingZone, zoneGestureProps, handleDeleteFolder } = useZoneGestures({
    projectId,
    camApiRef, toolRef, openFolderRef, winDirRef,
    removedZonesRef, recentDragMovedRef, dirtyRef,
    setZones, setWinDir, scheduleSave, reload, noteUserTakeover,
  });

  // ⚠️ 这里曾经有 handleRemoveLegacyZone（把"旧式会话分区"从桌面拿掉，只清
  // board.json 不动对话）。会话不再产生分区之后，画布上每个框背后都有一个真实
  // 目录，"只从桌面移除、文件留着"这个动作没有对应物了 —— 要么删文件夹，
  // 要么不删。



  /**
   * 右键菜单（2026-08-08，Windows 桌面语言）。
   *
   * 一次 contextmenu 事件能落在三种东西上，菜单跟着变：
   *   空白    新建文件夹 / 写一段字 / 让 agent 在这儿做点什么
   *   文件夹  进去 / 新建子文件夹 / 收起 / 删除
   *   卡片    打开 / 加入上下文 / 让 agent 改它 / 删除
   *
   * 落点的**世界坐标**在打开这一刻就算好存下来 —— 新建出来的东西要落在你右键
   * 的地方，而菜单弹出后镜头可能已经被别的事挪过了。
   */
  const [menu, setMenu] = useState(null);   // { x, y, at:{x,y}, items }
  /** 「移动到…」浮层：{ x, y, ids:[], current, exclude? } */
  const [moveTo, setMoveTo] = useState(null);
  /** 连线拾取模式：{ id, title } = 起点已定，等着点目标（Esc 取消） */
  const [linkFrom, setLinkFrom] = useState(null);
  // 拾取模式的 Esc：捕获阶段拦住 —— 画布自己的 Esc 是「回上一层」，
  // 不拦的话取消个连线顺便换了层
  useEffect(() => {
    if (!linkFrom) return undefined;
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setLinkFrom(null); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [linkFrom]);
  /** 建线/改线浮层：{ x, y, mode, from:{id?,title}, to:{id?,title}, bindingId?, type?, label? } */
  const [linkPop, setLinkPop] = useState(null);

  const createFolderAt = useCallback(async (parent, at) => {
    try {
      const r = await Assets.createFolder(projectId, { parent });
      if (r?.folder && at) {
        // 落在右键处：不这么做的话它会被自动铺位丢到栈底，你得去找它
        setZones(prev => ({ ...prev, [r.folder]: { x: Math.round(at.x), y: Math.round(at.y), w: FOLDER_CARD.w, h: FOLDER_CARD.h } }));
        dirtyRef.current.zones.add(r.folder);
        scheduleSave();
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`建不了：${err.message}`, 'error');
    }
  }, [projectId, reload, scheduleSave]);

  /** 文件夹窗里的「新建文件夹」（建在窗当前那一层）—— 引用要稳，理由见 folderGoUp */
  const createFolderIn = useCallback((d) => createFolderAt(d, null), [createFolderAt]);

  /**
   * 把两件东西摞在一起 = 当场建个文件夹，两个都收进去（2026-08-13，用户要的）。
   *
   * 桌面/手机上这是最短的归类动作，比"先建夹、再拖两次"少两步。
   *
   * ⚠️ 顺序不能错，也不能并发：**先把文件夹建出来并拿到它的真名**（服务端会
   * 给重名加序号，`新建文件夹` 可能变成 `新建文件夹 2`），再一件件搬。
   * 抢跑的话第二件的 `to` 指向一个还不存在的目录 —— 服务端回
   * `target folder not found`，用户看到的就是"目标文件夹不存在"。
   *
   * 两件都搬完才 reload 一次：中途刷新会让第二件在旧清单上算落点。
   */

  /**
   * 就地改名（2026-08-13）。
   *
   * 三层传播的机器 08-08 就造好了（renameBoardPaths 独立动词 / git 对账 /
   * 转发表），**缺的一直只是这扇门** —— 于是文件夹只能叫「新建文件夹」，
   * 要改名得去让 agent `mv`。摞一起自动成夹上线之后这条更硌手：系统天天
   * 给你造通名文件夹。
   *
   * 扩展名不用管，服务端按原文件补回去（用户改 `主稿.html` 时输入的是「定稿」，
   * 让他自己带扩展名的话，删掉它就等于把一份 deck 变成普通文件）。
   */
  const commitRename = useCallback(async (id, name) => {
    setRenamingId(null);
    const from = String(id).slice(String(id).indexOf(':') + 1);
    const next = String(name || '').trim();
    if (!next || next === from.split('/').pop().replace(/\.[^.]+$/, '')) return;
    movingRef.current.add(id);            // 改名 = 换身份，同搬家：别给旧 id 排座
    try {
      const r = await Assets.renameEntry(projectId, from, next);
      if (r?.board) {
        setZones(r.board.zones || {});
        setBindings(r.board.bindings || {});
        dirtyRef.current = { objects: new Set(), zones: new Set() };
      }
      reload();
    } catch (err) {
      useGlobalStore.getState().showToast(`改不了名：${err.message}`, 'error');
    } finally {
      setTimeout(() => movingRef.current.delete(id), 4000);
    }
  }, [projectId, reload]);

  /**
   * 一件东西 → 标注浮层认的目标描述。
   *
   * `path` 是给 agent 的**落点**：消息里报的位置必须是它能 Read 的路径，
   * 而 id 不是（`deck:主稿.html` 这种带形态前缀的读不出来）。剥前缀的规矩跟
   * moveEntry 一致 —— id 就是路径，冒号前那截是形态名。
   */
  const openContextMenu = useCallback((e) => {
    const mx = e.clientX; const my = e.clientY;
    const at = camApiRef.current?.toWorld(e.clientX, e.clientY) || { x: 0, y: 0 };
    // 这一下发生在文件夹窗里吗？窗里的东西**不在桌面那一层**，所以查找和
    // 兜底都要换一套（见下）
    const winEl = e.target.closest?.('[data-folder-window]');
    const winIn = winEl ? (winEl.getAttribute('data-folder-window') || '') : null;
    const objEl = e.target.closest?.('[data-board-object]');
    const objId = objEl?.getAttribute('data-board-object') || null;
    // 桌面那一层找不到就去全清单里找（窗里的东西住在别的层）
    const obj = objId
      ? (positionedRef.current.find(o => o.id === objId) || objectsRef.current.find(o => o.id === objId))
      : null;
    // 文件夹：卡片没命中时才按几何找（展开态的框是 pointerEvents:'none'）。
    // ⚠️ 窗里**不做几何兜底** —— 窗的坐标系跟画布无关，拿相机换算出来的世界点
    // 去命中桌面上的文件夹，右键窗里的空白会弹出另一个文件夹的菜单
    const zoneId = !obj
      ? (e.target.closest?.('[data-zone-header]')?.getAttribute('data-zone-header')
        || e.target.closest?.('[data-board-zone]')?.getAttribute('data-board-zone')
        || (winIn === null ? zoneAtPoint(at) : null))
      : null;

    /**
     * 右键落在**选中集里**的东西上，而且选了不止一件 → 出批量菜单。
     *
     * 判据是"点的这一件在选中集里"，不是"有选中集"：选了五件之后去右键第六件，
     * 用户要的显然是对第六件动手，不是对那五件。这跟操作系统桌面一致。
     */
    const sel = selectedIdsRef.current;
    const batch = sel.length > 1 && sel.includes(objId || zoneId);
    const objs = batch ? sel.map(id => positionedRef.current.find(o => o.id === id)).filter(Boolean) : [];
    const zones = batch ? sel.filter(id => zonesEffRef.current[id]) : [];

    // 菜单表本体在 canvas-menus.js（B3 抽出）：这里只做命中解析和动作句柄
    const items = buildBoardMenu(
      { mx, my, at, obj, zoneId, winIn, batch, sel, objs, zones },
      {
        setMoveTo, setAnnotate, setLinkFrom, setRenamingId,
        handleAdd, handleDeleteNote, handleDeleteFolder,
        openObject: (o) => primaryOpenRef.current?.(o),
        openFolder, createFolderAt, createNoteAt,
        onAskAgent, tidyBoard, annotTargetOf, titleOfId,
        selectGroup, commitGroup, eraseGroup, exportGraph,
      },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, [zoneAtPoint, createFolderAt, createNoteAt, handleAdd, handleDeleteNote, handleDeleteFolder, tidyBoard, onAskAgent, selectGroup, commitGroup, eraseGroup, exportGraph]);

  // ── agent 正在写什么 → 视图跟过去（2026-08-13 从"自动展开"改剩这一半）──
  //
  // 原来这里是一整条「deck 自动内嵌渲染」链：进会话 HEAD 探测已有 canvas、
  // agent 写 deck（file_changed）时自动把那张卡展开成内嵌 iframe，还带一个
  // per-session 的"用户手动收起过就不抢"记忆。展开态退役后这条链没有了落点。
  //
  // ⚠️ **不要把它原样映射成"自动开窗"**：`preview_deck`（agent 主动摊给用户看）
  // 翻译成开窗是对的，但 file_changed 是每写一个文件就来一发 —— 那会变成
  // agent 每存一次盘就把一扇模态窗拍在用户脸上。方卡带实时缩略图之后，
  // "工作过程当场可见"这件事缩略图自己就做到了。
  //
  // 只留下有意义的那一半：把视图切到 agent 正在动的那个文件夹。
  //
  // ⚠️ 而这半条 2026-08-13 也没了：桌面不再有"层"，切不过去。agent 在文件夹里
  // 干活的可见性由**那张文件夹卡上的光圈 + 实时缩略**承担（ringZones 会把
  // 目标一路归到桌面上那张卡）。这里曾经是 `setCwd(...)` —— 换层模型拆掉之后
  // 它成了一处**悬空引用**（build 不报，真事件一来才炸），是拆全局状态之后
  // 必须 grep 一遍 setter 的老教训。

  /**
   * 舞台卡认领目标（agent 刚开始写某个文件）：目标落脚的文件夹还不存在就先
   * 长一块影子区（任务目录是 agent 现建的）。
   */
  const handleStageTarget = useCallback((objectId) => {
    ensureZoneForTarget(objectId);
  }, [ensureZoneForTarget]);

  // preview_deck 的落点（挂起/补开/带路径）已拆进 usePreviewRequest.js
  const handlePreviewRequest = usePreviewRequest({
    positionedRef, objectsRef, positioned, primaryOpenRef, followToObject,
  });

  // ── 舞台层（StageLayer.jsx 自治）：事件状态机 + 跟随触发 + deck 自动展开触发 ──
  /**
   * 目录型产物的覆盖表：`[{ path, id }]`，**按 path 长度降序**。
   *
   * 舞台寻址靠它把"落在一件产物里的一切"收敛到那一张卡：站点的
   * index / about / style.css / 图片、世界的立绘和地点 .md 各给一个 id 的话，
   * agent 改一次样式表桌面就多冒一张卡 —— 用户要的是"我那个网站"。
   *
   * 长的先匹配是必需的：子目录站 `鉴赏页/v2` 必须排在根站 `鉴赏页` 前面，
   * 否则子目录站的文件全被父站吞掉。
   *
   * ⚠️ 这里以前是 `Map<任务名, 站点root[]>` —— 那是任务模型的形状，需要
   * "先知道文件属于哪个任务，再问那个任务是不是站点"。id = 路径之后不需要
   * 中间那一跳了：物件 id 剥掉 kind 前缀**就是**它在磁盘上占的那块地方。
   */
  const artifactRoots = useMemo(() => (
    objects
      .filter(o => isDirArtifact(o) || (o.type === 'site' && o.single))   // 单页站点不是目录，但留在覆盖表给 resolveObjectId 精确命中/伴生文件匹配
      .map(o => ({
        path: o.id.slice(o.id.indexOf(':') + 1),
        id: o.id,
        // 根站的认领子目录（页面路径的顶层段）：`刊物/第一期.html` 在服务端
        // 算根站的页，前端解析要吃同一口径（resolveObjectId 的 claims 检查）
        claims: o.type === 'site'
          ? [...new Set((o.pages || []).filter(p => p.includes('/')).map(p => p.slice(0, p.indexOf('/'))))]
          : [],
      }))
      // ⚠️ 别写 `.filter(r => r.path)`：根站（`site:`）的 path 合法地是空串，
      // 那样写会把它整个扔出覆盖表 —— 根站项目里 index.html/style.css 全部
      // 解析成幽灵 id，精灵/光圈/舞台寻址一起失灵（2026-08-14 用户真会话
      // 抓到的「中途目标消失」）。空串排降序末尾，天然让子目录站先认领。
      .sort((a, b) => b.path.length - a.path.length)
  ), [objects]);
  // ⚠️ 下面这两个必须声明在 useStageState **之前**：它把 handlePresenceEvent
  // 当参数收走，声明在后面就是 TDZ 白屏。这个文件已经栽过三次同样的事
  // （绑定表 memo / splitStageCards / 这次），组件里 hook 参数的声明顺序
  // 不是风格问题，是硬约束。
  /**
   * 镜头跟**人**，不跟事件。
   *
   * 以前 `followToObject` 挂在每一条 file_changed 上 —— 多个子代理并行时
   * 镜头会在它们之间来回横跳，看着像抽搐。现在只跟 `followTarget` 选出来的
   * 那一个（主 agent 优先），它换了目标才动一次。
   */
  const followedIdRef = useRef(null);
  useEffect(() => {
    const who = followTarget(presence);
    if (!who) { followedIdRef.current = null; return; }
    const key = `${who.id}:${who.targetId}`;
    if (followedIdRef.current === key) return;
    followedIdRef.current = key;   // 关着也记下来：重新打开时不该把攒的一路补播一遍
    if (!followAgent) return;
    followToObject(who.targetId);
  }, [presence, followToObject, followAgent]);

  // 在场表：从同一条事件流归约出"谁在哪干活"（board-presence.js）。
  //
  // ⚠️ 解析器必须过 `resolveObjectId`，跟舞台卡贴物件**同一套口径**。这里曾
  // 拿裸路径直接当物件 id —— 而 deck 的 id 带 `deck:` 前缀、站点/世界里的
  // 文件要收敛到根产物的卡：裸路径对不上任何一张卡，rectOf 恒 null，精灵
  // 在这些目标上**从来没出现过**（2026-08-14 查实：「追踪器经常指不出工作
  // 对象」的主病根）。artifactRoots 走 ref —— 回调保持稳定引用，产物列表
  // 刷新不重建事件管线。
  const artifactRootsRef = useRef(artifactRoots);
  artifactRootsRef.current = artifactRoots;
  const presenceResolve = useCallback((file) => {
    const objectId = resolveObjectId(file, artifactRootsRef.current);
    if (!objectId) return null;
    return { objectId, zoneId: zoneOfObjectId(objectId) };
  }, []);
  const handlePresenceEvent = useCallback((evt) => {
    setPresence(prev => reducePresence(prev, evt, presenceResolve));
  }, [presenceResolve]);
  // 新文件补射：位置事件到达时它还不是画布物件（产物清单要等 file_changed 后
  // 的防抖重拉才收编），reducer 把路挂在 pendingFile 上 —— 清单一刷新就重试。
  // 不补的话"从 0 产物到有产物"精灵永远落不上去（2026-08-14 用户报的追踪病）。
  useEffect(() => {
    setPresence(prev => resolvePending(prev, presenceResolve));
  }, [artifactRoots, presenceResolve]);

  const { stageCards, stageBadges, spriteLine, dismissStageCard } = useStageState({
    stageRef, artifactRoots, followToObject,
    onStageTarget: handleStageTarget, onPreviewRequest: handlePreviewRequest,
    onRawEvent: handlePresenceEvent,
  });

  // 幻影表：出生（stageCards 出 image 条目）→ 找座 → 等过户 / 蒸发
  const { phantoms, moveSeat: movePhantomSeat } = usePhantoms({
    stageCards, phantomsRef,
    obstaclesRef: phantomObstaclesRef, contentBottomRef: phantomBottomRef,
  });

  // ── 铅笔精灵的台词与出场（2026-08-14 日记本批；五批收敛成单精灵层）──
  //
  // 精灵此刻说什么（台词池与挑法都在 SpriteSketchLayer.jsx）
  const { mainActive, workText, ambientText } = useSpriteAmbient({
    presence, stageCards, spriteLine,
  });

  // 舞台卡分流（StageLayer.jsx）：锚得到可见物件贴物件，锚不到落 dock。
  // （image 卡 2026-08-14 迁出 —— 幻影入座见 PhantomLayer.jsx，occupancy 参数
  //   连同它的唯一消费方 placeImageCard 一起拆除）
  const visibleIdSet = new Set(visibleObjects.map(o => o.id));
  // 板书直播的落点（真身在 use-live-chalk-spots.js，08-29 棘轮拆件）
  const liveChalkSpotFor = useLiveChalkSpots({ sheets, layout, camera, scrollRef });
  /** 这个落点上是不是已经有真卡了（流式卡的退场判据，见下方渲染处） */
  const spotTakenByReal = (spot) => Object.values(layout || {}).some(
    (e) => Number.isFinite(e?.x) && Math.abs(e.x - spot.x) < 12 && Math.abs(e.y - spot.y) < 12,
  );

  const { anchoredCards, dockPanels, dockChips, spriteCards, chalkCards } = splitStageCards({
    stageCards, positioned, visibleIdSet, visibleZones, focusZone: '',
  });

  // agent 此刻在动谁：橙色光圈套在目标外圈（物件还没上墙就套它落脚的工作区）。
  // 与"已更新"角标分工：光圈=正在动（过程），角标=刚动完（结果）。
  const { ringObjects, ringZones } = useMemo(() => {
    const objs = new Set(); const zs = new Set();
    for (const c of Object.values(stageCards)) {
      if (c.kind === 'chip' || c.kind === 'question' || c.status !== 'running') continue;
      if (c.objectId && positioned.some(o => o.id === c.objectId)) { objs.add(c.objectId); continue; }
      // 目标不在桌面上 = 它在某个文件夹里 → 光圈套在**那个文件夹卡**上
      // （桌面只画根这一层；agent 在文件夹里干活时你看到的是那张卡在转）
      const z = zoneOfObjectId(c.objectId);
      if (z) zs.add(z.includes('/') ? z.split('/')[0] : z);
    }
    return { ringObjects: objs, ringZones: zs };
  }, [stageCards, positioned]);

  /**
   * 小地图要画的东西：一件一个小方块（世界坐标）。
   *
   * 拿的是**可见**的那批，不是全部 —— 小地图该跟画布所见一致，画上一堆
   * 当前看不到的东西只会让人对不上号。
   */
  const minimapItems = useMemo(() => {
    const out = [
      ...zoneRects(visibleZones).map(r => ({ ...r, id: `z:${r.id}`, folder: true })),
      ...objectRects(visibleObjects).map(r => ({ ...r, folder: false })),
    ];
    // 生图幻影也是"桌面上有的东西"（08-24 精灵体检）：这份表同时喂精灵避让，
    // 漏了它精灵会一屁股坐在正在生成的图上。dep 用 phantoms（表本体在 ref 上，
    // phantoms state 是它的重渲染扳机）。
    let i = 0;
    for (const r of phantomRects(phantomsRef)) out.push({ id: `ph:${i += 1}`, ...r, folder: false });
    return out;
  }, [visibleZones, visibleObjects, phantoms]);

  // presenceHint 的看门狗计时器（挂 ref：apiRef 的 effect 每渲染都重跑，
  // 计时器不能跟着它的闭包走）
  const hintWatchdogRef = useRef(null);
  useEffect(() => () => clearTimeout(hintWatchdogRef.current), []);

  // ── 外层工具栏桥（工具栏合并：控件画在 CanvasToolbar，操作从这里走）──
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      /** 面包屑点某一级：窗切到那一层（'' = 关窗回桌面） */
      goTo: (dir) => setWinDir(dir || null),
      reload,
      // 项目级四件套（记忆 / 指引 / 风格 / 文件）2026-08-07 从画布顶带收进
      // 顶栏的「⋯」——它们是**设置**不是产物，占着画布最好的一条横带每天
      // 看却几乎不点。面板本身没动，只是换了个入口。
      openProjectPanel: (key) => setProjectPanel(key),
      toggleArchive,   // 档案面显隐：08-30 从画布右上角搬进「⋯」，见 RollLayer.jsx 的墓碑
      /**
       * 就地标注发出的瞬间把精灵放到目标上（E4）：真事件（run.start /
       * file_changed）要过服务端一圈才回来，等它们精灵才动，"收到指令立刻
       * 飘过去"的手感就没了。这是**本地合成**的在场条目，不走 reducer ——
       * 后续真事件来了会自然接管（run.start 幂等、file_changed 挪位置、
       * tool_use 换那句话、run.done 收场）。
       */
      presenceHint: (targetId) => {
        if (!targetId) return;
        setPresence(prev => hintPresence(prev, targetId, zoneOfObjectId(targetId)));
        // 看门狗（08-24 精灵体检）：合成 active 没人收场时 30s 自己下场
        clearTimeout(hintWatchdogRef.current);
        hintWatchdogRef.current = setTimeout(() => setPresence(expireHint), 30000);
      },
    };
    return () => { apiRef.current = null; };
  });
  const lastUiRef = useRef('');
  useEffect(() => {
    // 面包屑：当前目录一路拆到根。顶栏据此渲染「Demo 项目 / 鉴赏页 / 初稿」，
    // 每一级可点 —— 换层的第三个入口（另两个是双击文件夹卡和 ESC）。
    const crumbs = [];
    if (winDir) {
      const segs = winDir.split('/');
      for (let i = 0; i < segs.length; i += 1) {
        const path = segs.slice(0, i + 1).join('/');
        crumbs.push({ id: path, title: taskTitles.get(path) || segs[i] });
      }
    }
    // artifactKind / artifactExports：当前这一层做的是什么形态、可用哪些导出
    // 格式（服务端 kinds/ 注册表吐的）—— 导出菜单据此渲染，不在前端硬编码。
    const focusTaskObj = winDir ? tasks.find(t => t.id === winDir) : null;
    const ui = {
      // 顶栏面包屑读的就是它。名字沿用 `cwd` —— 语义从"桌面在哪一层"变成
      // "窗开在哪一层"，但对顶栏来说是同一件事：你现在看着哪儿
      cwd: winDir || '',
      crumbs,
      artifactKind: focusTaskObj?.kind || null,
      artifactExports: focusTaskObj?.exports || null,
      artifactCardId: focusTaskObj?.artifacts?.[0] ? cardIdOf(focusTaskObj.id, focusTaskObj.artifacts[0]) : null,
      // 项目级四件套的一行摘要 —— 卡片撤出画布后，这几句话跟着入口一起
      // 搬进顶栏的「⋯」，不能因为换了个地方就把"里面有没有东西"弄丢
      projectBand: bandSummaries,
      showArchive,   // 菜单据此渲染"显示/收起档案卡"
    };
    // 布局每次变更都换新引用（拖拽期间逐帧）—— 序列化对比，内容没变不上报
    const key = JSON.stringify(ui);
    if (key === lastUiRef.current) return;
    lastUiRef.current = key;
    onUiState?.(ui);
  }, [onUiState, winDir, taskTitles, tasks, bandSummaries, showArchive]);

  /**
   * 画布的工具组。**这里不渲染工具栏** —— 全项目只有一条，活在 CanvasFrame，
   * 内容跟着当前焦点走（没开窗是这一份，开了窗是那扇窗的）。
   *
   * 2026-08-13 范式改造前：画布一条 + 每扇窗各一条，各自算落点、各自持久化
   * 位置。用户报的「两套工具栏」「位置没对齐」「偏到右下角」是同一个结构病。
   *
   * 顺带退役的是 `autoHide` + `wake`（按需浮现）：既然常驻，就没有"唤出"这回事。
   */
  /**
   * ⚠️ 镜头动作要用 ref 转一手，**不能直接把 `camera.zoomBy` 写进依赖**。
   *
   * `useBoardCamera` 每次渲染返回新对象，而它里面的 `zoomToFit` 又依赖
   * `contentBox`，`contentBox` 依赖 `visibleObjects` —— 那是个每渲染
   * `.filter()` 出来的新数组。整条链每帧换身份，写进依赖就是：
   * memo 每帧重算 → 报上去一个新数组 → 外层 setState → 再渲染一帧 → **死循环**。
   * build 和单测都照不出来，因为它要真挂起来跑才发作。
   */
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const zoomFitStable = useCallback(() => cameraRef.current.zoomToFit(), []);
  const zoomByStable = useCallback((d) => cameraRef.current.zoomBy(d), []);
  const zoomToStable = useCallback((z) => cameraRef.current.zoomTo(z), []);

  // 工具栏常驻评论钮（08-25 用户提）：选中集优先，否则对整块画布说一句
  const openCanvasNote = useCallback(() => {
    const sel = selectedIdsRef.current;
    const targets = sel.length
      ? sel.map(id => positionedRef.current.find(o => o.id === id)).filter(Boolean).map(o => annotTargetOf(o))
      : [];
    setAnnotate({
      x: Math.round(window.innerWidth / 2 - 160), y: Math.round(window.innerHeight - 320),
      ...(targets.length
        ? { target: targets[0], targets }
        : { target: { kind: 'canvas', id: '', path: '', title: '整块画布', typeLabel: '画布' } }),
    });
  }, []);

  // #tag 小标右键 = 整组菜单（08-25 用户报「tag 级评论按钮丢了」的正门：chip 浮在
  // 卡片层之上，右键落在它身上 closest 找不到 data-board-object，只能弹空白菜单 ——
  // 索性让 chip 自己出组菜单：选中/落定/导出/擦/标注这组）
  const openTagMenu = useCallback((tag, e) => {
    e.preventDefault();
    const members = positionedRef.current.filter(o => (o.tag || o.pos?.tag) === tag);
    if (!members.length) return;
    const anyStaging = members.some(o => o.staging || o.pos?.staging);
    const items = [
      { id: 'grp-sel', icon: Group, label: `选中整组 #${tag}`, onClick: () => selectGroup(tag) },
      { id: 'grp-note', icon: MessageSquarePlus, label: '标注这组给 agent', hint: '发送即处理', onClick: () => setAnnotate({
        x: e.clientX, y: e.clientY, target: annotTargetOf(members[0]), targets: members.map(o => annotTargetOf(o)),
      }) },
      ...(anyStaging ? [{ id: 'grp-commit', icon: Check, label: '落定这组草稿', onClick: () => commitGroup(tag) }] : []),
      { id: 'grp-export', icon: Download, label: '导出这组（SVG）', onClick: () => exportGraph?.('svg', tag) },
      { id: 'grp-export-zip', icon: Download, label: '导出这组 + 产物（zip）', onClick: () => exportGraph?.('zip', tag) },
      { id: 'grp-roll', icon: Archive, label: `收卷整组 #${tag}`, hint: '收进一张卷卡，单击展开', onClick: () => rollGroup(tag) },
      { id: 'grp-erase', icon: Eraser, label: `擦掉整组 #${tag}`, danger: true, onClick: () => eraseGroup(tag) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, [selectGroup, commitGroup, eraseGroup, exportGraph, rollGroup]);

  const boardToolGroups = useMemo(() => buildBoardToolGroups({
    tool, setTool, drawMode, setDrawMode, scale,
    tidyBoard, zoomFit: zoomFitStable, zoomBy: zoomByStable, zoomTo: zoomToStable, filterGroup,
    blackboardMode, toggleBlackboard,
    chalkEditMode, toggleChalkEdit,
    openCanvasNote, deviceClass: deviceEnv.class, readGroup,
  }), [tool, drawMode, scale, tidyBoard, zoomFitStable, zoomByStable, zoomToStable, filterGroup, blackboardMode, toggleBlackboard, chalkEditMode, toggleChalkEdit, openCanvasNote, deviceEnv.class, readGroup]);

  useEffect(() => { onToolbarGroups?.(boardToolGroups); }, [boardToolGroups, onToolbarGroups]);

  /**
   * 一张产物卡 / 一张文件夹卡的渲染。
   *
   * **桌面和文件夹窗共用这两个函数**（2026-08-13）。窗里那套要是自己抄一版
   * 简化卡，hover 工具条、标注按钮、缩略图闸门、双击语义就得在两个地方各修
   * 一遍 —— 这个仓库最贵的一课正是「同一件东西有多个实例」。
   *
   * 窗里的差别只有三处，全在 `win` 分支里：位置是算出来的（不是 board.json 的
   * 坐标）、不参与拖拽和框选、镜头缩放固定 1（窗不跟着画布缩放）。
   */
  const renderObjectCard = (o, winPos = null) => {
    const win = !!winPos;
    const obj = win ? { ...o, pos: { ...winPos, z: 1 } } : o;
    return (
      <BoardObject
        key={obj.id}
        o={obj}
        projectId={projectId}
        currentSessionId={currentSessionId}
        fileVersions={fileVersions}
        added={addedPaths.has(obj.id)}
        // 避让系统：拖拽中只有被拖的卡逐帧跟手（关过渡），被避让的邻居保持 380ms 滑动
        animateLayout={!win && (!dragActive || dragRef.current?.id !== obj.id)}
        vanishing={!win && flyingIds.has(obj.id)}
        agentActive={ringObjects.has(obj.id)}
        groupTarget={!win && dropHint?.kind === 'group' && dropHint.id === obj.id}
        // 单选一件墨类时选中态由变换控制器画（那圈框就是它的选中框），
        // 别再叠一道外框
        selected={!win && selectedIds.includes(obj.id) && !(obj.native && selectedIds.length === 1)}
        renaming={renamingId === obj.id}
        onRenameCommit={(v) => commitRename(obj.id, v)}
        onRenameCancel={() => setRenamingId(null)}
        onMeasured={win ? null : patchLayout}
        onPointerDown={win ? undefined : (e) => onObjectPointerDown(e, obj)}
        wasDrag={win ? () => false : wasDrag}
        // 板书防误触：闲置板书（编辑模式关 + 未武装）双击先武装（选中），
        // 武装态再双击才进编辑 —— 单击已经在 board-hit 里被当成空地了
        chalkIdle={!win && !!obj.chalk && !chalkEditMode && !selectedIds.includes(obj.id)}
        controlsStale={staleControls.has(obj.id)}
        // 产物窗开着 = 桌面被盖住：底下的活预览立刻定格（IO 不认遮挡，
        // 不冻的话窗里窗外是同一个站点的双实例全速跑 —— 08-24 性能案）
        previewPaused={deckOpen}
        onPrimary={() => {
          // ⭐ 双击到手：把那两下单击的后果掐掉（标注纸 + 叠堆下翻），见上面
          // clickSelect 那段。dblclick 紧跟在第二下之后，所以这一下必定赶在
          // 220ms 的定时器之前。
          cancelPendingClick();
          // 板书只认「改板书」开关（08-25 拍板）：关着时双击不开编辑器（这条
          // dblclick 理论上到不了这儿 —— 空地按下被平移层捕获重定向；留闸兜底）
          if (!win && obj.chalk && !chalkEditModeRef.current && !selectedIdsRef.current.includes(obj.id)) return;
          primaryOpen(obj);
        }}
        onAdd={() => handleAdd(obj)}
        onOpenViewer={() => openViewer(obj)}
        onOpenFile={() => openFile(obj)}
        onOrchestrate={() => openOrchestrate(obj)}
        onDetail={() => setDetail(obj)}
        onDeleteNote={() => handleDeleteNote(obj)}
        onFocus={() => focusDeck(obj)}
        // 标注：浮层从按钮底下长出来（at 是按钮的屏幕坐标），
        // target 的形状跟右键菜单那条**逐字一致** —— 同一张浮层
        onAnnotate={(at) => setAnnotate({ x: at.x, y: at.y, target: annotTargetOf(obj, roleNames) })}
        onExport={isFileBacked(obj) ? () => !wasDrag() && exportCard(projectId, obj) : undefined}
        noteCount={noteCounts[obj.id] || 0}
        // 缩略图的第二道限流：镜头拉太远就不挂 iframe（看不清，纯浪费）
        scale={win ? 1 : scale}
        // 谱系收叠（路线3）：桌面上才有叠（窗里是"看里面"，全铺开）
        stackCount={win ? 0 : (obj.stackCount || 0)}
        stackOpen={!!obj.stackOpen}
        onToggleStack={() => toggleLineage(obj.id)}
        onHoverCard={win ? undefined : setHoverCardId}
      />
    );
  };

  const renderFolderCard = (z, winPos = null) => {
    const win = !!winPos;
    const card = win ? { ...z, x: winPos.x, y: winPos.y } : z;
    return (
      <FolderCard
        key={card.id}
        z={card}
        projectId={projectId}
        fileVersions={fileVersions}
        scale={win ? 1 : scale}
        dropTarget={!win && dropHint?.kind === 'folder' && dropHint.id === card.id}
        selected={!win && selectedIds.includes(card.id)}
        ring={ringZones.has(card.id)}
        dragging={!win && draggingZone === card.id}
        animate={!win && !(dragActive || draggingZone === card.id)}
        renaming={renamingId === card.id}
        onRenameCommit={(v) => commitRename(card.id, v)}
        onRenameCancel={() => setRenamingId(null)}
        onDelete={() => !wasDrag() && handleDeleteFolder(card.id, card.title)}
        onAnnotate={(at) => setAnnotate({
          x: at.x, y: at.y,
          target: { kind: 'folder', id: card.id, path: card.id, title: card.title, typeLabel: '文件夹' },
        })}
        noteCount={noteCounts[card.id] || 0}
        // 窗里没有拖拽（位置是算的），双击直接下钻到下一层
        gestureProps={win
          ? { onDoubleClick: () => openFolder(card.id) }
          : zoneGestureProps(card)}
        hint={win ? '双击进去' : '双击打开 · 拖动搬走'}
      />
    );
  };

  // ── 渲染 ──
  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: CANVAS.paper }}>
      <style>{BOARD_KEYFRAMES}</style>
      {/* 视口：不滚动，镜头就是相机（2026-08-07 无限画布）
       *
       * 点阵台面画在**视口**上不画在世界层上：世界是无限的，给不出一个"多大"
       * 的背景元素。做法是背景尺寸跟着 z 缩、背景位置跟着相机走 —— 视觉上等价
       * 于一张无限大的点阵纸，而且不需要为它铺任何 DOM。 */}
      <div
        ref={scrollRef}
        data-board-pane
        data-tool={tool}
        data-drawing={canvasTools.draft ? canvasTools.draft.points.length : ''}
        onPointerDown={(e) => {
          // 点到既不是物件也不是变换手柄的地方 → 取消选中（选中态的唯一出口
          // 之一；另一个是 Esc）。放在工具分派**之前**：不管手里拿什么，点空白
          // 都该收掉选框。
          // onObject 而不是裸 selector：未武装的板书算空地 —— 点它也收掉选框
          //（这正是武装态的退出路之一；另一条是 Esc）
          // onChrome 豁免（08-27）：小地图/档案钮等 chrome，按它不该先把选中收了
          if (selectedIdsRef.current.length && !onObject(e) && !onChrome(e)
            && !e.target.closest('[data-transform-handle]')) {
            setSelectedIds([]);
          }
          // 顺序即优先级：工具在手就归工具，工具没接才轮到相机平移。
          // 否则「拖着画一笔」和「拖空白平移」抢同一个手势，画一笔就跑镜头。
          if (canvasTools.onPointerDown(e)) return;
          armMarquee(e);
          camera.onPointerDown(e);
        }}
        onDoubleClick={(e) => { canvasTools.onDoubleClick(e); }}
        // 连线拾取模式：捕获阶段截胡这一下点击 —— 点中物件/文件夹就是目标，
        // 点空地/点自己 = 取消。stopPropagation 挡住卡片自己的选中/打开。
        onClickCapture={linkFrom ? ((e) => {
          e.preventDefault(); e.stopPropagation();
          const tid = e.target.closest?.('[data-board-object]')?.getAttribute('data-board-object')
            || e.target.closest?.('[data-zone-header]')?.getAttribute('data-zone-header')
            || e.target.closest?.('[data-board-zone]')?.getAttribute('data-board-zone')
            || null;
          const from = linkFrom;
          setLinkFrom(null);
          if (!tid || tid === from.id) return;
          setLinkPop({ x: e.clientX, y: e.clientY, mode: 'create', from, to: { id: tid, title: titleOfId(tid) } });
        }) : undefined}
        onContextMenu={(e) => {
          if (onChrome(e)) return;                 // 工具栏上右键交给浏览器
          e.preventDefault();
          openContextMenu(e);
        }}
        onPointerMove={(e) => {
          if (canvasTools.onPointerMove(e)) return;
          if (moveMarquee(e)) return;              // 框选中：相机和物件都不管事
          if (!camera.onPointerMove(e)) onPointerMove(e);
        }}
        onPointerUp={(e) => {
          if (canvasTools.onPointerUp(e)) {
            // 工具吃掉了这次抬手（一笔提交）。物件拖拽若曾误武装，这里必须
            // 收尾 —— dragRef 残留会让那张卡黏住光标（2026-08-13 真栽过；
            // 现在 onObjectPointerDown 有工具守卫，这条是保险丝）。
            if (dragRef.current) { dragRef.current = null; setDragActive(false); }
            return;
          }
          if (endMarquee()) return;
          const panned = camera.onPointerUp(e);
          onPointerUp(e);
          // 几何点选（08-27）：真点击（没平移没拖没框选）落在被 board-hit
          // 当成空地的东西上 —— 闲置板书就是这类 —— 也要选得中。物件自己的点选
          // 走拖拽钩子（它有指针捕获），这里只接"空地"那半边。
          if (!panned && !wasDrag() && toolRef.current === 'select' && !onObject(e)
            && !onChrome(e) && !e.target.closest('[data-transform-handle]')) {
            clickSelect(null, e.clientX, e.clientY);
          }
        }}
        onPointerCancel={(e) => {
          canvasTools.onPointerUp(e); endMarquee(); camera.onPointerUp(e);
          if (e.isTrusted) onPointerUp(e); else abortDrag();   // 合成 cancel = 第二根手指 → 撤销不落盘
        }}
        style={{
          position: 'absolute', inset: 0, overflow: 'hidden',
          touchAction: 'none',
          // 画布上的字不可选：规则连同理由整条住在 globals.css 的 [data-board-pane]
          cursor: linkFrom ? 'crosshair'
            : camera.panning ? 'grabbing'
            : tool === 'draw' ? (drawMode === 'arrange' ? 'default' : 'crosshair')
            : tool === 'text' ? 'text'
            : 'default',
          background: CANVAS.paper,
          backgroundImage: `radial-gradient(circle, ${CANVAS.grid} 1px, transparent 1px)`,
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
          backgroundPosition: `${cam.x * scale}px ${cam.y * scale}px`,
        }}
      >
        {/* 世界层：所有内容都用世界坐标摆，整层由相机一次性变换。
            transform 从右往左应用 → 先 translate 再 scale = (world + cam) * z，
            跟 board-camera.js 的坐标约定逐字对应。 */}
        <div
          style={{
            position: 'absolute', left: 0, top: 0, width: 0, height: 0,
            transform: `scale(${scale}) translate(${cam.x}px, ${cam.y}px)`,
            transformOrigin: '0 0',
          }}
        >
          {/* 文件夹：一张方卡（2026-08-13，"分区"时代两态退役）——
              桌面上的一个东西，双击进去换一层。 */}
          <ShelfHint positioned={positioned} />
          {visibleZones.map((z) => renderFolderCard(z))}

          {visibleObjects.map((o) => renderObjectCard(o))}

          {/* 生图幻影：占位卡在纸面层等图，真图落地座位过户；拖它 = 指定这张图落在哪 */}
          <PhantomCards phantoms={phantoms} draggable={tool === 'select'}
            toWorld={camera.toWorld} onSeatChange={movePhantomSeat} />


          {/* 关系线（世界坐标，铺在物件之下）*/}
          <TagHullLayer positioned={positioned} onGrab={onTagGrab} onMenu={openTagMenu} />
          {/* 卷卡（收纳器）：收着的组在包络左上角留一张卡，单击展开归位 */}
          <RollLayer rolls={rolls} layout={layout} onUnroll={unrollGroup} />
          {!eyeMode && chalkCards.map((c) => {
            const spot = liveChalkSpotFor(c.blockId, c.spot);
            // 真卡接棒（2026-08-29 刀 E）：同一个位置上已经有落定的物件了 → 流式卡
            // 当场退场。原来是写完 700ms 后再淡出 500ms —— 那 1.2 秒里流式字和真卡
            // 重叠着，看起来就是"填完还闪一下"（站主：填完不该再二次刷新）。
            // 只对 placed（agent 自己选的位置）成立；落在临时空地上的仍走定时淡出。
            if (c.status === 'ok' && spot?.placed && spotTakenByReal(spot)) return null;
            return <ChalkLiveInk key={c.blockId} card={c} spot={spot} />;
          })}
          <BindingLayer
            bindings={bindings}
            roleNames={roleNames}
            rectOf={rectOfId}
            epoch={positioned}
            width={stageBounds.w}
            height={stageBounds.h}
            hoveredId={hoveredBinding}
            hotEndpointId={hoverCardId}
            onHover={setHoveredBinding}
            onSelect={(bid, cx, cy) => {
              const b = bindings[bid];
              if (!b) return;
              setLinkPop({
                x: cx, y: cy, mode: 'edit', bindingId: bid,
                from: { id: b.from, title: titleOfId(b.from) },
                to: { id: b.to, title: titleOfId(b.to) },
                type: b.type, label: b.label || '', material: b.material || 'ink',
              });
            }}
          />

          {/* 正在画的那一笔（还没落盘，纯渲染层）*/}
          {canvasTools.draft && canvasTools.draft.points.length > 1 && (
            <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 290 }}>
              <path
                d={pointsToPath(canvasTools.draft.points)}
                fill="none" stroke={PAPER.ink} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          )}

          {/* 选中态变换控制器（世界层，跟着被选物件的 transform 走）。
              被选物件可能这一帧刚被删/被搬走 —— find 不到就整层不画。 */}
          {/* 选中态的两种控制器，共用一次查找：板书给宽高手柄（它是文件类物件，
              走不到 native 那条判据 —— 在此之前用户根本调不了板书的宽高；宽真折行、
              高是留白下限，见 ChalkSizeHandles 文件头），墨类原生物件给旋转+缩放。 */}
          {(() => {
            const o = selectedId ? positioned.find(it => it.id === selectedId) : null;
            if (!o) return null;
            const common = { o, sz: sizeOf(o), camScale: scale, toWorld: camera.toWorld };
            if (o.chalk) {
              return <ChalkSizeHandles {...common} onResize={(patch) => patchLayout(o.id, { ...patch, sized: 'user' })} />;
            }
            if (!o.native) return null;
            return (
              <TransformControls
                {...common}
                onChange={(patch) => {
                  const cur = layoutRef.current[o.id];
                  if (!cur) return;
                  patchLayout(o.id, { data: { ...cur.data, ...patch } });
                }}
              />
            );
          })()}

          {/* （子代理在场徽记 PresenceLayer 2026-08-18 拆除：子代理动态收进
              聊天时间轴的 Task 抽屉行，画布只留主 agent 的铅笔精灵。）*/}

          {/* 铅笔精灵（唯一挂载，2026-08-14 五批）：有工作目标贴目标，没有就
              槽位（闲时/纯思考/无文件工具都在槽位上活着 —— 活跃真空修复）。
              活跃换转轮图标+工作台词；quiet=输入行开着时精灵闭嘴让位。
              obstacles 直接用小地图那份矩形 —— 同一个"桌面上有什么"。 */}
          {!eyeMode && <AmbientSpriteLayer
            agentActive={mainActive}
            workAnchor={(() => {
              const main = presence[MAIN_AGENT_ID];
              if (!main?.active || !main.targetId) return null;
              return presenceRectFor(main, rectOfId);
            })()}
            cam={cam}
            viewport={camera.viewport}
            obstacles={minimapItems}
            text={mainActive ? workText : ambientText}
            quiet={!!spriteAsk}
            onAsk={onSpriteSay ? setSpriteAsk : undefined}
            // 输出框（代码直播/终端）2026-08-14 起归精灵管：跟着它走、绕它
            // 找位（可压产物但尽量不压）。渲染器从这儿递 —— 卡片长相还是
            // StageLayer 的，精灵层只管摆位，两边不互相 import 出环。
            frameCards={spriteCards}
            renderFrameCard={(card) => (
              <StageCardBody card={card} onDismiss={() => dismissStageCard(card.blockId)} />
            )}
          />}

          {/* 常驻角色的精灵：贴着它正在写的东西（没写过的排候场位），点它开对话小窗 */}
          {!eyeMode && <RoleSprites
            presence={presence} rectOf={rectOfId} obstacles={minimapItems} roleNames={roleNames}
            cam={cam} viewport={camera.viewport}
            quiet={!!spriteAsk}
            onPick={(slug) => setRoleTalk((cur) => (cur === slug ? null : slug))}
          />}
          {roleTalk && (
            <RoleTalkPanel
              projectId={projectId} slug={roleTalk}
              name={roleNames[roleTalk] || roleTalk}
              // 事件驱动的在场态（08-28 新鲜度对齐：精灵是实时的，小窗别慢 12 秒）
              live={Object.values(presence || {}).find((p) => p && slugOfPresence(p.id) === roleTalk) || null}
              onClose={() => setRoleTalk(null)}
            />
          )}

          {/* 精灵对话输入行：点星芒浮出的那道铅笔虚线 */}
          {spriteAsk && (
            <SpriteAskInput
              x={spriteAsk.x} y={spriteAsk.y}
              onSubmit={(t) => onSpriteSay?.(t)}
              onClose={() => setSpriteAsk(null)}
            />
          )}

          {/* 舞台层（板内坐标系）：角标 + 贴物件卡（StageLayer.jsx）
              单独一层浮在所有物件之上 —— 物件的 z 是会长的（pin_to_board 每次
              置顶都 zMax+1），跟舞台卡比大小早晚会盖住 agent 正在写的那个框。
              这层自己不吃事件，卡片各自开 pointerEvents。 */}
          {!eyeMode && <div style={{ position: 'absolute', left: 0, top: 0, zIndex: 300, pointerEvents: 'none' }}>
            <StageBoardLayer
              stageBadges={stageBadges}
              anchoredCards={anchoredCards}
              positioned={positioned}
              visibleIdSet={visibleIdSet}
              boardSize={stageBounds}
              scale={scale}
              onDismiss={dismissStageCard}
            />
          </div>}
        </div>

        {/* 文字输入框：屏幕空间定位，但锚在世界坐标上。
            放在世界层**外面**是有意的 —— 输入框不该跟着缩放变小变糊，
            那样在 0.4 倍视图下根本没法打字。 */}
        {canvasTools.textAt && (
          <TextDraft
            screen={{
              x: (canvasTools.textAt.x + cam.x) * scale,
              y: (canvasTools.textAt.y + cam.y) * scale,
            }}
            onCommit={canvasTools.commitText}
            onCancel={canvasTools.cancelText}
          />
        )}

        {/* 改字输入框：双击一段字 / 文字工具点在字上，预填原文（清空=删除） */}
        {editingText && (
          <TextDraft
            screen={{ x: (editingText.at.x + cam.x) * scale, y: (editingText.at.y + cam.y) * scale }}
            // 就地编辑（2026-08-23）：框的宽、字体、字号跟被改的那块一致（世界尺寸 × 相机缩放），
            // 看起来就是在原位改字，不是弹一张小卡
            inPlace={editingText.style ? { width: (editingText.w || 260) * scale, fontFamily: editingText.style.fontFamily, fontSize: editingText.style.fontSize * scale, color: editingText.style.color } : null}
            initial={editingText.initial}
            placeholder="改成什么…（⌘/Ctrl+Enter 落笔，清空=删除）"
            onCommit={commitTextEdit}
            onCancel={() => setEditingText(null)}
          />
        )}

        {/* 框选的那个框：画在**视口空间**（不在世界层里），所以它的边框粗细
            不跟着缩放变 —— 0.4 倍视图下一条 1px 的虚线会细到看不见。 */}
        {marquee && (
          <div style={{
            position: 'absolute', pointerEvents: 'none', zIndex: 320,
            left: Math.min(marquee.a.sx, marquee.b.sx),
            top: Math.min(marquee.a.sy, marquee.b.sy),
            width: Math.abs(marquee.b.sx - marquee.a.sx),
            height: Math.abs(marquee.b.sy - marquee.a.sy),
            border: `1px dashed ${CANVAS.brass}`,
            background: alpha(CANVAS.brass, 0.08),
          }} />
        )}

        {/* ⚠️ 这里曾有第三个 TextDraft：工具栏「标注(C)」的批注输入框。
            标注 2026-08-13 收敛成 AnnotatePopover 的两个出口之后它没有入口了，
            连同 commentDraft 状态一起删。留在画布那条路现在走 keepAnnotation。 */}

        {/* ⚠️ 这里曾有「点选操作条」（ObjectActionBar，08-27 上午建、同日撤）：
            选中单件在旁边浮一条板书样按钮条。用户拍板撤掉 —— 单击的语义改成
            **直接开标注**（最常用的动作），其余动作仍在 hover 工具条上。 */}


        {/* 小地图（屏幕空间，左下角）。总览从"一种视图"变成"一个导航控件"之后
            全貌靠它看 —— 干活始终在当前这一层。窗开着时跟工具栏一起收掉。
            ⚠️ 触屏档上**按容器宽**撤掉（08-28 起，08-29 改判据）：它在窄容器里
            占掉左下角一大块、还压着工具栏，而它回答的那个问题（"我在哪"）翻页器
            用一句「17/17」答得更好。
            ⭐ 判据是**容器宽不是设备档**：平板本来放得下，但聊天卡一开画布区收到
            422，小地图又开始压工具栏 —— 决定放不放得下的从来是容器，不是屏幕。
            桌面这一轮不动（同样窄的桌面窗口仍然留着它）。 */}
        {!eyeMode && !deckOpen && !winDir && !(touchLane && camera.viewport.w < 560) && (
          <Minimap
            bounds={camera.bounds}
            cam={cam}
            viewport={camera.viewport}
            items={minimapItems}
            onJump={(pt) => camera.jumpToPoint(pt)}
          />
        )}

      </div>

      {/* 舞台 dock（屏幕坐标系，StageLayer.jsx）*/}
      {!eyeMode && <StageDock dockPanels={dockPanels} dockChips={dockChips} onDismiss={dismissStageCard} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {linkPop && (
        <LinkPopover
          x={linkPop.x} y={linkPop.y} mode={linkPop.mode}
          fromTitle={linkPop.from.title} toTitle={linkPop.to.title}
          initialType={linkPop.type || 'link'} initialLabel={linkPop.label || ''}
          initialMaterial={linkPop.material || 'ink'}
          onSubmit={(r) => submitLinkPop({ linkPop, bindings, setBindings, projectId }, r)}
          onDelete={linkPop.mode === 'edit' ? (() => deleteLinkPop({ linkPop, setBindings, projectId })) : null}
          onClose={() => setLinkPop(null)}
        />
      )}
      {linkFrom && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 76, transform: 'translateX(-50%)',
          zIndex: 8000, padding: '6px 14px', borderRadius: 999,
          background: COLOR.text, color: COLOR.bg,
          fontFamily: FONT_SANS, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          连线：{linkFrom.title} ⟶ 点一个目标（Esc 取消）
        </div>
      )}

      {/* 就地标注（E3）：写一句话 → 发送 → agent 立刻起一轮 */}
      {annotate && (
        <AnnotatePopover
          x={annotate.x} y={annotate.y} target={annotate.target}
          // 这批标注是不是全指着同一个常驻角色 —— 是的话这句话**直达它**，
          // 不经过主 agent。判据跟真正发送时走的是同一个函数（lib/role-direct.js），
          // 不能在这儿另写一份：文案说"说给墨璃"而实际发给了主控，比不显示更糟。
          roleTarget={soleRoleTarget(annotate.targets?.length ? annotate.targets : [annotate.target])}
          onClose={() => setAnnotate(null)}
          onSubmit={(text, opts) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, toMain: !!opts?.toMain })}
          // 攒着：同一条回调，多一个 queue 标记 —— 落点在 ProjectWorkspace
          // （pending-changes buffer 和那条浮钮都住在那儿）
          onQueue={(text) => onAnnotate?.({ target: annotate.target, targets: annotate.targets, text, queue: true })}
          onKeep={(text) => keepAnnotation(
            annotate.targets?.length ? annotate.targets.map(t => t.id) : [annotate.target.id],
            camApiRef.current?.toWorld(annotate.x, annotate.y),
            text,
          )}
        />
      )}

      {/* 文件夹窗（2026-08-13）：双击文件夹卡开这扇窗，桌面不动。
          卡片用的是上面那两个 render 函数 —— 窗只负责排位置。 */}
      {winDir && (
        <FolderWindow
          dir={winDir}
          list={listDir}
          onUp={parentDir(winDir) !== null ? folderGoUp : null}
          onClose={closeFolderWindow}
          onNewFolder={createFolderIn}
          onToolbarGroups={onWindowToolbarGroups}
          onContextMenu={openContextMenu}
          renderObject={(o, pos) => renderObjectCard(o, pos)}
          renderFolder={(z, pos) => renderFolderCard(z, pos)}
        />
      )}

      {/* 「移动到…」目标选择：搬出当前文件夹的唯一显式入口 */}
      {moveTo && (
        <MoveToPopover
          x={moveTo.x} y={moveTo.y}
          folders={folders}
          current={moveTo.current || ''}
          exclude={moveTo.exclude || []}
          count={moveTo.ids.length}
          onClose={() => setMoveTo(null)}
          onPick={(dir) => moveManyTo(moveTo.ids, dir)}
        />
      )}

      {/* 项目区 / 阅读 / 图片详情三张浮层：本体在 BoardOverlays.jsx（B5 抽出）*/}
      {projectPanel && (
        <ProjectPanelOverlay
          projectId={projectId} panel={projectPanel}
          onClose={() => setProjectPanel(null)} reload={reload}
        />
      )}

      {viewer && (
        <MarkdownViewerOverlay
          projectId={projectId} viewer={viewer}
          onClose={() => setViewer(null)}
          onSaved={(content) => { setViewer(v => ({ ...v, content })); reload(); }}
        />
      )}

      {detail && (
        <ImageDetailOverlay
          projectId={projectId} detail={detail}
          onClose={() => setDetail(null)}
          onAdd={() => { handleAdd(detail); setDetail(null); }}
        />
      )}

      {orchestrate && (
        <OrchestrateSettings
          projectId={projectId} dir={orchestrate.dir}
          onClose={() => setOrchestrate(null)}
        />
      )}
    </div>
  );
}


/**
 * 便利贴卡体 —— `\n---\n` 分面翻页（note-faces.js 统一约定）。
 * 任务贴（noteTask 非空）右上角带文件名小签，和项目级灵感便签区分。
 * 翻页按钮挂 data-board-action：不触发拖拽 / 双击打开。
 */
/**
 * 画布上写字的输入框。
 *
 * 提交语义：**Enter 换行、Cmd/Ctrl+Enter 提交、点别处也提交、Esc 丢弃**。
 * 用 Enter 直接提交是错的 —— 用户在画布上写的多半是一段话不是一个词，
 * 单行提交会把"想写三行"变成"写了三次"。
 */
// Overlay / toolBtn 随浮层族住 BoardOverlays.jsx（B5）。formatTime / formatSize
// 两个孤儿 helper 同批删除 —— 全文件零调用（BoardObject.jsx 有自己的一对）。
