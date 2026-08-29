import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Monitor, Tablet, Smartphone, RotateCw, ExternalLink, FileCode, Eye, ArrowLeft, Pencil, Move, SquareDashedMousePointer, SlidersHorizontal } from 'lucide-react';
import { Assets } from '../../lib/api.js';
import { joinRel } from '../../lib/paths.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, EDITOR } from '../../lib/theme.js';
import { SITE_VIEWPORTS } from '../../lib/board-geometry.js';
import ArtifactWindow, { exportToolGroup } from './ArtifactWindow.jsx';
import { SiteModeBanner } from './site-window-banner.jsx';
import RegionSelect from './RegionSelect.jsx';
import { attachEditMode, detachAll } from './DirectEditBridge.js';
import { serializeForAI, redactAnchor } from '../../lib/element-semantics.js';
import { findElementByAnchor } from '../../lib/html-utils.js';
import { applyMoveToRuntime, applyStyleToRuntime } from '../../lib/pending-edit-apply.js';
import { applyOpsToSource } from '../../lib/site-source-patch.js';
import { versionOfSitePage } from '../../lib/file-versions.js';
import LiveFrame from './LiveFrame.jsx';
import EditOverlay from './EditOverlay.jsx';
import InspectFloatingCard from './InspectFloatingCard.jsx';
import CommentMarkers from './CommentMarkers.jsx';
import DragOverlay, { pickDragSource } from './DragOverlay.jsx';
import GrabHandle from './GrabHandle.jsx';
import PostDragNotePanel from './PostDragNotePanel.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import SitePublishControl from './SitePublishControl.jsx';
import { useOrchestrateEntry } from './orchestrate-entry.jsx';
import { PAPER_SHADOW } from '../../lib/paper.js';

/**
 * SiteWindow —— 站点的最大化窗口（2026-07-28，跟 DeckWindow 并列的第二种产物窗）
 *
 * 为什么不复用 DeckWindow：那扇窗的核心是 **letterbox**——把一份 1920×1080 的设计稿
 * 等比缩进窗口里。站点没有"设计稿尺寸"这回事，它的版面是被视口宽度算出来的。
 * 拿 deck 那套缩放去看站点，手机档只会得到"缩小的桌面版"，断点有没有生效根本
 * 看不出来 —— 那等于给 agent 和用户都蒙上眼睛，还是无声的。
 *
 * 所以这里：iframe 的 CSS 像素宽 = 目标设备宽度，**不做 transform 缩放**；
 * 窗口装不下就整体等比缩一次（只为了塞进屏幕，媒体查询已经按真实宽度算过了）。
 *
 * 站内导航是窗口内部状态：点站内链接就在同一扇窗里换页，地址栏跟着走。
 *
 * 编辑/拖拽（2026-07-29 与 deck 对齐）：交互组件全部复用 deck 的那套 ——
 * EditOverlay 选中光圈、InspectFloatingCard 评论浮卡、CommentMarkers 橙色标记、
 * DragOverlay/GrabHandle 拖拽全家。差别只在数据层落点：deck 的拖拽走
 * pending buffer 等 agent 应用；站点是我们自己的纯 HTML 文件，改动由前端
 * 自己写盘（Canvas.write 通道）：**磁盘干净源码 + 按锚点重放操作**（见
 * site-source-patch.js），脚本页的运行时产物不进文件。拖拽先进暂存栈、
 * 用户确认才落盘（确认前可撤销一步/全部放弃）；改字 Enter 即确认，600ms
 * 合并落盘。buffer 里只留 applied-* 与 edit 的 FYI 记录让 agent 知道动过什么。
 * React mount 区是唯一例外 —— 运行时 DOM 动了会被 next render 覆盖，
 * 照旧推 pending-*，agent 改 JSX 源码。
 */
export default function SiteWindow({
  projectId,
  task,
  base,                 // 产物根（工作区相对；根站是 ''）；单页卡传入口所在目录
  entry = 'index.html',
  title,
  pages = [],
  fileVersions = null,  // 按文件版本表：本页 html 或共享资产变了才刷新（别的页不扰动）
  built = false,        // 构建型站点：编辑落在产物上，agent 会同步回源再构建
  onAddComment = null,
  onResolveComment = null,
  onDeleteComment = null,
  onDomEdit = null,     // 拖拽落盘通道：({ path, html, summary, records, persist }) => void
  onRegionComment = null,   // 圈选评论：({ region, viewport, elements, text }) => Promise
  onIframeReady = null,
  isStreaming = false,
  comments = [],
  /** 服务端给的可导出格式（/artifacts 的 tasks[].exports），随 focusDeck 传下来 */
  artifactExports = null,
  onExport = null,
  /** 工具组交给外层那条常驻工具栏（窗自己不渲工具栏了） */
  onToolbarGroups = null,
  onClose,
}) {
  const [viewport, setViewport] = useState(SITE_VIEWPORTS[0].id);
  const [tab, setTab] = useState('preview');
  const [selected, setSelected] = useState(null);   // { anchor } 编辑模式选中态
  const [current, setCurrent] = useState(entry);      // 当前看的是站内哪一页
  const [history, setHistory] = useState([]);          // 站内后退栈
  const [sourceText, setSourceText] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
  const [iframeDoc, setIframeDoc] = useState(null);
  const [docTick, setDocTick] = useState(0);           // iframe 每次 load +1：桥/overlay 重绑新 doc
  const [dragFreeMode, setDragFreeMode] = useState(false);
  const [collageWarn, setCollageWarn] = useState(false);   // 大量绝对定位 = 拼贴式版面，DOM 拖拽不可靠
  const [isDragging, setIsDragging] = useState(false);
  const [draggedSource, setDraggedSource] = useState(null);
  const [notePanelOpen, setNotePanelOpen] = useState(false);
  const wrapRef = useRef(null);
  const iframeRef = useRef(null);

  const vp = SITE_VIEWPORTS.find(v => v.id === viewport) || SITE_VIEWPORTS[0];
  // 根站的 base 合法地是空串（扁平化后站点住工作区根）。老兜底 `tasks/${task}`
  // 在扁平世界拼出 `tasks//index.html`（服务端旧前缀剥离正则不吃空段 → 404）；
  // 现在 task 本身就是文件夹路径，直接当兜底。joinRel 防前导斜杠 403。
  const baseRel = base || task || '';
  const relPath = joinRel(baseRel, current);
  // 版本按**这一页**取（本页 html + 非 html 共享资产）：agent 改别的页时这扇窗不动
  const pageVersion = versionOfSitePage(fileVersions, baseRel, current);
  const src = `${Assets.artifactFileUrl(projectId, relPath)}?v=${pageVersion}-${reloadKey}`;

  const editable = !!onDomEdit;
  const draggable = !!onDomEdit;
  const relPathRef = useRef(relPath); relPathRef.current = relPath;
  const tabRef = useRef(tab); tabRef.current = tab;

  // 换任务 / 换入口时回到入口页（同一扇窗被复用的场景）
  useEffect(() => { setCurrent(entry); setHistory([]); }, [task, entry]);

  // 当前页的评论（站点评论都带 path；别的页 / deck 的评论不在这份 doc 里，别拿来找元素）
  const pageComments = useMemo(
    () => comments.filter(c => c.path === relPath),
    [comments, relPath],
  );

  // ── 编辑落盘队列 ─────────────────────────────────────────────
  // 用户改完 = 运行时 DOM 已是目标状态。落盘不直接序列化运行时 DOM（脚本页会把
  // pin-spacer/注入节点/动画中间态一并烤进源文件），而是取磁盘干净源码，把这批
  // 操作（改字/搬移/复制/定位）按锚点重放上去再写回 —— 见 site-source-patch.js。
  // 锚点在干净副本上找不到（脚本改了结构）才回退整页序列化：宁可带污染别丢改动。
  // 写盘 debounce 600ms：nudge 连按只落最后一版；flush 串行链（上一笔写完才取
  // 下一笔的源码），不然第二笔会基于旧源码重放、覆盖掉第一笔。
  const persistJobRef = useRef(null);
  const persistTimerRef = useRef(null);
  const flushChainRef = useRef(Promise.resolve());
  const onDomEditRef = useRef(onDomEdit); onDomEditRef.current = onDomEdit;

  const runFlushJob = useCallback(async (job) => {
    let html = null;
    let fallback = false;
    try {
      const res = await fetch(Assets.artifactFileUrl(projectId, job.path));
      if (res.ok) html = applyOpsToSource(await res.text(), job.ops);
    } catch { /* 走回退 */ }
    if (!html) {
      // 回退：整页序列化运行时 DOM（剥掉拖拽模式的运行时装饰）
      fallback = true;
      try {
        if (job.doc) {
          const body = job.doc.body;
          const prevSel = body?.style.userSelect || '';
          if (body) body.style.userSelect = '';
          html = '<!doctype html>\n' + job.doc.documentElement.outerHTML;
          if (body) body.style.userSelect = prevSel;
          html = html.replace(/ style=""/g, '');
        }
      } catch { html = null; }
    }
    if (!html) return;
    const records = fallback
      ? job.records.map(r => ({ ...r, serializedFrom: 'runtime-dom' }))
      : job.records;
    await onDomEditRef.current?.({ path: job.path, html, summary: job.summary, records, persist: true });
  }, [projectId]);

  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
    const job = persistJobRef.current;
    if (!job) return;
    persistJobRef.current = null;
    flushChainRef.current = flushChainRef.current
      .then(() => runFlushJob(job))
      .catch(() => { /* 单笔失败不断链 */ });
  }, [runFlushJob]);

  const anchorKey = (a) => a?.dataId || a?.path || '';

  // ── 拖拽暂存栈（2026-07-30：拖完不立刻落库，确认才写盘，给反悔机会）──
  // 每笔 {op, record, revert}：op 给干净源码重放用；revert 是运行时回退闭包
  // （撤销 = 画面原地退回）。保存时整栈进落盘链；换页/关窗/agent 开跑前自动保存
  // （运行时 DOM 即将销毁，不救就丢）。改字不走这里 —— Enter/Esc 本身就是确认/反悔。
  const stagedRef = useRef([]);
  const [stagedCount, setStagedCount] = useState(0);

  const stageOp = useCallback((entry) => {
    const staged = stagedRef.current;
    const last = staged[staged.length - 1];
    // 连续 nudge 合并：同元素 style 只留最后一版（revert 保留第一笔的 —— 回到原点）
    if (last && last.op.type === 'style' && entry.op.type === 'style'
        && anchorKey(last.op.anchor) === anchorKey(entry.op.anchor)) {
      last.op = entry.op;
      last.record = entry.record;
    } else {
      staged.push(entry);
    }
    setStagedCount(staged.length);
  }, []);

  const saveStaged = useCallback(() => {
    const staged = stagedRef.current;
    if (staged.length === 0) return;
    stagedRef.current = [];
    setStagedCount(0);
    let doc = null;
    try { doc = iframeRef.current?.contentDocument; } catch { doc = null; }
    const job = {
      path: relPathRef.current,
      doc,
      ops: staged.map(e => e.op),
      records: staged.map(e => e.record),
      summary: `${staged.length} 处布局调整`,
    };
    flushChainRef.current = flushChainRef.current
      .then(() => runFlushJob(job))
      .catch(() => { /* 单笔失败不断链 */ });
  }, [runFlushJob]);

  const undoStaged = useCallback(() => {
    const entry = stagedRef.current.pop();
    if (entry) { try { entry.revert?.(); } catch { /* 元素可能已没了 */ } }
    setStagedCount(stagedRef.current.length);
  }, []);

  const discardStaged = useCallback(() => {
    const staged = stagedRef.current;
    stagedRef.current = [];
    for (let i = staged.length - 1; i >= 0; i--) {
      try { staged[i].revert?.(); } catch { /* */ }
    }
    setStagedCount(0);
  }, []);

  const queueOp = useCallback((summary, op, record) => {
    let doc = null;
    try { doc = iframeRef.current?.contentDocument; } catch { doc = null; }
    if (!doc) return;
    const job = (persistJobRef.current && persistJobRef.current.path === relPathRef.current)
      ? persistJobRef.current
      : { path: relPathRef.current, ops: [], records: [] };
    job.doc = doc;
    job.summary = summary;
    // 连续 nudge 合并：同元素的 style 只留最后一条
    const lastOp = job.ops[job.ops.length - 1];
    if (lastOp && lastOp.type === 'style' && op.type === 'style'
        && anchorKey(lastOp.anchor) === anchorKey(op.anchor)) {
      job.ops[job.ops.length - 1] = op;
      job.records[job.records.length - 1] = record;
    } else {
      job.ops.push(op);
      job.records.push(record);
    }
    persistJobRef.current = job;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(flushPersist, 600);
  }, [flushPersist]);

  // 全量收口：改字队列 flush + 拖拽暂存自动保存。用在运行时 DOM 即将销毁 /
  // 用户离开确认场景的所有出口（换页/刷新/重载/卸载/切出拖拽/agent 开跑）。
  const commitAllPending = useCallback(() => {
    saveStaged();
    flushPersist();
  }, [saveStaged, flushPersist]);

  // 卸载 / iframe 源变化（agent 改了文件触发重载）前抢救未落盘的改动
  useEffect(() => () => commitAllPending(), [commitAllPending]);
  useEffect(() => { commitAllPending(); }, [src, commitAllPending]);
  // 切出拖拽标签：暂存的调整自动保存（不静默丢弃）
  useEffect(() => {
    if (tab !== 'drag') saveStaged();
  }, [tab, saveStaged]);

  // React mount 区：DOM 不能动（next render 会覆盖），照 deck 的老路推 pending-* 给 agent
  const pushReactPending = useCallback((summary, record) => {
    onDomEditRef.current?.({
      path: relPathRef.current, html: null, summary,
      records: [{ ...record, reactMount: true }], persist: false,
    });
  }, []);

  // 暂存条上的操作说明：把"改了什么结构"说出来 —— 拼贴版式里 DOM 重排常常
  // 画面纹丝不动，用户不点名就永远不知道自己刚改了源码结构（SPiCa 事故的教训）
  const tagOf = (el) => {
    if (!el?.tagName) return '元素';
    const t = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' && el.className.trim()) ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `<${t}${cls}>`;
  };

  // ── 拖拽落地（组件与 deck 相同，落点不同：直接写盘）──
  const handleCommitMove = useCallback((payload, refs) => {
    if (!payload) return;
    if (payload.reactMount) {
      pushReactPending('移动元素（React 区）', {
        kind: refs.duplicate ? 'pending-duplicate' : 'pending-move',
        anchor: payload.sourceAnchor, move: payload.move, aiContext: payload.aiContext,
      });
      return;
    }
    if (refs.duplicate) {
      const clone = refs.sourceEl?.cloneNode(true);
      if (!clone || !refs.targetContainer) return;
      try { clone.removeAttribute('data-anchor'); } catch { /* */ }
      if (refs.beforeEl && refs.beforeEl.parentNode === refs.targetContainer) {
        refs.targetContainer.insertBefore(clone, refs.beforeEl);
      } else {
        refs.targetContainer.appendChild(clone);
      }
      stageOp({
        op: { type: 'duplicate', anchor: payload.sourceAnchor, container: payload.move?.container, before: payload.move?.before },
        record: { kind: 'applied-duplicate', applied: true, anchor: payload.sourceAnchor, move: payload.move, aiContext: payload.aiContext },
        revert: () => { try { clone.remove(); } catch { /* */ } },
        label: `复制 ${tagOf(refs.sourceEl)} 到 ${tagOf(refs.targetContainer)}`,
      });
      return;
    }
    let doc; try { doc = iframeRef.current?.contentDocument; } catch { doc = null; }
    const result = applyMoveToRuntime({
      iframeDoc: doc, sourceEl: refs.sourceEl,
      targetContainer: refs.targetContainer, beforeEl: refs.beforeEl,
    });
    if (result.applied === 'dom') {
      stageOp({
        op: { type: 'move', anchor: payload.sourceAnchor, container: payload.move?.container, before: payload.move?.before },
        record: { kind: 'applied-move', applied: true, anchor: payload.sourceAnchor, move: payload.move, aiContext: payload.aiContext },
        revert: result.revert,
        label: payload.move?.intent === 'child-of'
          ? `${tagOf(refs.sourceEl)} 移入 ${tagOf(refs.targetContainer)} 内部`
          : `${tagOf(refs.sourceEl)} 移到 ${tagOf(refs.targetContainer)} 里的新位置`,
      });
    } else {
      pushReactPending('移动元素（React 区）', {
        kind: 'pending-move', anchor: payload.sourceAnchor, move: payload.move, aiContext: payload.aiContext,
      });
    }
  }, [stageOp, pushReactPending]);

  const handleCommitFreePosition = useCallback((payload, refs) => {
    if (!payload) return;
    const result = applyStyleToRuntime({
      sourceEl: refs.sourceEl, parentEl: refs.parentEl,
      styleDelta: payload.styleDelta, runtimeLocks: payload.runtimeLocks,
      parentNeedsRelative: payload.parentNeedsRelative,
    });
    const record = {
      anchor: payload.sourceAnchor, styleDelta: payload.styleDelta,
      aiContext: {
        ...payload.aiContext,
        parentAnchor: payload.parentAnchor,
        parentNeedsRelative: payload.parentNeedsRelative,
      },
    };
    if (result.applied === 'dom') {
      stageOp({
        op: {
          type: 'style', anchor: payload.sourceAnchor,
          // styleDelta（用户意图）+ runtimeLocks（尺寸锁补偿）都写进文件 —— 所见即所存
          styles: { ...payload.styleDelta, ...(payload.runtimeLocks || {}) },
          parentNeedsRelative: payload.parentNeedsRelative,
        },
        record: { kind: 'applied-style', applied: true, ...record },
        revert: result.revert,
        label: `${tagOf(refs.sourceEl)} 改坐标 (${payload.styleDelta?.left ?? '?'}, ${payload.styleDelta?.top ?? '?'})`,
      });
    } else {
      pushReactPending('调整位置（React 区）', { kind: 'pending-style', ...record });
    }
  }, [stageOp, pushReactPending]);

  // 演出入口（编排.yaml 存在才亮）：探测与设置页都在 orchestrate-entry.jsx。
  // ⚠️ 必须声明在下面几个 useCallback 之前 —— 它们的依赖里有 orch.hasOrch，
  // 声明晚了就是渲染期 TDZ（Cannot access before initialization，整窗白屏）。
  const orch = useOrchestrateEntry(projectId, base);

  // ── 双击改字：跟拖拽走同一条落盘队列（干净源码重放，不再整页序列化）──
  // 演出页（orch.hasOrch）隐私纪律：发给 agent 的记录一律剥文本留结构——
  // 台词只走 chatai 通路。运行时 op 里的 anchor 保持原样（客户端应用编辑要用）。
  const handleTextEditLocal = useCallback((info) => {
    if (!info || typeof info.newText !== 'string') return;
    let doc; try { doc = iframeRef.current?.contentDocument; } catch { doc = null; }
    const el = doc?.body ? findElementByAnchor(info.anchor, doc.body) : null;
    const 隐私 = orch.hasOrch;
    queueOp(`改字「${info.newText.trim().slice(0, 12)}」`,
      { type: 'text', anchor: info.anchor, newText: info.newText },
      {
        kind: 'edit', anchor: 隐私 ? redactAnchor(info.anchor) : info.anchor,
        // 新文是用户亲手写的改动意图，照发；旧文可能是台词，隐私页剥掉
        diff: {
          oldText: 隐私 ? `〔文${(info.oldText || '').length}字〕` : info.oldText,
          newText: info.newText,
        },
        aiContext: el ? serializeForAI(el, { redactText: 隐私 }) : null,
      });
  }, [queueOp, orch.hasOrch]);

  // 拖完的补充说明 → 元素评论（带 path 进 buffer，agent 连着 applied-* 记录一起看）
  const handleDragNote = useCallback(async (anchor, text) => {
    const t = text && text.trim();
    if (!t) return;
    const el = draggedSource;
    await onAddComment?.({
      anchor: orch.hasOrch ? redactAnchor(anchor) : anchor,
      aiContext: el && el.isConnected ? serializeForAI(el, { redactText: orch.hasOrch }) : null,
      path: relPathRef.current,
      text: t,
    });
  }, [draggedSource, onAddComment, orch.hasOrch]);

  // 协作 lock（deck 同款）：agent run 期间强制退出 drag，避免双方并行改同一份文件
  useEffect(() => {
    if (isStreaming && tab === 'drag') { commitAllPending(); setTab('preview'); }
  }, [isStreaming, tab, commitAllPending]);

  // 拼贴式版面检测：绝对定位碎片多的页面，DOM 顺序与视觉位置解耦，
  // 普通拖拽（改 DOM 插入位）会产生"画面没变但结构变了"的静默事故。
  // 检出后提示条明说，且绝对定位元素拖拽自动走坐标语义（DragOverlay autoFree）。
  useEffect(() => {
    if (tab !== 'drag') return;
    try {
      const doc = iframeRef.current?.contentDocument;
      const view = doc?.defaultView;
      if (!doc?.body || !view) { setCollageWarn(false); return; }
      let abs = 0;
      const els = doc.body.querySelectorAll('*');
      const cap = Math.min(els.length, 800);
      for (let i = 0; i < cap; i++) {
        const pos = view.getComputedStyle(els[i]).position;
        if (pos === 'absolute' || pos === 'fixed') abs++;
      }
      setCollageWarn(abs >= 6);
    } catch { setCollageWarn(false); }
  }, [tab, docTick]);

  // ── 链接拦截：编辑/拖拽模式里点击不当浏览 ──
  useEffect(() => {
    if (tab !== 'edit' && tab !== 'drag') return undefined;
    const frame = iframeRef.current;
    let doc; try { doc = frame?.contentDocument; } catch { doc = null; }
    if (!doc?.body) return undefined;
    const blockNav = (e) => {
      if (e.target?.closest?.('a[href]')) e.preventDefault();
    };
    doc.addEventListener('click', blockNav, true);
    return () => { try { doc.removeEventListener('click', blockNav, true); } catch { /* doc 已换 */ } };
  }, [tab, docTick]);

  // ── 编辑桥（双击改字 + 单击选元素）——docTick 变化 = iframe 重载，重绑新 doc ──
  useEffect(() => {
    if (tab !== 'edit') return undefined;
    const frame = iframeRef.current;
    if (!frame) return undefined;
    attachEditMode(frame, {
      onTextEdit: (info) => handleTextEditLocal(info),
      onSelect: ({ anchor }) => setSelected(anchor ? { anchor } : null),
    });
    return () => {
      try { detachAll(frame); } catch { /* */ }
      setSelected(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, docTick]);

  // 评论浮卡的提交带上当前页 path（跟文本编辑同一条线程规则）
  const handleAddCommentWithPath = useCallback((ctx) => {
    onAddComment?.({ ...ctx, path: relPathRef.current });
  }, [onAddComment]);

  // 量取景框：只在窗口装不下目标宽度时整体缩一次
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setWrapSize(prev => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* 老浏览器回退 window */ }
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [tab]);

  const scale = wrapSize.width > 0 ? Math.min(1, (wrapSize.width - 32) / vp.w) : 1;

  // Code 标签：拉当前这一页的源码
  useEffect(() => {
    if (tab !== 'code') return;
    let cancelled = false;
    fetch(Assets.artifactFileUrl(projectId, relPath))
      .then(r => r.text())
      .then(t => { if (!cancelled) setSourceText(t); })
      .catch(() => { if (!cancelled) setSourceText('<!-- 读不到源码 -->'); });
    return () => { cancelled = true; };
  }, [tab, projectId, relPath, reloadKey, pageVersion]);

  const navigateTo = useCallback((page) => {
    commitAllPending();           // 换页前收口：改字 flush + 暂存拖拽自动保存（doc 即将销毁）
    setHistory(h => [...h, current]);
    setCurrent(page);
  }, [current, commitAllPending]);

  const goBack = useCallback(() => {
    commitAllPending();
    setHistory((h) => {
      if (h.length === 0) return h;
      setCurrent(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, [commitAllPending]);

  // ESC 的 handler 只挂一次，拿 ref 读最新状态，免得每次交互都重挂 listener
  const historyRef = useRef(history);
  const goBackRef = useRef(goBack);
  const selectedRef = useRef(selected);
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    historyRef.current = history; goBackRef.current = goBack;
    selectedRef.current = selected; isDraggingRef.current = isDragging;
  }, [history, goBack, selected, isDragging]);

  // ESC 优先级（deck 同构）：拖拽中让 DragOverlay 自己取消 → 有选中先清选中
  // → 站内有后退栈先后退 → 都没有才关窗
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (isDraggingRef.current) return;
      e.stopPropagation();
      if (selectedRef.current) { setSelected(null); return; }
      if (historyRef.current.length > 0) goBackRef.current();
      else onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);


  /**
   * 站内链接接管：iframe 里点 `<a href="about.html">` 默认会在 iframe 内部跳转，
   * 地址栏和「当前页」状态就跟丢了 —— 用户后退不了，Code 标签还显示着上一页的源码。
   * 这里在 load 后拦截同源站内链接，翻译成窗口状态。
   */
  const handleLoad = useCallback(() => {
    const frame = iframeRef.current;
    let doc;
    try { doc = frame?.contentDocument; } catch { return; }
    if (!doc) return;
    // 直接编辑用：把 iframe **元素**报给外层（外层自己取 contentDocument，
    // handleTextEdit 序列化整页写回 —— 跟 HtmlIframe 的回报形状一致）
    onIframeReady?.(frame);
    setIframeDoc(doc);
    setDocTick(t => t + 1);   // 桥 / overlay 全家重绑新 doc
    const dir = current.includes('/') ? current.slice(0, current.lastIndexOf('/') + 1) : '';
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(?:[a-z][a-z0-9+\-.]*:|\/\/|#)/i.test(href)) continue;   // 外链 / 锚点不管
      a.addEventListener('click', (e) => {
        if (tabRef.current === 'edit' || tabRef.current === 'drag') return;   // 编辑/拖拽点击≠浏览
        const clean = href.split('#')[0].split('?')[0];
        if (!clean) return;
        // 站内相对路径归一成"相对任务目录"
        const parts = (dir + clean).split('/');
        const stack = [];
        for (const seg of parts) {
          if (seg === '.' || seg === '') continue;
          if (seg === '..') stack.pop();
          else stack.push(seg);
        }
        const next = stack.join('/');
        if (!/\.html?$/i.test(next)) return;    // 不是站内页面就交回浏览器
        e.preventDefault();
        navigateTo(next);
      });
    }
  }, [current, navigateTo, onIframeReady]);

  const pageList = useMemo(() => (pages.length ? pages : [entry]), [pages, entry]);

  const VP_ICON = { monitor: Monitor, tablet: Tablet, smartphone: Smartphone };

  const switchTab = (id) => { setSelected(null); setNotePanelOpen(false); setTab(id); };

  const groups = useMemo(() => [
    {
      id: 'mode',
      type: 'mode',
      value: tab,
      onChange: switchTab,
      items: [
        { id: 'preview', icon: Eye, label: '预览', title: '照常浏览，站内链接可点' },
        editable && { id: 'edit', icon: Pencil, label: '编辑', title: '双击文字直接改 · 单击元素弹评论卡' },
        draggable && {
          id: 'drag', icon: Move, label: '拖拽',
          disabled: isStreaming,
          title: isStreaming ? 'agent 正在工作，拖拽暂不可用' : '拖动元素调布局',
        },
        onRegionComment && {
          id: 'region', icon: SquareDashedMousePointer, label: '圈选',
          title: '框一块地方说事 —— 框住谁、当时长什么样、你想说什么，一起交给 agent',
        },
        { id: 'code', icon: FileCode, label: '源码', title: '看这一页的 HTML' },
      ].filter(Boolean),
    },
    // 多页站点才需要页面切换；单页站点这一组是纯噪音
    pageList.length > 1 && {
      id: 'pages',
      type: 'mode',
      value: current,
      onChange: (p) => { if (p !== current) navigateTo(p); },
      items: pageList.map(p => ({ id: p, label: p.replace(/\.html?$/i, ''), title: p })),
    },
    tab !== 'code' && {
      id: 'viewport',
      type: 'mode',
      value: viewport,
      onChange: setViewport,
      items: SITE_VIEWPORTS.map(v => ({
        id: v.id, icon: VP_ICON[v.icon] || Monitor,
        title: `${v.label} · 按 ${v.w}px 真实宽度渲染`,
      })),
    },
    // 「上线」是外发动作，跟旁边那些"看/改"的工具不是一类 —— 单独一组，
    // 排在最后（2026-08-13 从窗口头部的名牌条挪进来）
    exportToolGroup({ kind: 'site', exports: artifactExports, onExport }),
    { id: 'publish', node: <SitePublishControl projectId={projectId} task={task} root={base || '.'} /> },
    {
      id: 'actions',
      items: [
        orch.item,
        history.length > 0 && { id: 'back', icon: ArrowLeft, title: '站内后退', onClick: goBack },
        { id: 'reload', icon: RotateCw, title: '刷新', onClick: () => { commitAllPending(); setReloadKey(k => k + 1); } },
        {
          id: 'open', icon: ExternalLink, title: '在新标签页打开这一页',
          onClick: () => window.open(Assets.artifactFileUrl(projectId, relPath), '_blank', 'noopener'),
        },
      ].filter(Boolean),
    },
  ].filter(Boolean),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [tab, editable, draggable, isStreaming, pageList, current, viewport, history.length,
    goBack, navigateTo, commitAllPending, projectId, relPath, onRegionComment, task,
    artifactExports, onExport, orch.item]);

  // overlay 全家共用的 iframe 引用。
  //
  // 原来这里是 `{ current: iframeRef.current }` —— 每次渲染新造一个对象，把当时的
  // iframeRef.current 拍扁进去。LiveFrame 是双缓冲：刷新时新文档先在一层
  // `position:absolute; left:0; top:0` 的 staging iframe 里加载，load 完才提升为前台。
  // 渲染时机撞上换代的话，overlay 拿到的可能是那层 staging（它贴在 wrapRef 左上角，
  // 而真正的前台 iframe 在居中的定位盒里），算出来的圈就整体偏到一边去。
  // 直接复用 iframeRef —— LiveFrame 的 bindActive 保证它永远指向前台那个。
  const overlayIframeRef = iframeRef;

  return (
    <ArtifactWindow
      kind="site"
      title={title || task}
      subtitle={current}
      onClose={onClose}
      escToClose={false}
      groups={groups}
      onToolbarGroups={onToolbarGroups}
      banner={<SiteModeBanner tab={tab} collageWarn={collageWarn} built={built} />}
    >
      <div data-site-window={task} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {orch.overlay}
      {/* 内容区 */}
      {tab !== 'code' ? (
        <div ref={wrapRef} style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          position: 'relative',   // overlay 全家的定位容器（iframe.offsetParent）
          display: 'flex', justifyContent: 'center',
          background: '#f4f2ee', padding: GAP.md,
        }}>
          {/* 外壳按缩放后的尺寸占位，iframe 按**真实设备宽度**渲染再整体缩。
              transformOrigin 必须是 top left：用 top center 的话，1440 宽的元素在
              1108 宽的盒子里绕中心缩放，左边缘会往右挪 (720-720×scale) px，整个
              取景框看着偏右一大块。 */}
          <div style={{
            width: vp.w * scale,
            height: Math.max(0, wrapSize.height - GAP.md * 2),
            flexShrink: 0,
          }}>
            {/* LiveFrame 双缓冲：agent 改本页 / 手动刷新 / 站内换页都不闪白，
                同页刷新还把滚动位置带过去。staging 层 absolute 定位挂在 wrapRef
                （最近的 positioned 祖先）上，隐藏加载不干扰布局。 */}
            <LiveFrame
              src={src}
              title={`site-${task}-${current}`}
              frameRef={iframeRef}
              onActive={handleLoad}
              style={{
                width: vp.w,
                height: scale > 0 ? Math.max(0, (wrapSize.height - GAP.md * 2) / scale) : '100%',
                border: 0,
                background: COLOR.bgWhite,
                boxShadow: tab === 'edit'
                  ? `0 0 0 2px ${COLOR.btn}, 0 2px 18px rgba(43,33,23,0.08)`
                  : tab === 'drag'
                    ? `0 0 0 2px ${EDITOR.blue}, 0 2px 18px rgba(43,33,23,0.08)`
                    : '0 2px 18px rgba(43,33,23,0.08)',
                display: 'block',
                transform: scale < 1 ? `scale(${scale})` : 'none',
                transformOrigin: 'top left',
              }}
            />
          </div>

          {/* ── 编辑态 overlay（deck 同一套组件，zoom = 取景缩放）── */}
          {tab === 'edit' && selected && (
            <EditOverlay
              key={`ring-${docTick}`}
              selectedAnchor={selected.anchor}
              iframeRef={overlayIframeRef}
              zoom={scale}
            />
          )}
          <CommentMarkers
            key={`markers-${docTick}`}
            comments={pageComments}
            iframeRef={overlayIframeRef}
            zoom={scale}
            onSelectAnchor={(anchor) => {
              if (tabRef.current !== 'edit') setTab('edit');
              setSelected({ anchor });
            }}
          />
          {tab === 'edit' && selected && iframeDoc && (
            <InspectFloatingCard
              selectedAnchor={selected.anchor}
              redactText={orch.hasOrch}
              iframeDoc={iframeDoc}
              iframeRef={overlayIframeRef}
              iframeRect={wrapSize}
              zoom={scale}
              comments={pageComments}
              onClose={() => setSelected(null)}
              onAddComment={handleAddCommentWithPath}
              onResolveComment={onResolveComment}
              onDeleteComment={onDeleteComment}
            />
          )}

          {/* ── 拖拽态 overlay（deck 同一套组件）── */}
          <GrabHandle
            key={`grab-${docTick}`}
            active={tab === 'drag' && !isDragging}
            iframeRef={overlayIframeRef}
            zoom={scale}
            pickDragSource={pickDragSource}
            isDragging={isDragging}
          />
          <DragOverlay
            key={`drag-${docTick}`}
            active={tab === 'drag'}
            iframeRef={overlayIframeRef}
            zoom={scale}
            freeMode={dragFreeMode}
            onFreeModeChange={setDragFreeMode}
            onDraggingChange={setIsDragging}
            onSelectionChange={(srcEl) => {
              setDraggedSource(srcEl);
              if (srcEl) setNotePanelOpen(true);
            }}
            onCommitMove={handleCommitMove}
            onCommitFreePosition={handleCommitFreePosition}
          />
          <PostDragNotePanel
            active={tab === 'drag' && notePanelOpen && !isDragging && !!draggedSource}
            iframeRef={overlayIframeRef}
            zoom={scale}
            sourceEl={draggedSource}
            hasPendingEditId={true}
            onSubmit={handleDragNote}
            onDismiss={() => setNotePanelOpen(false)}
          />

          <RegionSelect
            key={`region-${docTick}`}
            active={tab === 'region' && !!onRegionComment}
            iframeRef={overlayIframeRef}
            zoom={scale}
            onSubmit={(payload) => onRegionComment?.({ ...payload, path: relPath })}
            onExit={() => setTab('preview')}
          />

          {/* 拖拽暂存确认条：摆完确认才写盘（撤销 = 运行时原地回退）。
              离开拖拽标签 / 换页 / 关窗 / agent 开跑时未确认的会自动保存。 */}
          {tab === 'drag' && stagedCount > 0 && !isDragging && (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: GAP.sm,
              padding: `7px ${GAP.md}px`, borderRadius: RADIUS.pill,
              background: COLOR.text, color: COLOR.bgWhite,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
              boxShadow: '0 8px 24px rgba(93,74,44,0.33)', zIndex: 60,
            }}>
              <span style={{ opacity: 0.85 }}>
                {stagedCount} 处调整未保存
                {stagedRef.current[stagedRef.current.length - 1]?.label
                  ? ` · ${stagedRef.current[stagedRef.current.length - 1].label}`
                  : ''}
              </span>
              <button
                onClick={saveStaged}
                style={{
                  padding: `3px ${GAP.lg}px`, borderRadius: RADIUS.pill, border: 'none', cursor: 'pointer',
                  background: COLOR.bgWhite, color: COLOR.text, fontSize: FONT_SIZE.xs,
                  boxShadow: PAPER_SHADOW.far,
                  fontFamily: FONT_SANS, fontWeight: 600,
                }}
              >
                保存
              </button>
              <button
                onClick={undoStaged}
                style={{
                  padding: `3px ${GAP.base}px`, borderRadius: RADIUS.pill, cursor: 'pointer',
                  border: '1px solid rgba(255,254,246,0.4)', background: 'transparent',
                  color: COLOR.bgWhite, fontSize: FONT_SIZE.xs, fontFamily: FONT_SANS,
                }}
              >
                撤销一步
              </button>
              <button
                onClick={discardStaged}
                style={{
                  padding: `3px ${GAP.base}px`, borderRadius: RADIUS.pill, cursor: 'pointer',
                  border: 'none', background: 'transparent',
                  color: 'rgba(255,254,246,0.65)', fontSize: FONT_SIZE.xs, fontFamily: FONT_SANS,
                }}
              >
                全部放弃
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <CodeCanvas value={sourceText} readOnly onChange={() => {}} />
        </div>
      )}
      </div>
    </ArtifactWindow>
  );
}
