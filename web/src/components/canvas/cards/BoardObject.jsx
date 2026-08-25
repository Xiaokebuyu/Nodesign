import { useState, useMemo, useRef, useEffect } from 'react';
import {
  Image as ImageIcon, FileText, Plus, ExternalLink, BookOpen, Trash2, Film,
  MessageSquarePlus, Download, SlidersHorizontal,
} from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, alpha } from '../../../lib/theme.js';
import { PAPER, PAPER_SHADOW } from '../../../lib/paper.js';
import { EASE, POP_IN } from '../../../lib/board-geometry.js';
import { SIZES, sizeOf, actionsOf, chromeOf, cardOf, isTextPreview } from '../../../lib/board-kinds.js';
import { TEXT_FONT_CSS, TEXT_SIZE_PX } from '../../../lib/text-fonts.js';
import MdInk from './MdInk.jsx';
import { useMeasuredSize } from './useMeasuredSize.js';
import { splitNoteFaces, faceParts } from '../../../lib/note-faces.js';
import { formatSize } from '../../../lib/helpers.js';
import { Assets } from '../../../lib/api.js';
import ArtifactCard from './ArtifactCard.jsx';
import NoteBadge from './NoteBadge.jsx';

/**
 * 画布物件的卡体 —— 从 BoardCanvas 拆出来（2026-08-13）。
 *
 * 接缝选在这儿是因为它**天然干净**：这几个组件全靠 props 通信，一个都不闭包
 * BoardCanvas 的状态。相比之下数据层（加载 / 派生 / 落盘）跟组件状态缠在一起，
 * 拆它要先把依赖关系理直，是另一件事。
 *
 * 涂鸦的墨色表留在这儿：它跟服务端 `sanitizeCanvasData` 的白名单是一对，
 * board-kinds.test.js 有一条断言逐字对着两边（"我选了红色，存下来变黑"那种
 * 不一致不报错，只能靠断言钉）。
 */
const SCRIBBLE_INK = {
  ink: PAPER.ink,
  red: PAPER.red,
  pencil: PAPER.pencil,
  brass: CANVAS.brass,
};

/** 单个画布物件（按 type 分派卡片渲染 + 通用 hover 动作条）*/
function BoardObject({
  o, projectId, currentSessionId, fileVersions, added, animateLayout = false, agentActive = false,
  vanishing = false,
  groupTarget = false, selected = false, noteCount = 0,
  renaming = false, onRenameCommit, onRenameCancel,
  /** 文字类真实高度回写（useMeasuredSize）：(id, { h }) → 写 layout */
  onMeasured = null,
  /** 板书防误触（2026-08-24）：闲置板书 —— 手势层把它当空地，双击才武装 */
  chalkIdle = false,
  /** 产物窗开着（08-24）：卡片活预览立刻定格，别跟窗里的实例抢核 */
  previewPaused = false,
  onPointerDown, wasDrag, onPrimary, onAdd, onOpenViewer, onOpenFile, onDetail, onDeleteNote, onFocus, onOrchestrate,
  onAnnotate,
  onExport,
  scale = 1,
  /** 谱系收叠（北极星路线3）：身后叠着几张旧版 + 当前展开态 */
  stackCount = 0, stackOpen = false, onToggleStack = null,
  /** 悬停上报（路线5）：让画布点亮连着这张卡的关系线 */
  onHoverCard = null,
}) {
  const [hover, setHover] = useState(false);
  // 离开宽限：pointerLeave 不立刻收工具条，等 200ms。没有这条的话，鼠标奔着
  // 按钮去的路上稍微出界一下（很容易，按钮浮在卡外）工具条就当场卸载 ——
  // 用户的原话是"鼠标一离开产物本身视图点击按钮，按钮就会消失"。
  const hoverTimer = useRef(null);
  const rootRef = useRef(null);
  const textual = o.type === 'text' || !!o.chalk;
  useMeasuredSize(rootRef, o, textual ? onMeasured : null, [o.data?.t, o.text, o.data?.size, o.data?.format]);
  const armHover = () => { clearTimeout(hoverTimer.current); setHover(true); onHoverCard?.(o.id); };
  const disarmHover = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(false), 200);
    onHoverCard?.(null);   // 线的高亮即时熄（不吃工具条那 200ms 宽限）
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const sz = sizeOf(o);
  // 一笔墨不是一张纸 —— 不给卡片外观（底色/描边/影子全免），只在悬停时浮出
  // 一点底色示意"这一笔是可以拖的"。
  //
  // ⚠️ 判据 2026-08-13 从硬编码的 `o.type === 'scribble'` 换成形态表的
  // `chrome` 轴。`text` 加进来的时候漏了这一行，于是画布上手写的字外面套着
  // 一张白卡 —— 而它自己的注释写着"没有卡片外观，就是一段字浮在纸上"。
  // 每加一种画布原生物件就漏一次，这种判据就该住在表里。
  const isInk = chromeOf(o) === 'bare';
  // 纯手写字：块宽由正文决定（max-content，封顶 26em），存档的 w 只是回写的镜像 —— 估宽不准
  // 就折行/留白，用户点到空白也算点到字（08-23 误触案）。md 节点和板书仍按 w 折行。
  const plainText = o.type === 'text' && o.data?.format !== 'md';
  const base = {
    position: 'absolute', left: o.pos.x, top: o.pos.y,
    ...(plainText
      ? { width: 'max-content', maxWidth: 26 * (TEXT_SIZE_PX[o.data?.size] || TEXT_SIZE_PX.md) + 12 }
      : { width: sz.w }),
    zIndex: o.pos.z || 1,
    borderRadius: isInk ? 4 : RADIUS.xl,
    background: isInk ? (hover ? alpha(CANVAS.brass, 0.10) : 'transparent') : COLOR.bgCard,
    border: isInk ? 'none' : `1px solid ${added ? COLOR.text : COLOR.borderLt}`,
    // 谱系收叠的纸叠感：两层偏移的「纸边」用 box-shadow 画（填充色一层 +
    // 描边色一层），画在元素底下不占 DOM、不吃指针、不压自家边框
    boxShadow: (() => {
      const paper = isInk ? null : (hover ? '0 4px 14px rgba(0,0,0,0.12)' : '0 1px 4px rgba(0,0,0,0.05)');
      const stack = (stackCount > 0 && !stackOpen && !isInk)
        ? `4px 4px 0 -1px ${COLOR.bgCard}, 4px 4px 0 0 ${COLOR.borderLt}, 8px 8px 0 -1px ${COLOR.bgCard}, 8px 8px 0 0 ${COLOR.borderLt}`
        : null;
      const parts = [stack, paper].filter(Boolean);
      return parts.length ? parts.join(', ') : 'none';
    })(),
    // 闲置板书不给抓手光标 —— 它此刻对手势就是空地，别暗示"能拖"
    cursor: chalkIdle ? 'default' : 'grab', userSelect: 'none',
    touchAction: 'none',
    animation: POP_IN,
    // 草稿态（2026-08-23 黑板）：agent 这一轮还在打草稿的东西半透明，落定变实
    ...((o.staging || o.pos?.staging) ? { opacity: 0.55 } : null),
    // 变换（2026-08-13，选中态控制器写入 data.rotation / data.scale）：
    // 围绕中心转/缩。命中不用另算 —— DOM 事件本来就跟着 transform 走，
    // 选中框作为子层也一起转。只有墨类（text/scribble）有这两个字段。
    ...(isInk && (o.data?.rotation || (o.data?.scale && o.data.scale !== 1)) ? {
      transform: `rotate(${o.data?.rotation || 0}deg) scale(${o.data?.scale ?? 1})`,
      transformOrigin: '50% 50%',
    } : null),
    // agent 此刻正在动这个物件 → 外圈光圈（放在 animation 之后才盖得住）。
    // 转动的那段亮弧画在下面的伪层里，这里只管稳的那一圈。
    // ⚠️ 这几处都写**完整的 border 简写**，不写 borderColor：上面 base 里已经
    // 有 `border`，简写和分写混在同一个 style 对象里，React 会在重渲染时警告
    // 并且哪个生效取决于键序 —— 属于"改了颜色没变"那类玄学。
    ...(agentActive ? {
      animation: 'ndAgentRing 1600ms ease-in-out infinite',
      border: `1px solid ${alpha(CANVAS.brass, 0.85)}`,
    } : null),
    // 被框选中：一圈外框。用 outline 不用 border —— border 会挤动内容
    // （卡里的排版按 width 算过），outline 不占布局
    ...(selected ? {
      outline: `2px solid ${CANVAS.brass}`,
      outlineOffset: 1,
    } : null),
    // 有东西正摞过来 → 亮一圈，示意"松手就把你俩归到一个文件夹里"
    ...(groupTarget ? {
      border: `1px solid ${CANVAS.brass}`,
      boxShadow: `0 0 0 3px ${alpha(CANVAS.brass, 0.22)}, 0 8px 20px rgba(0,0,0,0.14)`,
    } : null),
    // agent 改布局（pin / board.updated 重拉 / 自动入座）时位置变化以滑动呈现；
    // 用户拖拽期间关掉（要逐帧跟手）—— dragActive 经 animateLayout 传进来
    transition: `${animateLayout ? `left 380ms ${EASE}, top 380ms ${EASE}, ` : ''}width 260ms ${EASE}, box-shadow 0.15s${vanishing ? `, transform 380ms ${EASE}, opacity 320ms ${EASE}` : ''}`,
    // 飞进文件夹的告别态（搬家动画）：滑向文件夹中心的同时缩小淡出。
    // 覆盖在 base 的所有装饰之后 —— 飞行中不吃指针、不亮悬停。
    ...(vanishing ? {
      opacity: 0.1,
      transform: 'scale(0.25)',
      transformOrigin: '50% 50%',
      pointerEvents: 'none',
    } : null),
  };

  // 按钮清单由形态表给（board-kinds.js 的 actions，顺序即渲染顺序），
  // 这里只把动作 id 兑换成图标和回调。
  const ACTION_DEFS = {
    add: { icon: Plus, title: added ? '已在托盘' : '加入上下文', fn: onAdd },
    read: { icon: BookOpen, title: '阅读', fn: onOpenViewer },
    detail: { icon: ExternalLink, title: '详情', fn: onDetail },
    // .md 两条路都给：「阅读」是渲染过的（双击也走这条），「打开」是原始文件
    open: { icon: ExternalLink, title: '打开', fn: onOpenFile },
    // 编排.yaml：图形设置页（双击也走这条），「打开」仍留给原始文件
    orchestrate: { icon: SlidersHorizontal, title: '编排设置', fn: onOrchestrate },
    delete: { icon: Trash2, title: '删除', fn: onDeleteNote },
  };
  /**
   * 标注**不在形态表里**，它排在所有形态的按钮之后无条件出现（2026-08-13）。
   *
   * 理由是表的意义在于记录**差异**：标注对每一种东西都成立、写法一字不差，
   * 抄进十条形态就是把同一句话说十遍，下次加形态还得记着补第十一遍。
   * 右键菜单那边同理 —— 它也是全类型无条件给。
   *
   * 位置固定在最右：那是"跟 agent 说话"的位置，deck 这种别的按钮都没有的
   * 形态也照样有它（用户要的就是**每个**产物右上角都能标注）。
   */
  const actions = [
    ...actionsOf(o).map(id => ACTION_DEFS[id]).filter(Boolean),
    // 导出跟标注同理：**每一种产物卡都能导出**，所以不进形态表。抄进十条形态
    // 就是把同一句话说十遍，加第十一种形态还得记着补一遍。
    ...(onExport ? [{ icon: Download, title: '导出这张卡', fn: onExport }] : []),
    { icon: MessageSquarePlus, title: '标注（发给 agent / 留在画布）', fn: onAnnotate, anchored: true },
  ];

  // 工具条挂在卡片上沿之外。这里有两个坑，都踩过：
  //
  // 1. **死缝**：以前写 `top:-26` 而条高约 22px —— 条和卡之间留了一道几像素的
  //    空隙。鼠标从卡奔按钮，穿过空隙的一瞬 pointerLeave 触发、hover 归零、
  //    按钮在你点到之前卸载。修法是外壳 `bottom:'100%'`（下沿贴死卡上沿）+
  //    paddingBottom 当桥：视觉上条还是浮在卡外 4px，但命中区域连续无缝。
  // 2. **镜头缩小按钮跟着缩**：条住在世界层里，scale 0.5 时 13px 图标只剩
  //    6px 物理像素。反缩放 1/(相机×物件缩放) 让它物理尺寸恒定 ——
  //    跟 TransformControls 的手柄同一条规矩。origin 钉在右下角，
  //    缩放围绕"贴卡那一点"进行，桥不会被缩出缝来。
  const invScale = 1 / (scale * (isInk ? (o.data?.scale ?? 1) : 1));
  const Actions = hover && actions.length > 0 && (
    <div data-board-action style={{
      position: 'absolute', bottom: '100%', right: 0, paddingBottom: 4, zIndex: 5,
      transform: invScale !== 1 ? `scale(${invScale})` : undefined,
      transformOrigin: '100% 100%',
    }}>
      <div style={{
        display: 'flex', gap: GAP.xxs,
        // 一小片浮起来的纸，不是描边白盒。这条工具标是 2026-08-03 之前全站换肤
        // 唯一漏掉的地方 —— 因为它写死了 rgba(255,255,255,.95)，绕过了整套 token，
        // 于是纸面上飘着一个上一代设计语言的白色圆角描边框。
        background: PAPER.paper, border: 'none',
        borderRadius: RADIUS.md, padding: GAP.xxs,
        boxShadow: PAPER_SHADOW.far,
      }}>
        {actions.map((a, i) => {
          const Icon = a.icon;
          return (
            <button key={i} title={a.title} data-board-action
              onClick={(e) => {
                e.stopPropagation();
                if (wasDrag()) return;
                // 带锚的动作（标注）要知道自己被按在屏幕哪儿 —— 浮层从按钮
                // 底下长出来，而不是从卡片中心或者上次右键的位置
                if (a.anchored) {
                  const r = e.currentTarget.getBoundingClientRect();
                  a.fn?.({ x: r.left, y: r.bottom + 6 });
                } else a.fn?.();
              }}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.text, display: 'flex', padding: 5 }}>
              <Icon size={13} />
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-board-object={o.id}
      data-board-type={o.type}
      // 闲置板书打标：board-hit.onObject 见到它按空地算（平移/框选/取消选中照旧）
      data-chalk-idle={chalkIdle ? '1' : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (e.target.closest('[data-board-action]')) return;
        if (!wasDrag()) onPrimary?.();
      }}
      onPointerEnter={armHover}
      onPointerLeave={disarmHover}
      style={base}
    >
      {Actions}
      <NoteBadge count={noteCount} />

      {/* （doc 卡分支 2026-08-24 拆除：记忆/品牌/指引画布分身退役） */}

      {/* deck / 站点 / 世界共用一张方卡（cards/ArtifactCard.jsx）。
          在这之前这里是六个分支约 180 行 —— 三种形态 × 收起/展开两态，骨架
          逐字节相同，只有图标、一行小字、缩略图内容三处不一样。 */}
      {cardOf(o) === 'artifact' && (
        <ArtifactCard
          o={o} projectId={projectId} fileVersions={fileVersions} scale={scale}
          renaming={renaming} onRenameCommit={onRenameCommit} onRenameCancel={onRenameCancel}
          previewPaused={previewPaused}
        />
      )}

      {o.type === 'image' && (
        <div>
          <div style={{ aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#f4f2ee' }}>
            <img
              src={thumbSrcOf(projectId, o)} alt={o.name} loading="lazy" draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, padding: `${GAP.xs}px ${GAP.sm}px` }}>
            <ImageIcon size={10} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.meta?.assetRole ? `[${o.meta.assetRole}] ` : ''}{o.name}
            </span>
          </div>
        </div>
      )}

      {/* 运动环绕光圈（2026-08-08）：一段亮弧沿着卡的外沿转。
          conic-gradient 的**起始角**转一圈 + mask 只留边框那一环 —— 比逐帧画
          SVG 便宜，而且跟着卡片圆角走。pointerEvents:none，不吃任何手势。

          ⚠️ 转角度不转元素（2026-08-17 修）：动画写在 `--ndSweep` 上，别改回
          `transform: rotate` —— 那转的是这个矩形本身，非正方的卡一转光就飞出
          卡外，理由与复现见 board-keyframes.js。

          环放在卡边**外侧**（inset -4 / padding 3）而不是压着边框：卡自己在
          agentActive 时已经是一圈黄铜实边，同色 2px 弧叠上去几乎看不见（改对
          转法之后才暴露出来）。弧心提亮到暖白 = "一点光扫过黄铜"，运动感靠
          明度差读出来，不靠位移。 */}
      {agentActive && (
        <div aria-hidden style={{
          position: 'absolute', inset: -4, borderRadius: 'inherit',
          padding: 3, pointerEvents: 'none', zIndex: 3,
          background: 'conic-gradient(from var(--ndSweep, 0deg), transparent 0deg, transparent 244deg, '
            + `${alpha(CANVAS.brass, 0.9)} 300deg, rgba(255,247,225,1) 328deg, ${alpha(CANVAS.brass, 0.6)} 346deg, transparent 358deg)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor', maskComposite: 'exclude',
          animation: 'ndAgentSweep 1400ms linear infinite',
        }} />
      )}

      {o.type === 'text' && o.data?.format === 'md' && (
        /* md 档（2026-08-23 黑板）：同一块纸上的字，只是排版认 markdown/KaTeX/mermaid */
        <div data-text-body style={{ padding: '4px 6px', pointerEvents: 'none', userSelect: 'none' }}>
          <MdInk
            text={o.data?.t || ''}
            fontFamily={TEXT_FONT_CSS[o.data?.font] || TEXT_FONT_CSS.kai}
            fontSize={TEXT_SIZE_PX[o.data?.size] || TEXT_SIZE_PX.md}
            color={SCRIBBLE_INK[o.data?.color] || PAPER.ink}
          />
        </div>
      )}
      {o.type === 'text' && o.data?.format !== 'md' && (
        /* 画布手写文字：没有卡片外观（同涂鸦），就是一段字浮在纸上。
           白名单字体表在 lib/text-fonts.js，跟服务端那份校验对齐。 */
        <div data-text-body style={{
          fontFamily: TEXT_FONT_CSS[o.data?.font] || TEXT_FONT_CSS.kai,
          fontSize: TEXT_SIZE_PX[o.data?.size] || TEXT_SIZE_PX.md,
          lineHeight: 1.6,
          color: SCRIBBLE_INK[o.data?.color] || PAPER.ink,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          padding: '4px 6px', pointerEvents: 'none', userSelect: 'none',
        }}>{o.data?.t || ''}</div>
      )}

      {o.type === 'scribble' && (
        /* 涂鸦：路径存的是**相对物件左上角**的偏移，所以这里不用管 o.pos，
           直接铺满卡片即可 —— 拖动涂鸦只改 x/y，路径一个字节不重写。
           overflow:visible 是必需的：笔画的抗锯齿会稍稍溢出包围盒。 */
        <svg
          width={sz.w} height={sz.h}
          style={{ display: 'block', overflow: 'visible', pointerEvents: 'none' }}
        >
          <path
            d={o.data?.d || ''}
            fill="none"
            stroke={SCRIBBLE_INK[o.data?.color] || PAPER.ink}
            strokeWidth={o.data?.width || 2}
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )}

      {o.type === 'note' && !o.chalk && <NoteFaces o={o} />}
      {o.type === 'note' && o.chalk && (
        /* 板书：agent/用户写在画布上的话 —— 裸 md 文字浮在纸上（同手写字的 md 档）。
           pointerEvents none 让闲置板书对手势是空地；nd:controls 围栏的按钮在
           MdInk 里自己开 auto（点选项不该要求先武装板书）。 */
        <div data-text-body style={{ padding: '4px 6px', pointerEvents: 'none', userSelect: 'none' }}>
          <MdInk
            text={o.text || ''} fontFamily={TEXT_FONT_CSS.kai} fontSize={TEXT_SIZE_PX.md} color={PAPER.ink}
            origin={{ id: o.id, path: o.path || o.id, title: o.title || '' }}
          />
        </div>
      )}

      {o.type === 'video' && (
        <div>
          {/* 播放器区拦下 pointer 事件：video controls 的点击不能变成拖卡 */}
          <div
            data-board-action
            onPointerDown={(e) => e.stopPropagation()}
            style={{ aspectRatio: '16 / 9', overflow: 'hidden', borderRadius: '10px 10px 0 0', background: '#000' }}
          >
            <video
              src={Assets.artifactFileUrl(projectId, o.path)}
              controls preload="metadata" playsInline
              style={{ width: '100%', height: '100%', display: 'block' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, padding: `${GAP.xs}px ${GAP.sm}px` }}>
            <Film size={10} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {o.name}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{formatSize(o.size)}</span>
          </div>
        </div>
      )}

      {o.type === 'file' && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px ${GAP.md}px`, flexShrink: 0 }}
          >
            <FileText size={12} color={COLOR.sub} />
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {o.name}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{formatSize(o.size)}</span>
          </div>
          {/* 文本文件预览体（08-24）：md 渲染、其余（json/csv/yaml）等宽原样。
              服务端截 1KB 进 preview（frontmatter 已藏），完整内容双击进阅读器 */}
          {o.preview && isTextPreview(o) && (
            /\.(md|markdown)$/i.test(o.name || '') ? (
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: `0 ${GAP.md}px ${GAP.sm}px`, fontSize: FONT_SIZE.xs, lineHeight: 1.5, color: COLOR.text2, maskImage: 'linear-gradient(180deg, #000 70%, transparent)' }}>
                <MdInk text={o.preview} fontSize={11} />
              </div>
            ) : (
              <pre style={{ flex: 1, minHeight: 0, overflow: 'hidden', margin: 0, padding: `0 ${GAP.md}px ${GAP.sm}px`, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, lineHeight: 1.5, color: COLOR.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maskImage: 'linear-gradient(180deg, #000 70%, transparent)' }}>
                {o.preview}
              </pre>
            )
          )}
        </div>
      )}

      {stackCount > 0 && (
        <button
          data-board-action
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggleStack?.(); }}
          title={stackOpen ? '把旧版收回这张卡身后' : '展开身后的旧版'}
          style={{
            position: 'absolute', bottom: -8, left: -6,
            background: stackOpen ? COLOR.bg : COLOR.text,
            color: stackOpen ? COLOR.text : COLOR.bg,
            border: `1px solid ${stackOpen ? COLOR.borderLt : COLOR.text}`,
            borderRadius: RADIUS.md, cursor: 'pointer',
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, padding: '1px 6px',
          }}
        >
          {stackOpen ? '收起' : `⧉ ${stackCount}`}
        </button>
      )}

      {added && (
        <div style={{
          position: 'absolute', bottom: -8, right: -6,
          background: COLOR.text, color: COLOR.bg, borderRadius: RADIUS.md,
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, padding: '1px 5px',
        }}>
          托盘✓
        </div>
      )}
    </div>
  );
}

function NoteFaces({ o }) {
  const [face, setFace] = useState(0);
  const faces = useMemo(() => splitNoteFaces(o.text || ''), [o.text]);
  const idx = Math.min(face, faces.length - 1);
  const { title, body } = faceParts(faces[idx]);
  const faceBtn = {
    border: 0, background: 'transparent', cursor: 'pointer', color: COLOR.sub,
    fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, lineHeight: 1, padding: `${GAP.xxs}px ${GAP.sm}px`,
  };
  return (
    <div style={{
      padding: GAP.md, background: CANVAS.note, borderRadius: RADIUS.xl, minHeight: SIZES.note.h - 2,
      display: 'flex', flexDirection: 'column',
    }}>
      {(o.noteTask || title) && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.sm, marginBottom: GAP.xs, minWidth: 0 }}>
          {title && (
            <span style={{
              fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.sm, color: COLOR.text,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{title}</span>
          )}
          {o.noteTask && (
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub, marginLeft: 'auto', flexShrink: 0 }}>
              {o.name.replace(/\.md$/i, '')}
            </span>
          )}
        </div>
      )}
      <div style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1,
        display: '-webkit-box', WebkitLineClamp: title ? 4 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {body || o.name}
      </div>
      {faces.length > 1 && (
        <div data-board-action style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: GAP.sm, marginTop: GAP.xs }}>
          <button data-board-action style={faceBtn} title="上一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx - 1 + faces.length) % faces.length); }}>‹</button>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub }}>{idx + 1}/{faces.length}</span>
          <button data-board-action style={faceBtn} title="下一面"
            onClick={(e) => { e.stopPropagation(); setFace((idx + 1) % faces.length); }}>›</button>
        </div>
      )}
    </div>
  );
}

/**
 * 图片卡的图源。
 *
 * `.thumbnails/` 那条快路只对 `assets/generated` 下的生成图存在（服务端只给
 * 那批预生成）。图片 2026-08-13 起可以被搬进文件夹，搬走之后 `hasThumb` 就是
 * false —— 这时**不能直接发原图**：一张 149KB 的 webp 塞进 200px 宽的卡里，
 * 二十张就是几 MB 的白烧。走 `?w=` 响应式档（服务端 imageVariant，webp 也能缩，
 * 2026-08-01 修过），实测同一张 149KB → 12KB。
 */
export function thumbSrcOf(projectId, item) {
  if (item.hasThumb) {
    const base = item.name.replace(/\.[^.]+$/, '');
    return Assets.artifactFileUrl(projectId, `assets/generated/.thumbnails/${base}.thumb.webp`);
  }
  return `${Assets.artifactFileUrl(projectId, item.path)}?w=480`;
}

export default BoardObject;
