import { useState, useRef, useEffect, useCallback } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';
import HtmlIframe from './HtmlIframe.jsx';
import EditOverlay from './EditOverlay.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import SlideNavigator from './SlideNavigator.jsx';
import CanvasCandidateBar from './CanvasCandidateBar.jsx';
import A11yReviewPopover from './A11yReviewPopover.jsx';
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
}) {
  const [mode, setMode] = useState('edit');
  const [zoom, setZoom] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceText, setSourceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [iframeDoc, setIframeDoc] = useState(null);
  const [a11yOpen, setA11yOpen] = useState(false);
  const iframeWrapRef = useRef(null);
  const a11yBtnRef = useRef(null);

  const showCandidateBar = candidates && candidates.length >= 1;

  // 当 candidate 切换时，重置 dirty
  useEffect(() => {
    setDirty(false);
    setIframeDoc(null);
  }, [activeCandidateId]);

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
      background: '#fff',                          // stage 卡片底
      borderRadius: STAGE.radius,
      boxShadow: STAGE.shadow,
      border: `1px solid ${STAGE.borderWarm}`,
      overflow: 'hidden',                          // 让 toolbar 上圆角 + iframe 下圆角对齐
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
        zoom={zoom}
        onZoomChange={setZoom}
        onReload={handleReload}
        onA11yClick={() => setA11yOpen(o => !o)}
        a11yBtnRef={a11yBtnRef}
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
            zoom={zoom}
          />
          {mode === 'edit' && selectedAnchor && (
            <EditOverlay
              selectedAnchor={selectedAnchor}
              iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }}
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
    </div>
  );
}
