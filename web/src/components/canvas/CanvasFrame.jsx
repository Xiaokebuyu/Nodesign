import { useState, useRef, useEffect, useCallback } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';
import HtmlIframe from './HtmlIframe.jsx';
import EditOverlay from './EditOverlay.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import SlideNavigator from './SlideNavigator.jsx';
import CanvasCandidateBar from './CanvasCandidateBar.jsx';
import A11yReviewPopover from './A11yReviewPopover.jsx';
import SystemPopover from './SystemPopover.jsx';
import InspectFloatingCard from './InspectFloatingCard.jsx';
import { COLOR, STAGE } from '../../lib/theme.js';

/**
 * CanvasFrame — Canvas 中栏总壳
 *
 * 三模式：
 *   - edit    iframe + bridge + overlay（双击 contenteditable + 选中框）
 *   - preview iframe 纯展示（无 bridge）
 *   - code    Monaco（可编辑，blur/debounce 同步回 srcDoc → iframe reload）
 *
 * 多候选：候选 tab 条 + + 新候选 + 删候选（同 htmlSrc，agent 真生成时各 candidate 独立）
 *
 * Slide navigator：扫描 section[data-page]，水平 tab 条 + 当前页高亮
 *
 * A11y：toolbar ✓ A11y 按钮 → popover 显示 mock review 结果
 */
// SKILL.md 约束 agent 写出来的 deck 单页 1280px 宽（固定）。
// fit = wrap.w / 1280 → iframe 整个铺满 canvas wrap（无外部 letterbox）。
// 高度方向 iframe 补偿 wrap.h/zoom，内部 deck 自己滚（页 720 高 + 余地由 deck CSS 处理）。
const DECK_WIDTH = 1280;

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
  // C2: System popover 数据透传
  project, deckSpec, projectId, sessionId, decisionsReloadKey,
  // C3: Inspect contextual + Comments 嵌入
  comments = [],
  onAddComment, onResolveComment, onDeleteComment,
  onDirectEdit, onTriggerRun,
}) {
  const [mode, setMode] = useState('edit');
  const [zoom, setZoom] = useState('fit');     // 'fit' | number
  const [wrapSize, setWrapSize] = useState({ width: 0, height: 0 });
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceText, setSourceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const iframeWrapRef = useRef(null);
  const a11yBtnRef = useRef(null);
  const systemBtnRef = useRef(null);

  // 测 iframe wrap 尺寸（W + H）— fit 取 min 让单页完整可见 letterbox
  useEffect(() => {
    const el = iframeWrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setWrapSize(prev => (prev.width === r.width && prev.height === r.height) ? prev : { width: r.width, height: r.height });
    };
    measure();
    let ro = null;
    try { ro = new ResizeObserver(measure); ro.observe(el); } catch { /* fallback to window */ }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [mode]);

  // fit = wrap.w / DECK_WIDTH：宽度铺满 canvas（无外部 letterbox）；
  // 高度方向 iframe 内部由 deck CSS 自处理（720 一页 + 多页堆叠 + scroll）
  const effectiveZoom = zoom === 'fit'
    ? (wrapSize.width > 0 ? wrapSize.width / DECK_WIDTH : 1)
    : zoom;

  const showCandidateBar = candidates && candidates.length >= 1;

  // 当 candidate 切换时，重置 dirty
  useEffect(() => {
    setDirty(false);
    setIframeDoc(null);
  }, [activeCandidateId]);

  // C3：ESC 关 InspectFloatingCard / 清选中
  // 同时挂 window + iframe.contentDocument keydown（iframe 内焦点不冒泡到 parent）
  // 避开 contenteditable 编辑态（DirectEditBridge 的 ESC = revert 文本，优先级更高）
  useEffect(() => {
    if (!selectedAnchor) return;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t?.getAttribute?.('contenteditable') === 'true') return;
      onSelectChange?.(null);
    };
    window.addEventListener('keydown', handler);
    let iframeDocRef = null;
    try {
      iframeDocRef = iframeDoc;
      iframeDocRef?.addEventListener('keydown', handler);
    } catch { /* cross-origin: skip */ }
    return () => {
      window.removeEventListener('keydown', handler);
      try { iframeDocRef?.removeEventListener('keydown', handler); } catch { /* */ }
    };
  }, [selectedAnchor, iframeDoc, onSelectChange]);

  // 加载源码（用于 Code mode 显示 + dirty 后切 srcDoc）
  useEffect(() => {
    if (!htmlSrc) {
      setSourceText(htmlContent || '');
      setDirty(false);
      return;
    }
    fetch(htmlSrc).then(r => r.text()).then((text) => {
      setSourceText(text);
      setDirty(false);
    }).catch(() => setSourceText('<!-- 无法加载源码 -->'));
  }, [htmlSrc, htmlContent, reloadKey]);

  const handleSelect = (info) => {
    onSelectChange?.(info?.anchor || null);
  };

  const handleTextEdit = (info) => {
    onTextEdit?.(info);
    console.log('[direct edit]', info);
  };

  const handleSourceChange = useCallback((newText) => {
    setSourceText(newText);
    setDirty(true);
  }, []);

  const handleIframeReady = useCallback((iframe) => {
    try {
      setIframeDoc(iframe.contentDocument);
    } catch { /* cross-origin */ }
    onIframeReady?.(iframe);
  }, [onIframeReady]);

  const handleReload = () => {
    setReloadKey(k => k + 1);  // 重新 fetch 源码
    onSelectChange?.(null);    // 清掉选中
  };

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: '#fff',
      overflow: 'hidden',
    }}>
      {/* 多候选切换条（≥1 个候选时显示）*/}
      {showCandidateBar && (
        <CanvasCandidateBar
          candidates={candidates}
          activeId={activeCandidateId}
          onSelect={onSelectCandidate}
          onAdd={onAddCandidate}
          onRemove={onRemoveCandidate}
          onRename={onRenameCandidate}
        />
      )}

      <CanvasToolbar
        mode={mode}
        onModeChange={(m) => { setMode(m); onSelectChange?.(null); }}
        zoom={effectiveZoom}
        isAutoFit={zoom === 'fit'}
        onZoomChange={(z) => setZoom(z)}
        onFitToggle={() => setZoom('fit')}
        onReload={handleReload}
        onA11yClick={() => { setSystemOpen(false); setA11yOpen(o => !o); }}
        a11yBtnRef={a11yBtnRef}
        onSystemClick={() => { setA11yOpen(false); setSystemOpen(o => !o); }}
        systemBtnRef={systemBtnRef}
        systemActive={systemOpen}
      />

      {/* Slide navigator — Edit/Preview 时扫 section[data-page]，多于 1 页才显示 */}
      {(mode === 'edit' || mode === 'preview') && (
        <SlideNavigator iframeDoc={iframeDoc} />
      )}

      {(mode === 'edit' || mode === 'preview') && (
        <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          <HtmlIframe
            key={`${activeCandidateId || 'default'}-${reloadKey}-${dirty ? 'doc' : 'src'}`}
            src={dirty ? undefined : htmlSrc}
            srcDoc={dirty ? sourceText : (!htmlSrc ? htmlContent : undefined)}
            mode={mode}
            onSelect={handleSelect}
            onTextEdit={handleTextEdit}
            onIframeReady={handleIframeReady}
            zoom={effectiveZoom}
          />
          {mode === 'edit' && selectedAnchor && (
            <EditOverlay
              selectedAnchor={selectedAnchor}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              zoom={effectiveZoom}
            />
          )}
          {mode === 'edit' && selectedAnchor && iframeDoc && (
            <InspectFloatingCard
              selectedAnchor={selectedAnchor}
              iframeDoc={iframeDoc}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
              iframeRect={wrapSize}
              zoom={effectiveZoom}
              comments={comments}
              onClose={() => onSelectChange?.(null)}
              onAddComment={onAddComment}
              onResolveComment={onResolveComment}
              onDeleteComment={onDeleteComment}
              onDirectEdit={onDirectEdit}
              onTriggerRun={onTriggerRun}
            />
          )}
        </div>
      )}

      {mode === 'code' && (
        <CodeCanvas value={sourceText} onChange={handleSourceChange} readOnly={false} />
      )}

      {a11yOpen && (
        <A11yReviewPopover
          anchorRef={a11yBtnRef}
          onClose={() => setA11yOpen(false)}
          iframeDoc={iframeDoc}
        />
      )}

      {systemOpen && (
        <SystemPopover
          anchorRef={systemBtnRef}
          onClose={() => setSystemOpen(false)}
          project={project}
          deckSpec={deckSpec}
          projectId={projectId}
          sessionId={sessionId}
          decisionsReloadKey={decisionsReloadKey}
        />
      )}
    </div>
  );
}
