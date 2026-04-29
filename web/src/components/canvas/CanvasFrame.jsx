import { useState, useRef, useEffect, useCallback } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';
import HtmlIframe from './HtmlIframe.jsx';
import EditOverlay from './EditOverlay.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import { COLOR } from '../../lib/theme.js';

/**
 * CanvasFrame — Canvas 中栏总壳
 *
 * 三模式：
 *   - edit    iframe + bridge + overlay（双击 contenteditable + 选中框）
 *   - preview iframe 纯展示（无 bridge）
 *   - code    Monaco（可编辑，blur/debounce 同步回 srcDoc → iframe reload）
 *
 * 数据流：
 *   1. 初次加载 fetch htmlSrc → sourceText
 *   2. Code mode 改 sourceText → 标记 dirty
 *   3. dirty 时 iframe 用 srcDoc=sourceText（不再用 src）
 *   4. 用户按 Reload → 重新 fetch + 重置 dirty
 */
export default function CanvasFrame({
  htmlSrc, htmlContent,
  selectedAnchor, onSelectChange,
  onTextEdit,
  onIframeReady,
}) {
  const [mode, setMode] = useState('edit');
  const [zoom, setZoom] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceText, setSourceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const iframeWrapRef = useRef(null);

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

  const handleReload = () => {
    setReloadKey(k => k + 1);  // 重新 fetch 源码
    onSelectChange?.(null);    // 清掉选中
  };

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: COLOR.bg,
    }}>
      <CanvasToolbar
        mode={mode}
        onModeChange={(m) => { setMode(m); onSelectChange?.(null); }}
        zoom={zoom}
        onZoomChange={setZoom}
        onReload={handleReload}
      />

      {(mode === 'edit' || mode === 'preview') && (
        <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
          <HtmlIframe
            key={`${reloadKey}-${dirty ? 'doc' : 'src'}`}  // dirty 切换时强制 reload
            src={dirty ? undefined : htmlSrc}
            srcDoc={dirty ? sourceText : (!htmlSrc ? htmlContent : undefined)}
            mode={mode}
            onSelect={handleSelect}
            onTextEdit={handleTextEdit}
            onIframeReady={onIframeReady}
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
    </div>
  );
}
