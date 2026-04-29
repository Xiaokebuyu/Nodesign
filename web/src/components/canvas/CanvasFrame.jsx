import { useState, useRef, useEffect } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';
import HtmlIframe from './HtmlIframe.jsx';
import EditOverlay from './EditOverlay.jsx';
import CodeCanvas from './CodeCanvas.jsx';
import { COLOR } from '../../lib/theme.js';

/**
 * CanvasFrame — Canvas 中栏总壳
 *
 * 三模式：edit（iframe + bridge + overlay）/ preview（iframe 纯展示）/ code（Monaco）。
 *
 * P1：mode / zoom / selectedAnchor 都本地 state；P2 后部分上提到 Project 级 reducer。
 */
export default function CanvasFrame({ htmlSrc, htmlContent, onTextEdit, onSelect }) {
  const [mode, setMode] = useState('edit');
  const [zoom, setZoom] = useState(1);
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeWrapRef = useRef(null);

  // 加载 mock 文件文本（用于 Code mode）
  const [sourceText, setSourceText] = useState('');
  useEffect(() => {
    if (!htmlSrc) {
      setSourceText(htmlContent || '');
      return;
    }
    fetch(htmlSrc).then(r => r.text()).then(setSourceText).catch(() => setSourceText('// 无法加载源码'));
  }, [htmlSrc, htmlContent, reloadKey]);

  const handleSelect = (info) => {
    setSelectedAnchor(info?.anchor || null);
    onSelect?.(info);
  };

  const handleTextEdit = (info) => {
    onTextEdit?.(info);
    // P1 直接 console.log 给开发者看
    console.log('[direct edit]', info);
  };

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: COLOR.bg,
    }}>
      <CanvasToolbar
        mode={mode}
        onModeChange={(m) => { setMode(m); setSelectedAnchor(null); }}
        zoom={zoom}
        onZoomChange={setZoom}
        onReload={() => setReloadKey(k => k + 1)}
      />

      {/* Edit / Preview 共用同 iframe，只是 mode 切 bridge */}
      {(mode === 'edit' || mode === 'preview') && (
        <div ref={iframeWrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <HtmlIframe
            key={reloadKey}
            src={htmlSrc}
            srcDoc={!htmlSrc ? htmlContent : undefined}
            mode={mode}
            onSelect={handleSelect}
            onTextEdit={handleTextEdit}
            zoom={zoom}
          />
          {mode === 'edit' && selectedAnchor && (
            <EditOverlay selectedAnchor={selectedAnchor} iframeRef={{ current: iframeWrapRef.current?.querySelector('iframe') }} />
          )}
        </div>
      )}

      {mode === 'code' && (
        <CodeCanvas value={sourceText} onChange={() => { /* P3: PATCH source */ }} />
      )}
    </div>
  );
}
