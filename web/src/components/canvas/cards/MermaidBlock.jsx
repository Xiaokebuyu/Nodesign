/**
 * MermaidBlock —— 画布 md 节点里的 mermaid 围栏（懒加载，2026-08-23 黑板）
 *
 * mermaid 的 render 是异步的、要量 DOM，所以放 effect 里跑；失败就把错误句子
 * 和源码一起摆出来，不留空白（空白块在画布上就是"看不见也删不掉的幽灵"那类）。
 * 主题走纸面：底色透明、字体跟容器、线用墨阶，不让它把默认的紫蓝调带进来。
 */
import { useEffect, useRef, useState } from 'react';
import { CANVAS } from '../../../lib/theme.js';
import mermaid from 'mermaid';
import { PAPER } from '../../../lib/paper.js';
import { FONT_MONO, FONT_SIZE, COLOR } from '../../../lib/theme.js';

let inited = false;
function ensureInit() {
  if (inited) return;
  inited = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'inherit',
    themeVariables: {
      background: 'transparent',
      primaryColor: CANVAS.note,
      primaryTextColor: PAPER.ink,
      primaryBorderColor: PAPER.ink2,
      lineColor: PAPER.ink2,
      secondaryColor: PAPER.wall,
      tertiaryColor: COLOR.bgModal,
      fontSize: '14px',
    },
  });
}

let seq = 0;

export default function MermaidBlock({ source }) {
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    ensureInit();
    const id = `nd-mm-${(seq++ % 100000)}`;
    (async () => {
      try {
        const { svg } = await mermaid.render(id, String(source || '').trim());
        if (alive && ref.current) { ref.current.innerHTML = svg; setErr(null); }
      } catch (e) {
        if (alive) setErr(String(e?.message || e).split('\n')[0].slice(0, 160));
        // mermaid 失败会留一个错误占位节点在 body 上，扫掉
        try { document.getElementById(`d${id}`)?.remove(); } catch { /* noop */ }
      }
    })();
    return () => { alive = false; };
  }, [source]);
  return (
    <div style={{ margin: '4px 0' }}>
      <div ref={ref} style={{ maxWidth: '100%', overflowX: 'auto' }} />
      {err && (
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.error || PAPER.red }}>
          mermaid 画不出来：{err}
          <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: FONT_SIZE.xs, color: PAPER.ink2 }}>{source}</pre>
        </div>
      )}
    </div>
  );
}
