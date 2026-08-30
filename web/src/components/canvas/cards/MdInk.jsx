/**
 * MdInk —— 画布上的 markdown 文字（2026-08-23 黑板）
 *
 * 手写字对象多了一个 `format: 'md'` 档：agent（或用户）写在黑板上的不只是一句
 * 话，可以是要点列表、小表格、一行 KaTeX 公式、一段 mermaid 图。渲染器复用
 * 全站那份 MarkdownMath（公式规矩与单美元取舍都在 lib/markdown-math.js），
 * 这里只做两件事：
 *   1. 把排版收成"纸上的一块字"——没有卡片外观，字体/字号/墨色跟手写字同源
 *   2. ```mermaid 围栏交给懒加载的 Mermaid 组件（mermaid 包 1MB+，只有真遇到
 *      围栏才拉那片 chunk）
 *
 * mermaid 与画布原生「节点 + 线」的分工：要跟真实产物连线的用原生节点；时序图、
 * 状态机这种密而规整的才装进 mermaid 盒子。这条纪律写在 agent 的 prelude 里，
 * 不在这儿强制。
 */
import { lazy, Suspense, Children, useMemo, useState, memo } from 'react';
import remarkBreaks from 'remark-breaks';
import MarkdownMath from '../../ui/MarkdownMath.jsx';
import { COLOR, FONT_MONO, FONT_SIZE, GAP, RADIUS, alpha } from '../../../lib/theme.js';

const MermaidBlock = lazy(() => import('./MermaidBlock.jsx'));
/**
 * 单个换行 = 真换行（remark-breaks）。板上的字是 agent/用户一行一行写的，标准 markdown
 * 把单换行并成一段会把"四行要点"揉成一坨，而且服务端按行估的高度跟渲染对不上
 * （08-23 真踩：估 123px 渲出 60px，行距撑成两倍）。聊天正文不受影响（只在这层加）。
 */
const EXTRA_REMARK = [remarkBreaks];

function fenceSourceOf(preChildren, langRe) {
  const kid = Children.toArray(preChildren)[0];
  const cls = kid?.props?.className || '';
  if (!langRe.test(cls)) return null;
  const raw = kid.props.children;
  return Array.isArray(raw) ? raw.join('') : String(raw ?? '');
}
const MERMAID_RE = /language-mermaid\b/;
const CONTROLS_RE = /language-nd:controls\b/;

/**
 * 板书控件围栏（2026-08-25，站主定的形状：控件 = 一系列待发提示词）：
 *   ```nd:controls
 *   - [A] 跟上去 -> 选A：跟上去，但保持距离
 *   - [B] 留在原地
 *   - [继续] send
 *   ```
 * 每行一枚按钮：`[标签] 文案 -> 待发提示词`（无 -> 则提示词=标签+文案）；
 * 文案是 send/trigger/发送 的那枚是**触发件**。点非触发件 = 攒进 pending
 * （同标注「攒着」），点触发件 = 起轮（攒的一起被拉走）。控件是板书正文的
 * 一部分 —— 用户就地编辑就能改，agent 用写字的工具就能造，没有第二种存储。
 */
export function parseControls(src) {
  const out = [];
  let until = null;
  for (const line of String(src).split('\n')) {
    // 有效期指令行（08-25 用户提）：`until: 2026-08-26T12:00` 或 `until: +30m`
    //（相对板书创建时间；m/h/d）。过期后按钮失效，防止陈年选项还往待发队列里进。
    const u = /^\s*until:\s*(.+?)\s*$/i.exec(line);
    if (u) { until = u[1]; continue; }
    if (/^\s*supersede:\s*/i.test(line)) continue;   // 生命周期声明（lib/board-controls.js 消费）
    const m = /^\s*[-*]\s*\[([^\]]{1,24})\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, label, rest] = m;
    const trigger = /^(send|trigger|发送)\s*$/i.test(rest.trim());
    const arrow = rest.split(/\s*(?:->|→)\s*/);
    const caption = trigger ? '' : (arrow[0] || '').trim();
    const prompt = trigger ? '' : (arrow[1] || `${label} ${caption}`.trim());
    out.push({ label, caption, prompt, trigger });
  }
  return { items: out, until };
}

/** 过期判据（纯函数好钉测试）：until 是 ISO 时刻，或 +30m/+2h/+1d（相对 createdAt） */
export function controlsExpired({ until, createdAt, now = Date.now() }) {
  if (!until) return false;
  const rel = /^\+(\d+)\s*([mhd])$/i.exec(String(until).trim());
  if (rel) {
    const base = createdAt ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(base)) return false;   // 没有创建时间就不敢判死，宁可多活
    const ms = Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase()];
    return now > base + ms;
  }
  const abs = Date.parse(until);
  return Number.isFinite(abs) ? now > abs : false;
}

function ControlsBlock({ source, origin }) {
  const [picked, setPicked] = useState({});
  const { items, until } = useMemo(() => parseControls(source), [source]);
  if (!items.length) return null;
  // 失效两条路（08-25 用户提「陈年选项还能进待发队列」）：
  //   1. until 指令行到期（agent 设的钟）
  //   2. 同 tag 落了更新的选项板（origin.stale，BoardCanvas 算）—— RP 里章节推进
  //      本身就是旧选项的死期，agent 一个字不用多写
  const dead = controlsExpired({ until, createdAt: origin?.at }) || !!origin?.stale;
  const fire = (e, item, i) => {
    e.stopPropagation(); e.preventDefault();
    if (dead) return;
    // 二击取消 = 真撤回（08-25 用户报：原来第二击只是视觉取消，队列里又压一条）
    const next = item.trigger ? false : !picked[i];
    window.dispatchEvent(new CustomEvent('nd:board-control', {
      detail: {
        ...item, cancel: !item.trigger && !next,
        chalkId: origin?.id || null, path: origin?.path || origin?.id || null, title: origin?.title || null,
      },
    }));
    if (!item.trigger) setPicked(p => ({ ...p, [i]: next }));
  };
  return (
    // ⚠️ 容器不截停 pointerdown —— 截停整行会把按钮间缝隙和空白一起吃掉，选项板
    // 大半张脸是按钮行，整张卡就此拖不动（08-25 用户报）。截停只归按钮本体：
    // 按在按钮上=点击不拖拽，按在缝里=拖卡照常。
    <div data-nd-controls style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: GAP.sm, margin: `${GAP.sm}px 0`, pointerEvents: 'auto' }}>
      {items.map((it, i) => (
        <button key={i} type="button" disabled={dead}
          onPointerDown={dead ? undefined : (e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => fire(e, it, i)} title={dead ? '已过期' : it.trigger ? '发出（连同攒着的一起）' : it.prompt} style={{
            font: 'inherit', fontSize: '0.92em', lineHeight: 1.4, cursor: dead ? 'default' : 'pointer',
            padding: `3px 10px`, borderRadius: RADIUS.md,
            border: `1px ${dead ? 'dashed' : 'solid'} ${alpha(COLOR.text, dead ? 0.16 : it.trigger ? 0.45 : 0.25)}`,
            background: picked[i] ? alpha(COLOR.text, 0.12) : (!dead && it.trigger) ? alpha(COLOR.text, 0.06) : 'transparent',
            color: 'inherit', fontWeight: it.trigger ? 600 : 400, opacity: dead ? 0.45 : 1,
            ...(dead ? { pointerEvents: 'none' } : {}),
          }}>
          {picked[i] ? '✓ ' : ''}{it.label}{it.caption ? ` ${it.caption}` : ''}
        </button>
      ))}
      {dead && <span style={{ fontSize: '0.8em', opacity: 0.5 }}>（已过期）</span>}
    </div>
  );
}

function MdInk({ text, fontFamily, fontSize, color, origin }) {
  const components = useMemo(() => ({
    pre: ({ node, children, ...props }) => {
      const mermaid = fenceSourceOf(children, MERMAID_RE);
      if (mermaid !== null) {
        return (
          <Suspense fallback={<div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>图在画…</div>}>
            <MermaidBlock source={mermaid} />
          </Suspense>
        );
      }
      const controls = fenceSourceOf(children, CONTROLS_RE);
      if (controls !== null) return <ControlsBlock source={controls} origin={origin} />;
      return <pre {...props}>{children}</pre>;
    },
  }), [origin]);
  return (
    <>
      <div className="nd-mdink" style={{ fontFamily, fontSize, color, lineHeight: 1.6 }}>
        <MarkdownMath components={components} remarkPlugins={EXTRA_REMARK}>{text || ''}</MarkdownMath>
      </div>
      <style>{`
        .nd-mdink p { margin: 0 0 ${GAP.sm}px 0; }
        .nd-mdink p:last-child, .nd-mdink ul:last-child, .nd-mdink ol:last-child { margin-bottom: 0; }
        .nd-mdink h1, .nd-mdink h2, .nd-mdink h3, .nd-mdink h4 { margin: 0 0 ${GAP.sm}px 0; line-height: 1.3; font-weight: 600; }
        .nd-mdink h1 { font-size: 1.45em; } .nd-mdink h2 { font-size: 1.25em; } .nd-mdink h3 { font-size: 1.1em; }
        .nd-mdink ul, .nd-mdink ol { margin: 0 0 ${GAP.sm}px 0; padding-left: 1.4em; }
        .nd-mdink li { margin: 2px 0; }
        .nd-mdink code { background: rgba(43,33,23,0.06); padding: 1px 5px; border-radius: ${RADIUS.xs}px; font-family: ${FONT_MONO}; font-size: 0.9em; }
        .nd-mdink pre { background: rgba(43,33,23,0.05); padding: ${GAP.sm}px ${GAP.md}px; border-radius: ${RADIUS.md}px; overflow-x: auto; font-size: 0.85em; }
        .nd-mdink pre code { background: none; padding: 0; }
        .nd-mdink blockquote { margin: 0 0 ${GAP.sm}px 0; padding-left: ${GAP.md}px; border-left: 2px solid rgba(43,33,23,0.25); color: inherit; opacity: .85; }
        .nd-mdink hr { border: 0; border-top: 1px solid rgba(43,33,23,0.22); margin: ${GAP.sm}px 0; }
        .nd-mdink a { color: inherit; text-decoration: underline; }
        .nd-mdink .katex { font-size: 1.04em; }
        .nd-mdink .katex-display { margin: ${GAP.sm}px 0; overflow-x: auto; overflow-y: hidden; }
      `}</style>
    </>
  );
}

/**
 * memo（2026-08-25 性能探针实证）：200 张板书时滚轮平移掉到 17fps —— 相机一动
 * BoardCanvas 整棵重渲，每帧 200 次 remark/KaTeX 全量解析。markdown 解析是这棵
 * 子树里最贵的活，props（text/字体/origin）在纯相机移动时全部不变，memo 直接
 * 把这份钱省掉。origin 由调用方保证引用稳定（BoardObject useMemo）。
 */
export default memo(MdInk);
