import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { versionOfFile } from '../../lib/file-versions.js';
import { COLOR } from '../../lib/theme.js';
import BoardCanvas from './BoardCanvas.jsx';
import FloatingToolbar from '../ui/FloatingToolbar.jsx';
import AnnotatePopover from './AnnotatePopover.jsx';
import { t } from '../../lib/i18n.js';

// 懒加载（2026-07-28 重构 4）：DeckWindow 拖着 Monaco 全家，是首屏包的大头，
// 但只在用户 ✏️ 开编辑窗时才需要 —— 动态 import 让它单独分 chunk
const DeckWindow = lazy(() => import('./DeckWindow.jsx'));
const SiteWindow = lazy(() => import('./SiteWindow.jsx'));
const DocxWindow = lazy(() => import('./DocxWindow.jsx'));
const StageWindow = lazy(() => import('./StageWindow.jsx'));
const BrowserWindow = lazy(() => import('./BrowserWindow.jsx'));

/**
 * CanvasFrame — 中栏总壳（2026-07-28 桌面化重构）
 *
 * 工作台（桌面）是唯一顶层曲面，"模式"概念退役：
 *   - 桌面（BoardCanvas）永远渲染；画布层级（项目区 / 工作区）并进顶栏面包屑，
 *     画布自己不再有工具条（2026-07-28）
 *   - 编辑 deck = 在桌面上开一扇最大化窗口（DeckWindow）：铺满视口绝大部分、
 *     桌面压暗在底、窗口头部自带 Edit/Drag/Preview/Code 标签 + 关闭钮，
 *     关掉落回画布的内嵌预览态
 *   - 打开窗口的入口：画布物件的 ✏️（产物与会话解绑，原地就开）
 *
 * 原 deck 编辑内脏（iframe/bridge/overlay/Monaco 全家）整体迁去 DeckWindow.jsx。
 */
export default function CanvasFrame({
  htmlSrc, htmlContent,
  selectedAnchor, onSelectChange,
  onTextEdit,
  onIframeReady,
  candidates,
  activeCandidateId,
  onSelectCandidate,
  onAddCandidate,
  onRemoveCandidate,
  onRenameCandidate,
  project, deckSpec, projectId, sessionId,
  // 浏览器窗（2026-08-18）：画面是活的，但**入口是桌面上那张 browse 卡**
  // （2026-08-18 用户拍板加的）。所以开关由这一层管：事件能开（agent 举手）、
  // 双击卡片也能开。`onBrowse(null)` = 关。
  browseWin, onBrowse,
  comments = [],
  /** 画布上每件东西攒了几条待发标注（卡片角标用） */
  boardNoteCounts = {},
  onAddComment, onResolveComment, onDeleteComment,
  onRegionComment,
  onSiteDomEdit,
  tweaksAvailable = false,
  pendingEdits = [],
  onCommitMove,
  onCommitFreePosition,
  onSubmitDragNote,
  lastPendingEditId = null,
  onApplyPendingEdits,
  onUndoPending,
  onClearAllPending,
  canUndoPending = false,
  isStreaming = false,
  onAddToContext,
  onAskAgent,
  onAnnotate,
  onSpriteSay,
  artifactRefreshToken,
  fileVersions,
  boardVersion,
  boardFocus = null,
  boardUi = null,
  boardApiRef: boardApiRefProp = null,
  onBoardUiState,
  /** 有产物窗开着时通知外层（顶栏据此不再浮现） */
  onWindowOpenChange,
  /** 导出：从顶栏搬进产物窗自己的工具栏（2026-08-13） */
  onExport,
  stageRef = null,
}) {
  // deck 编辑窗口：开/关 + 当前标签页 + 目标（null=当前会话的旧式 deck；{task}=任务 deck）
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckTab, setDeckTab] = useState('edit');
  const [deckTaskSrc, setDeckTaskSrc] = useState(null);
  // BoardCanvas 经 apiRef 暴露操作（顶栏面包屑 / 刷新用；外面给了就用外面那个）
  const ownBoardApiRef = useRef(null);
  const boardApiRef = boardApiRefProp || ownBoardApiRef;
  // ⚠️「✏️ 跨会话编辑」那条链（editNavRef + 切会话后自动开窗）2026-08-13 删除：
  // 它唯一的触发点是 BoardCanvas 里"没有 task 的 deck"分支，而 deck 物件从
  // 08-08 起一律带 task，那条分支已是死代码。留着一个永不被置位的 ref 只会
  // 让人以为还有这么一条路径。
  // 会话没了（回 /work 新对话）→ 会话 deck 窗自然关掉（任务 deck 窗与会话解绑，保留）
  useEffect(() => {
    if (!deckTaskSrc && !sessionId) setDeckOpen(false);   // 旧式会话 canvas 才需要 sid，任务 deck 与会话无关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 站点窗 / 世界窗。三种产物共用 ArtifactWindow 那副外壳（2026-08-07），
  // 但内容层各是各的：deck 是等比 letterbox 的设计稿，站点按真实设备宽取景，
  // 世界是地图 + 世界书。同一时刻只开一扇。
  const [siteSrc, setSiteSrc] = useState(null);
  const [docxSrc, setDocxSrc] = useState(null);
  const [stageSrc, setStageSrc] = useState(null);   // 演出显示器（09-05）：{ kind:'stage', root, title }

  // BoardCanvas ✏️ 入口：
  //   { kind:'session' } | { kind:'task', task, file, title }
  //   { kind:'site', task, base, entry, title, pages, built }
  const openDeck = (desc) => {
    // 浏览器窗不是产物窗：它不占 siteSrc/docxSrc/deckOpen 那三个位子，
    // 可以跟产物窗同时开着（你在看站点、agent 在旁边逛参考站，两件事）。
    if (desc?.kind === 'browse') {
      onBrowse?.({ url: desc.url || null, help: null });
      return;
    }
    if (desc?.kind === 'site') {
      setSiteSrc(desc);
      setDocxSrc(null); setStageSrc(null);
      setDeckOpen(false);
      return;
    }
    if (desc?.kind === 'docx') {
      setDocxSrc(desc);
      setSiteSrc(null); setStageSrc(null);
      setDeckOpen(false);
      return;
    }
    if (desc?.kind === 'stage') {
      setStageSrc(desc);
      setSiteSrc(null); setDocxSrc(null);
      setDeckOpen(false);
      return;
    }
    setDocxSrc(null);
    setSiteSrc(null);
    setStageSrc(null);
    setDeckTaskSrc(desc?.kind === 'task' ? desc : null);
    setDeckTab('edit');
    setDeckOpen(true);
  };

  /**
   * 这扇窗开的是哪一份文件（工作区相对路径）。读和写共用一份 —— 它们本来
   * 就该是同一个值，分成两个同样的表达式只是等着哪天改一处漏一处。
   *
   * ⚠️ 这里曾经拼成 `tasks/<任务>/<file>`（任务模型的遗留）。08-08 扁平化之后
   * `file` 本身**就是**工作区相对路径（`/artifacts` 的 `a.file`，assets.js:398
   * 标着"相对工作区根"），再套一层 `tasks/` 是双重前缀。三个后果，只有第一个
   * 是无害的：
   *
   *   1. 读：`artifact-file` 有兼容 shim 剥掉 `^tasks/<段>/`，**恰好**还原出
   *      正确路径 —— 所以从画面上完全看不出错。
   *   2. 写：`PUT /canvas` 没有 shim，`fs.mkdir(recursive)` + 写盘，会在工作区
   *      根上**重新造出一个 `tasks/` 目录**。下一次 `/artifacts` 调
   *      `ensureProjectWorkspace` 看到 `tasks/` 又活了 → 重跑扁平化迁移 →
   *      同名文件字节不同 → 落一个 `<名>-任务版.html` 的副本。
   *   3. 这个路径还会随 pending-change 传给 agent（`{ path: deckPath }`），
   *      而它指向一个磁盘上根本不存在的位置。
   *
   * 版本按**这一份文件**取：同一个文件夹里别的 deck 被改动时，这扇窗不该重载。
   */
  const deckRelPath = deckTaskSrc
    ? (deckTaskSrc.file || 'canvas.html')
    : null;
  const deckHtmlSrc = deckRelPath
    ? `${Assets.artifactFileUrl(projectId, deckRelPath)}?v=${versionOfFile(fileVersions, deckRelPath)}`
    : htmlSrc;
  const handleTextEditWithPath = onTextEdit
    ? (info) => onTextEdit({ ...info, deckPath: deckRelPath })
    : undefined;

  /**
   * 全项目**唯一**的一条工具栏（2026-08-13 范式改造，用户定的）。
   *
   * 在这之前：画布挂一条、每扇产物窗各挂一条。同一屏上可能有两条、各自算
   * 落点、各自把位置持久化到 localStorage。用户连着报的三件事
   * —— 「工具栏怎么有两套」「位置没对齐」「偏到右下角」—— 修完一个又冒一个，
   * 因为病根是**同一件东西有多个实例**，不是某一处算错。
   *
   * 现在：一条，钉在底缘正中，**永远显示**，内容跟着当前焦点走。
   * 谁在焦点谁把自己的工具组报上来（画布 / 那扇窗），这里只负责渲染。
   *
   * 用 `dock` 而不是 `anchor`：dock 的位置全程由容器算、随容器尺寸重算，
   * 天然免疫"内容后到 → 落点偏了"那一类（anchor 是算一次定终身）。
   * 代价是不能拖了 —— 常驻工具栏本来也不该让人拖丢。
   */
  const [winGroups, setWinGroups] = useState(null);
  const [boardGroups, setBoardGroups] = useState([]);
  const toolbarHostRef = useRef(null);

  /**
   * 工具组的"内容签名"。上报方每次渲染都会造一份新数组（里面全是闭包），
   * 直接 setState 的话身份一变就再渲染一轮 —— 一旦上报方的 memo 依赖有点
   * 不稳，两边就互相踩成**死循环**，而 build 和单测都照不出来。
   *
   * 所以这里按**内容**判等：id / 选中值 / 每颗按钮的 id、文案、禁用与高亮。
   * 变的是身份不是内容 → 不重渲染；缩放百分比那种真变化在 label 里，照样过。
   */
  const sigOf = (gs) => (gs || []).map(g => (g
    ? `${g.id}|${g.value ?? ''}|${g.node ? 'node' : (g.items || []).map(i => `${i.id}${i.label || ''}${i.active ? '*' : ''}${i.disabled ? '!' : ''}`).join(',')}`
    : '')).join('~');

  const boardSigRef = useRef('');
  const reportBoardGroups = useCallback((gs) => {
    const sig = sigOf(gs);
    if (sig === boardSigRef.current) return;
    boardSigRef.current = sig;
    setBoardGroups(gs || []);
  }, []);

  /**
   * 关浏览器窗。**必须是稳定引用**：BrowserWindow 把它算进工具栏 `groups` 的
   * useMemo 依赖，而工具栏一变就会向上报一次 —— 每渲染都新的内联箭头会把
   * "上报"变成无限循环（2026-08-18 真踩到，一小时才定位）。
   */
  const closeBrowse = useCallback(() => onBrowse?.(null), [onBrowse]);

  const winSigRef = useRef('');
  const reportWinGroups = useCallback((gs) => {
    const sig = gs ? sigOf(gs) : '\u0000none';
    if (sig === winSigRef.current) return;
    winSigRef.current = sig;
    setWinGroups(gs);
  }, []);

  // 有窗开着 = 屏幕被一件产物占满，外层据此收掉顶栏的浮现
  const windowOpen = (deckOpen && (sessionId || deckTaskSrc)) || !!siteSrc || !!docxSrc || !!stageSrc || !!browseWin;
  /**
   * 关掉当前这扇窗，不管它是哪一种（2026-08-29 移动端外壳第三刀）。
   *
   * 四种窗各有各的关法，而外面那颗返回键不该也不能认识它们 —— 它只想说
   * 「退回上一层」。所以关法收成一个函数、跟 windowOpen 一起报上去。
   * ⚠️ 稳定引用：它会进调用方的 memo/依赖，每渲染换身份会把"上报"变成
   * 无限循环（closeBrowse 头上那条 08-18 的教训，同一个坑）。
   */
  const closeWindow = useCallback(() => {
    setDeckOpen(false); setDeckTaskSrc(null);
    setSiteSrc(null); setDocxSrc(null); setStageSrc(null);
    closeBrowse();
  }, [closeBrowse]);
  useEffect(() => { onWindowOpenChange?.(!!windowOpen, closeWindow); }, [windowOpen, onWindowOpenChange, closeWindow]);

  /**
   * 窗口态的常驻「评论」按钮（2026-08-24 用户提）：窗开着时画布被盖住，卡片
   * 右上角的标注入口够不着，用户想说句话只能去开侧栏 —— 所以窗开着时工具栏
   * 常驻一颗评论钮，就地弹 AnnotatePopover，目标就是这扇窗里的东西。
   *（AnnotatePopover 头注里"标注不进工具栏"的判据没被推翻：那说的是画布态
   *  ——对象不明。窗开着时对象是唯一的，判据的前提反过来了。）
   */
  const [winNote, setWinNote] = useState(null);
  useEffect(() => { if (!windowOpen) setWinNote(null); }, [windowOpen]);   // 窗关了，纸别留
  const openWinNote = useCallback(() => {
    let target = null;
    if (deckOpen && (sessionId || deckTaskSrc)) {
      const rel = deckRelPath || 'canvas.html';
      target = { kind: 'object', id: `deck:${rel}`, path: rel, title: deckTaskSrc?.title || project?.name || t('幻灯'), typeLabel: t('幻灯') };
    } else if (siteSrc) {
      target = { kind: 'object', id: `site:${siteSrc.base || siteSrc.task || ''}`, path: siteSrc.entry || siteSrc.base || siteSrc.task, title: siteSrc.title || t('站点'), typeLabel: t('站点') };
    } else if (docxSrc) {
      target = { kind: 'object', id: docxSrc.cardId || `docx:${docxSrc.file || ''}`, path: docxSrc.file, title: docxSrc.title || t('文稿'), typeLabel: t('文稿') };
    } else if (stageSrc) {
      target = { kind: 'object', id: stageSrc.cardId || `stage:${stageSrc.root || ''}`, path: stageSrc.root || null, title: stageSrc.title || t('演出'), typeLabel: t('演出') };
    } else if (browseWin) {
      target = { kind: 'object', id: 'browse', path: browseWin.url || null, title: t('浏览器画面'), typeLabel: t('浏览器') };
    }
    if (!target) return;
    const r = toolbarHostRef.current?.getBoundingClientRect();
    setWinNote({
      x: Math.round((r ? r.left + r.width / 2 : window.innerWidth / 2) - 160),
      y: Math.round(r ? r.bottom - 56 : window.innerHeight - 120),
      target,
    });
  }, [deckOpen, sessionId, deckTaskSrc, deckRelPath, siteSrc, docxSrc, stageSrc, browseWin, project?.name]);

  const toolbarGroups = useMemo(() => {
    if (!winGroups) return boardGroups;
    return [...winGroups, {
      id: 'wincomment',
      items: [{
        id: 'comment', icon: MessageSquarePlus, label: t('评论'),
        title: t('对这扇窗里的东西说一句：发给 agent 立刻处理，或先攒着从右下角一起发'),
        onClick: openWinNote,
      }],
    }];
  }, [winGroups, boardGroups, openWinNote]);

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: COLOR.bgWhite,
      overflow: 'hidden',
    }}>
      <div ref={toolbarHostRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <BoardCanvas
          projectId={projectId}
          currentSessionId={sessionId}
          listVersion={artifactRefreshToken}
          fileVersions={fileVersions}
          boardVersion={boardVersion}
          onAddToContext={onAddToContext}
          onAskAgent={onAskAgent}
          onAnnotate={onAnnotate}
          onSpriteSay={onSpriteSay}
          apiRef={boardApiRef}
          onUiState={onBoardUiState}
          stageRef={stageRef}
          onFocusDeck={openDeck}
          onToolbarGroups={reportBoardGroups}
          onWindowToolbarGroups={reportWinGroups}
          noteCounts={boardNoteCounts}
          // 跟顶栏收起用**同一个** windowOpen —— 以前这里是宽松版
          // （`deckOpen || site`），而窗真正渲染用的是严格版，两处
          // 各写一遍：deckOpen 为真但窗没渲染的那一瞬，画布工具栏和小地图
          // 都藏了、窗也没出来，屏幕上一个工具都没有。
          deckOpen={windowOpen}
          focusRequest={boardFocus}
          // 视点上报用：开着哪扇窗（2026-08-23 黑板）
          openWindow={
            (deckOpen && (sessionId || deckTaskSrc)) ? `deck:${deckRelPath}`
              : siteSrc ? `site:${siteSrc.base || siteSrc.task || siteSrc.entry || ''}`
                : docxSrc ? `docx:${docxSrc.file || docxSrc.task || ''}`
                  : stageSrc ? `stage:${stageSrc.root || ''}`
                    : browseWin ? 'browse' : null
          }
        />

        {deckOpen && (sessionId || deckTaskSrc) && (
          <Suspense fallback={null}>
          <DeckWindow
            tab={deckTab}
            onTabChange={setDeckTab}
            onClose={() => setDeckOpen(false)}
            onToolbarGroups={reportWinGroups}
            title={deckTaskSrc?.title || project?.name || t('幻灯')}
            artifactExports={deckTaskSrc?.exports}
            onExport={onExport}
            htmlSrc={deckHtmlSrc}
            htmlContent={htmlContent}
            selectedAnchor={selectedAnchor}
            onSelectChange={onSelectChange}
            onTextEdit={handleTextEditWithPath}
            onIframeReady={onIframeReady}
            candidates={candidates}
            activeCandidateId={activeCandidateId}
            onSelectCandidate={onSelectCandidate}
            onAddCandidate={onAddCandidate}
            onRemoveCandidate={onRemoveCandidate}
            onRenameCandidate={onRenameCandidate}
            project={project}
            deckSpec={deckSpec}
            projectId={projectId}
            sessionId={sessionId}
            comments={comments}
            onAddComment={onAddComment}
            onResolveComment={onResolveComment}
            onDeleteComment={onDeleteComment}
            // 圈选要落到一份具体的任务文件上 —— 旧式会话 deck（canvas.html 挂在
            // 会话目录下、不在 tasks/ 里）没有这样的路径，那种情况下不给这个工具，
            // 而不是发出去再让服务端 400
            onRegionComment={(sessionId && deckRelPath && onRegionComment)
              ? ((payload) => onRegionComment({ ...payload, path: deckRelPath }))
              : null}
            tweaksAvailable={tweaksAvailable}
            pendingEdits={pendingEdits}
            onCommitMove={onCommitMove}
            onCommitFreePosition={onCommitFreePosition}
            onSubmitDragNote={onSubmitDragNote}
            lastPendingEditId={lastPendingEditId}
            onApplyPendingEdits={onApplyPendingEdits}
            onUndoPending={onUndoPending}
            onClearAllPending={onClearAllPending}
            canUndoPending={canUndoPending}
            isStreaming={isStreaming}
          />
          </Suspense>
        )}

        {siteSrc && (
          <Suspense fallback={null}>
            <SiteWindow
              projectId={projectId}
              task={siteSrc.task}
              base={siteSrc.base}
              entry={siteSrc.entry}
              title={siteSrc.title}
              pages={siteSrc.pages}
              built={!!siteSrc.built}
              artifactExports={siteSrc.exports}
              onExport={onExport}
              fileVersions={fileVersions}
              // 直接编辑 + 评论 + 拖拽：交互组件跟 deck 同一套（SiteWindow 内部接线），
              // path 按当前页线程。改字/拖拽都走 onDomEdit 落盘（干净源码重放 + FYI 记录）
              onAddComment={onAddComment}
              onResolveComment={onResolveComment}
              onDeleteComment={onDeleteComment}
              onDomEdit={onSiteDomEdit}
              onRegionComment={onRegionComment}
              comments={comments}
              isStreaming={isStreaming}
              onIframeReady={onIframeReady}
              onClose={() => setSiteSrc(null)}
              onToolbarGroups={reportWinGroups}
            />
          </Suspense>
        )}

        {docxSrc && (
          <Suspense fallback={null}>
            <DocxWindow
              projectId={projectId}
              file={docxSrc.file}
              title={docxSrc.title}
              sourceFile={docxSrc.sourceFile}
              members={docxSrc.members}
              exports={docxSrc.exports}
              // 窗里可能切到别的成员：导出按当前成员点名（`docx:<文件>` 反解成
              // 单文件卡），没点名再退回整卡地址
              onExport={(fmt, file) => onExport?.(fmt, file ? `docx:${file}` : docxSrc.cardId)}
              fileVersions={fileVersions}
              // 圈选评论（页图版）：path/docxPage 由窗内部补（当前成员、当前页只有它知道）
              onRegionComment={onRegionComment}
              onClose={() => setDocxSrc(null)}
              onToolbarGroups={reportWinGroups}
            />
          </Suspense>
        )}

        {stageSrc && (
          <Suspense fallback={null}>
            <StageWindow
              projectId={projectId}
              root={stageSrc.root}
              title={stageSrc.title}
              onClose={() => setStageSrc(null)}
              onToolbarGroups={reportWinGroups}
            />
          </Suspense>
        )}

        {browseWin && (
          <Suspense fallback={null}>
            <BrowserWindow
              projectId={projectId}
              url={browseWin.url}
              help={browseWin.help}
              onClose={closeBrowse}
              onToolbarGroups={reportWinGroups}
            />
          </Suspense>
        )}

        {/* 全项目唯一那条工具栏。**渲染在最后 = 层级压在产物窗之上**
            （窗是 z:500 的绝对层，工具栏得盖得住它），内容跟焦点走。 */}
        <FloatingToolbar
          id="tools"
          boundsRef={toolbarHostRef}
          dock="bottom-center"
          stack="row"
          // 510 = ARTIFACT_WINDOW_Z(500) + 10。写常量不 import ——
          // ArtifactWindow 是懒加载的，为一个数字把它拖进主包不值
          zIndex={510}
          // 贴边浮现（2026-08-14，用户点名跟 AI 悬浮卡同一套手感）：平时收着，
          // 鼠标到底缘那条带就出来；末尾的图钉钉住 = 常驻
          autoHide
          pinnable
          groups={toolbarGroups}
        />

        {/* 工具栏评论钮弹出的那张纸：目标 = 开着的这扇窗。「留在画布」不给
            （窗把画布盖着，落一段看不见的字没有意义） */}
        {winNote && (
          <AnnotatePopover
            x={winNote.x} y={winNote.y} target={winNote.target}
            onClose={() => setWinNote(null)}
            onSubmit={(text) => onAnnotate?.({ target: winNote.target, text })}
            onQueue={(text) => onAnnotate?.({ target: winNote.target, text, queue: true })}
          />
        )}

      </div>
    </div>
  );
}
