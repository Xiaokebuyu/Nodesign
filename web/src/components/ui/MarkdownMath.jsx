/**
 * MarkdownMath —— 认公式、认 GFM 的 ReactMarkdown（2026-08-15；表格 2026-08-17 补）
 *
 * 全站凡是渲染 markdown 的地方都换成它：聊天正文、舞台卡的子代理结果、
 * .md 阅读器、方案评审卡。规矩（单美元是钱不是公式、`\( \)` 怎么换、gfm 排在
 * math 前面）在 lib/markdown-math.js，这里只是把"插件 + 归一"这两步绑成一件
 * 东西 —— 分开摆就有人只记得挂插件、忘了归一，那种半通不通最难查。
 *
 * ## 表格是这层唯一带样式的东西，为什么
 *
 * 原本这层刻意不带任何 CSS（排版按各家容器自己来）。表格破这个例，因为它要的
 * 不是皮而是**结构**：窄容器（AI 侧栏才 ~420px）里一张表必须能横向滚，而
 * `overflow-x` 加在 `<table>` 自己身上不生效 —— 得在外面套一层。套层这件事
 * CSS 做不到，只能在渲染时做，于是它天然属于这里。
 *
 * 顺手把线也画了：四个使用处各写一遍表格样式就是四份会分叉的真相，而表格长
 * 什么样跟"这是聊天还是阅读器"无关。线用发丝级、不描外框、不斑马纹 —— 跟全站
 * 「无彩交互、只用墨阶」一致。
 */
import ReactMarkdown from 'react-markdown';
import { MATH_PLUGINS, normalizeMath } from '../../lib/markdown-math.js';
import { openUrl } from '../../lib/open-url.js';
import { COLOR, GAP } from '../../lib/theme.js';

/**
 * ⚠️ `width:100%` 而不是 `max-content`：模型写的表大多是两三列短值，撑满容器
 * 更好读；单元格照常换行。外面那层滚动是给**列特别多**的表兜底的，不是常态。
 */
const COMPONENTS = {
  table: ({ node, ...props }) => (
    <div style={{ overflowX: 'auto', margin: `0 0 ${GAP.md}px 0` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'inherit' }} {...props} />
    </div>
  ),
  th: ({ node, ...props }) => (
    <th style={{
      textAlign: 'left', fontWeight: 600, color: COLOR.text,
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderBottom: `1px solid ${COLOR.borderMd}`,
      whiteSpace: 'nowrap',
    }} {...props} />
  ),
  td: ({ node, ...props }) => (
    <td style={{
      color: COLOR.text2, verticalAlign: 'top',
      padding: `${GAP.xs}px ${GAP.sm}px`,
      borderBottom: `1px solid ${COLOR.borderLt}`,
    }} {...props} />
  ),
  /**
   * 任务列表（gfm 一起带来的）。remark-gfm 会给这种 li 打上 `task-list-item`，
   * 拿它把圆点去掉 —— 勾选框已经是那个位置的记号了，再顶一个圆点是两个记号
   * 说同一件事。缩回去的那一格是 ul 的 padding，不摘的话勾选框会比普通条目
   * 缩进得更深。
   */
  li: ({ node, className, ...props }) => (
    className?.includes('task-list-item')
      ? <li className={className} style={{ listStyle: 'none', marginLeft: `-${GAP.lg}px` }} {...props} />
      : <li className={className} {...props} />
  ),
  /**
   * 链接（2026-09-10 站主报的白屏）：模型写进正文的地址 —— dev server、发布出去的站点、
   * 查到的资料 —— 点了都不能在本窗口开。桌面版那一下会把整个应用导航走，回不来只能重启
   * （为什么、以及壳那边为什么拦不住，见 lib/open-url.js 开头）。
   * 页内锚点（`#…`）留默认：那是目录跳转，不是离开。
   * ⚠️ 这里管的是全站每一处 markdown（聊天正文、板书、仓库道的 README、市场页），
   *   别在某个使用处自己再写一份 `a` —— 那就是第二份会分叉的真相。
   */
  a: ({ node, href, children, ...props }) => (
    typeof href === 'string' && href.startsWith('#')
      ? <a {...props} href={href}>{children}</a>
      : (
        <a
          {...props}
          href={href || ''}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => { e.preventDefault(); openUrl(href); }}
        >{children}</a>
      )
  ),
  // 默认那个勾选框在纸面上又蓝又大，压小并去掉指针
  input: ({ node, ...props }) => (
    props.type === 'checkbox'
      ? <input {...props} readOnly style={{ marginRight: GAP.xs, accentColor: COLOR.text, cursor: 'default' }} />
      : <input {...props} />
  ),
};

/**
 * `components`：调用方可以追加/覆盖渲染器（画布 md 节点拿它接管 mermaid 围栏）。
 * 表格/任务列表那几个仍是这层的底，调用方的同名键盖过去。
 */
export default function MarkdownMath({ children, components = null, remarkPlugins = null }) {
  const comps = components ? { ...COMPONENTS, ...components } : COMPONENTS;
  // 调用方可追加 remark 插件（画布板书加 remark-breaks：agent 写的换行就是换行）。
  // 数学那两件永远在，追加的排在后面
  const plugins = remarkPlugins ? { ...MATH_PLUGINS, remarkPlugins: [...MATH_PLUGINS.remarkPlugins, ...remarkPlugins] } : MATH_PLUGINS;
  return (
    <ReactMarkdown {...plugins} components={comps}>
      {normalizeMath(children)}
    </ReactMarkdown>
  );
}
