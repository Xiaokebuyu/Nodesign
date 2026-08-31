/**
 * board-filter.jsx — 桌面按类别过滤（2026-08-18）
 *
 * ## 为什么需要它
 *
 * 用户拍板要往桌面上加更多**类别**的卡（工具卡是第一张：既装着工具采集的内容，
 * 本身又能点进去交互）。而"加卡片"和"桌面别变吵"这两件事，在这之前一直是拿
 * **禁令**解决的 —— 参考素材"走抽屉不走画布"。他给的解法比禁令好：
 * **分类 + 过滤**，噪音变成可选而不是不许存在。
 *
 * 两条轴（判据在 `lib/board-kinds.js`，那里也有为什么是两条而不是一条）：
 * 内容轴 `category`（这是什么）× 来源轴 `sourceOf`（谁弄出来的），**取交集**。
 *
 * ## 三条设计约束
 *
 * 1. **默认全都看得见。** 空集 = 不过滤，不是"全都不要"。一个默认藏东西的
 *    过滤器会让人以为文件丢了。
 * 2. **过滤是"看"，不是"删"。** 只影响渲染，不动 board.json、不动磁盘。
 *    被藏起来的卡照旧占着它的坐标，取消过滤就在原位。
 * 3. **状态存本地，不进 board.json。** 它是这个人此刻想看什么，不是这块画布的
 *    属性 —— 存服务端等于把"我暂时不想看素材"变成项目设置。
 *    ⚠️ key 带 `nd.` 前缀 + 项目 id：同源下所有项目共用一个 localStorage。
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Filter } from 'lucide-react';
import { CATEGORIES, SOURCES } from '../../lib/board-filter-axes.js';
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';

const keyOf = (projectId) => `nd.boardFilter.${projectId}`;

function load(projectId) {
  try {
    const raw = window.localStorage.getItem(keyOf(projectId));
    const v = raw ? JSON.parse(raw) : null;
    return {
      categories: Array.isArray(v?.categories) ? v.categories : [],
      sources: Array.isArray(v?.sources) ? v.sources : [],
    };
  } catch { return { categories: [], sources: [] }; }
}

/** 一排可点的词。选中 = 实心 —— 这排东西每一颗都是"只看这一档" */
function Chips({ axis, options, picked, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xs, flexWrap: 'wrap' }}>
      <span style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
        width: 28, flexShrink: 0,
      }}>{axis}</span>
      {options.map((o) => {
        const on = picked.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            data-board-action
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggle(o.id)}
            style={{
              padding: `2px ${GAP.sm}px`, cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
              color: on ? COLOR.bgWhite : COLOR.text2,
              background: on ? COLOR.text : 'transparent',
              border: `1px solid ${on ? COLOR.text : COLOR.border}`,
              borderRadius: 2,
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

/**
 * @param {string} projectId
 * @returns {{filter: {categories: string[], sources: string[]}, group: object}}
 *   `group` 直接塞进画布工具栏的分组数组（`{id, node}` 形态，工具栏支持自定义节点）
 */
export function useBoardFilter(projectId) {
  const [filter, setFilter] = useState(() => load(projectId));
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // 换项目时读那个项目的那一份（不然带着上一个项目的过滤器进来，
  // 症状是"这个项目的东西怎么少了"）
  useEffect(() => { setFilter(load(projectId)); setOpen(false); }, [projectId]);

  const put = useCallback((next) => {
    setFilter(next);
    try { window.localStorage.setItem(keyOf(projectId), JSON.stringify(next)); } catch { /* 隐私模式 */ }
  }, [projectId]);

  const toggle = useCallback((axis, id) => {
    const cur = axis === 'categories' ? filter.categories : filter.sources;
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    put({ ...filter, [axis]: next });
  }, [filter, put]);

  const active = filter.categories.length + filter.sources.length > 0;

  // 点外面关掉（浮层的老规矩；不加的话它会一直挡着画布）
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const group = useMemo(() => ({
    id: 'filter',
    // ⚠️ **`value` 不是可选的**：工具栏那层按签名判要不要重渲染，而签名对带
    // `node` 的分组只记一个字符串 `'node'`（CanvasFrame 的 `sigOf`）——
    // 也就是说自定义节点的**内容变化传不出去**，浮层永远打不开。
    // 签名里唯一会跟着变的就是 `value`，所以把状态编进它。
    value: `${open ? 'o' : 'c'}|${filter.categories.join(',')}|${filter.sources.join(',')}`,
    node: (
      <div ref={boxRef} style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          data-board-action
          title={active ? '只显示部分类别（点开可改 / 恢复全部）' : '按类别只看一部分'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setOpen(v => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
            padding: `0 ${GAP.sm}px`, height: 24, background: 'transparent',
            border: 0, color: active ? COLOR.text : COLOR.sub,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
          }}
        >
          <Filter size={13} />
          {active ? `${filter.categories.length + filter.sources.length}` : null}
        </button>
        {open && (
          <div style={{
            position: 'absolute', bottom: 30, left: 0, zIndex: 600,
            display: 'flex', flexDirection: 'column', gap: GAP.xs,
            padding: GAP.sm, minWidth: 300,
            background: COLOR.bgCard, border: `1px solid ${COLOR.border}`,
            borderRadius: 3, boxShadow: '0 4px 16px rgba(43,39,35,.18)',
          }}>
            <Chips axis="内容" options={CATEGORIES} picked={filter.categories}
              onToggle={(id) => toggle('categories', id)} />
            <Chips axis="来源" options={SOURCES} picked={filter.sources}
              onToggle={(id) => toggle('sources', id)} />
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs, color: COLOR.sub, paddingTop: 2,
            }}>
              <span>两条轴取交集 · 一个都不选 = 全都显示</span>
              {active && (
                <button
                  type="button"
                  data-board-action
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => put({ categories: [], sources: [] })}
                  style={{
                    cursor: 'pointer', background: 'transparent', border: 0,
                    color: COLOR.text2, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xxs,
                    textDecoration: 'underline',
                  }}
                >恢复全部</button>
              )}
            </div>
          </div>
        )}
      </div>
    ),
  }), [active, filter, open, put, toggle]);

  return { filter, group };
}
