import { useState } from 'react';

/**
 * 远景缩略图（09-17，问题库 iss_mu0v5pa5_3ojg）—— 镜头拉远、活预览不挂时，站点 / deck 卡上
 * 显示的那张服务端截图（server/lib/artifact-thumb.js）。
 *
 * 占位（横线纸 + 形态图标）始终垫在底下，图叠在上面、加载完才显出来：
 *   - 冷缓存要排队等 chromium，可能要几秒，这段时间看到的是占位而不是一块白；
 *   - 服务端回 204（截图失败 / 暂时没有）或出错 → 撤掉图，只剩占位；
 *   - 失败按地址记：agent 改了产物、地址换了就重新请求，不必等卡片重新挂载。
 * 地址变了但没失败时不重置「已显出」，浏览器在新图到之前继续画旧图，不闪回占位。
 */
export default function FarThumb({ src, fit = 'cover', children }) {
  const [shown, setShown] = useState(false);
  const [failedSrc, setFailedSrc] = useState(null);
  const failed = failedSrc === src;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {children}
      {!failed && (
        <img
          alt=""
          data-far-thumb=""
          decoding="async"
          draggable={false}
          src={src}
          onLoad={() => setShown(true)}
          onError={() => { setFailedSrc(src); setShown(false); }}
          style={{
            position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
            objectFit: fit, objectPosition: 'top center',
            border: 0, display: 'block', background: '#fff',
            opacity: shown ? 1 : 0,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
