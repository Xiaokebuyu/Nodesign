/**
 * JsonInk —— json 的键值树显示器（2026-08-29 占位契约刀 B，站主点名）
 *
 * 原来 json 跟 txt 走同一条路：一段等宽原文塞进 <pre>，卡面上是半行 `{"name":"…`。
 * 这里画成可折叠的键值树 —— 键、标量、折叠标记各有各的墨色。
 *
 * ## 着色的分寸
 * 纸感设计里的"语法高亮"不是编辑器那套荧光彩虹：底是纸，字是墨，层级靠**墨色深浅**
 * 分（键最深、字符串正文墨、标量用褐色强调），只有一处真正的颜色（brown）用来
 * 区分"非字符串标量"。多一种颜色，卡面就吵一分。
 *
 * ## 省略要看得见
 * 服务端 `lib/json-preview.js` 已经按深度/条数/字符串长度裁过（产出仍是合法 json，
 * 所以这里 parse 得动），被裁的地方留着 `… +42 more` 这样的人话，这里画成灰的斜体。
 * parse 不动（不是合法 json、或调用方给的是原文）就老实退回等宽原样 —— 不假装看得懂。
 */
import { useMemo, useState } from 'react';
import { COLOR, FONT_MONO, GAP } from '../../../lib/theme.js';

const ELLIPSIS = '…';
const isFolded = (v) => typeof v === 'string' && v.startsWith(ELLIPSIS);

function Scalar({ v }) {
  if (typeof v === 'string') {
    return isFolded(v)
      ? <span style={{ color: COLOR.dim, fontStyle: 'italic' }}>{v}</span>
      : <span style={{ color: COLOR.text2 }}>&quot;{v}&quot;</span>;
  }
  // 数字 / 布尔 / null：唯一一处真颜色，把"不是字符串"一眼分出来
  return <span style={{ color: COLOR.brown }}>{v === null ? 'null' : String(v)}</span>;
}

function Row({ name, value, depth, openDepth }) {
  const branch = value && typeof value === 'object';
  const [open, setOpen] = useState(depth < openDepth);
  const entries = branch ? (Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)) : [];
  const brace = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div style={{ paddingLeft: depth ? GAP.lg : 0 }}>
      <div
        data-json-row={name ?? ''}
        onPointerDown={branch ? (e) => e.stopPropagation() : undefined}
        onClick={branch ? (e) => { e.stopPropagation(); setOpen(o => !o); } : undefined}
        style={{ cursor: branch ? 'pointer' : 'default', pointerEvents: branch ? 'auto' : 'none', whiteSpace: 'pre-wrap' }}
      >
        {branch && <span style={{ color: COLOR.dim }}>{open ? '▾ ' : '▸ '}</span>}
        {name !== null && <span style={{ color: COLOR.text, fontWeight: 600 }}>{name}</span>}
        {name !== null && <span style={{ color: COLOR.dim }}>: </span>}
        {branch
          ? <span style={{ color: COLOR.dim }}>{open ? brace[0] : `${brace[0]}${entries.length}${brace[1]}`}</span>
          : <Scalar v={value} />}
      </div>
      {branch && open && (
        <>
          {entries.map(([k, v]) => (
            <Row key={k} name={String(k)} value={v} depth={depth + 1} openDepth={openDepth} />
          ))}
          <div style={{ paddingLeft: GAP.lg, color: COLOR.dim }}>{brace[1]}</div>
        </>
      )}
    </div>
  );
}

/**
 * @param {number} openDepth  默认展开几层。卡面小、展太深就成一堵字墙（2 层刚好
 *   够看出"这是个什么结构"）；显示器里有的是地方，调用方传大一点。
 */
export default function JsonInk({ text, fontSize = 11, openDepth = 2 }) {
  const data = useMemo(() => {
    try { return { ok: true, v: JSON.parse(String(text || '')) }; } catch { return { ok: false }; }
  }, [text]);

  if (!data.ok) {
    // 退回等宽原样：调用方给的不是合法 json（写了一半 / 带注释 / 根本不是 json）
    return (
      <pre style={{ margin: 0, fontFamily: FONT_MONO, fontSize, lineHeight: 1.5, color: COLOR.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {text}
      </pre>
    );
  }
  return (
    <div style={{ fontFamily: FONT_MONO, fontSize, lineHeight: 1.6, color: COLOR.text2 }}>
      <Row name={null} value={data.v} depth={0} openDepth={openDepth} />
    </div>
  );
}
