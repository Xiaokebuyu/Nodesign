import { useEffect, useRef } from 'react';
import { attachEditMode, detachAll } from './DirectEditBridge.js';
import { COLOR } from '../../lib/theme.js';

/**
 * HtmlIframe — 加载 HTML 产物的核心 iframe
 *
 * 模式行为：
 *   - 'edit'    iframe 加载完成后挂 dblclick / click bridge（contenteditable + select）
 *   - 'preview' 加载但不挂 bridge，纯展示
 *   - 隐藏 mode（父组件用 display:none 切到 Code）
 *
 * P1：sandbox 暂时给 allow-scripts allow-same-origin（开发同源）；部署不同 origin 时
 *     退化成 postMessage 通信，bridge 文件预埋 listener。
 */
export default function HtmlIframe({ src, srcDoc, mode = 'edit', onSelect, onTextEdit, zoom = 1 }) {
  const ref = useRef(null);
  const loadedRef = useRef(false);

  // mode 切换 → 重新挂/卸 bridge（不需要 reload）
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe || !loadedRef.current) return;
    detachAll(iframe);
    if (mode === 'edit') {
      attachEditMode(iframe, { onSelect, onTextEdit });
    }
    return () => detachAll(iframe);
  }, [mode, onSelect, onTextEdit]);

  // src / srcDoc 切换 → reload。loaded 后再 attach bridge
  const handleLoad = () => {
    loadedRef.current = true;
    const iframe = ref.current;
    if (!iframe) return;
    if (mode === 'edit') {
      attachEditMode(iframe, { onSelect, onTextEdit });
    }
  };

  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      overflow: 'auto',
      background: COLOR.bgCard,
      display: 'flex',
      justifyContent: 'center',
      padding: 0,
    }}>
      <iframe
        ref={ref}
        src={src}
        srcDoc={srcDoc}
        onLoad={handleLoad}
        sandbox="allow-scripts allow-same-origin"
        style={{
          width: zoom === 1 ? '100%' : `${100 / zoom}%`,
          height: '100%',
          minHeight: 600,
          border: 0,
          background: '#fff',
          transform: zoom === 1 ? 'none' : `scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}
