import { COLOR, FONT_SANS, FONT_SIZE } from '../../lib/theme.js';
import { TOOL_SURFACE } from '../../lib/paper.js';
import { TOOL_BTN } from './ToolbarButton.jsx';

/**
 * toolbarSelect —— 工具栏里的下拉（2026-09-18 从 DocxWindow 抽出，站点换页也用它）
 *
 * 站主 09-17 定：同类产物的切换用下拉，「顺便把站点的各个页面切换也改成下拉」。原来站点的页是
 * 一排按钮，页一多就把工具栏挤爆；word 文件夹的版本切换早就是下拉，两处收成一个控件。
 *
 * 返回的是 FloatingToolbar 的 `node` 组（不是组件）：
 * ⚠️ `value` 必须给：工具栏的签名守卫（CanvasFrame.sigOf）对 `node` 组只看 id + value，
 * 只变 node 内容的话签名不动、工具栏不重渲 —— 表现是「选了另一份，选择器上的名字要等按一下
 * 翻页才变」（2026-08-19 实踩）。
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.value
 * @param {Array<{value: string, label: string}>} p.options
 * @param {(v: string) => void} p.onChange
 * @param {string} [p.title]
 */
export function toolbarSelect({ id, value, options, onChange, title }) {
  return {
    id,
    value,
    node: (
      <select
        data-toolbar-select={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={title}
        style={{
          maxWidth: 180, height: 24, padding: '0 4px',
          // 工具栏是墨面（TOOL_SURFACE），控件配色跟着它走 —— 白底 select 压在
          // 墨面药丸上就是「一条工具栏两种物料」（SitePublishControl 踩过的同一课）
          border: `1px solid ${TOOL_SURFACE.hair}`,
          borderRadius: TOOL_BTN.radius, background: 'transparent', color: TOOL_SURFACE.text,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, cursor: 'pointer',
        }}
      >
        {options.map((o) => (
          // 下拉列表是系统渲染的，不吃 select 的透明底 —— 选项要自带可读配色
          <option key={o.value} value={o.value} style={{ background: COLOR.bgWhite, color: COLOR.text }}>
            {o.label}
          </option>
        ))}
      </select>
    ),
  };
}
