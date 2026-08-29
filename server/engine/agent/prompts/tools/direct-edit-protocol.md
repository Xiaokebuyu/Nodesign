# DirectEdit 逐 kind 处理协议（get_pending_changes 首调注入）

> prelude 常驻部分只教流程骨架（get → 处理 → clear → 收尾总结）；本文是每类
> pending change 的完整处理细则，agent 第一次调 get_pending_changes 时注入。

## item 字段

- `kind`: `'edit'` / `'comment'` / `'pending-move'` / `'pending-duplicate'` / `'pending-style'` / `'pending-delete'` / `'applied-move'` / `'applied-style'` / `'applied-duplicate'`
- `anchor`: 元素稳定锚点（{ dataId, path, textHint, bbox }）
- `path`（可选）: 改动属于哪份文件（如 `about.html`）；没有 = 会话当前活跃的那份产物
- `aiContext`: 元素角色 / 页面信息 / outerHTML / computed styles / siblings；移动类还带 `targetContainerTag` + `alignmentHints`
- `diff`（edit）: `{ oldText, newText }` —— 用户改成了什么
- `text`（comment）: 评论原文
- `move`（pending-move / pending-duplicate）: `{ container: anchor, before: anchor|null }` —— 目标容器 + 插在哪个 sibling 之前（null 表示末尾）
- `styleDelta`（pending-style）: 待改的 inline style key/value
- `reactMount`（任意）: true → 改的是 `<script id="__nd-app">` 里的 JSX 子树，不是 HTML 段

## 逐 kind 处理

- **comments 是用户的修改请求** —— 按评论的指示改条目 `path` 指向的那份文件（用 Edit 工具）
  - **comment 带 `linkedToEditId`**：评论关联到 buffer 里的某条 pending-* edit（拖完浮 PostDragNotePanel 提交的 follow-up）。处理时**把该 comment 视为对那条 edit 的补充指令**——比如 pending-move 关联 comment "保持其它元素位置不变" → 走默认保护邻居的更严格档；pending-move 关联 comment "顺便把右边那块也搬过来" → 视为复合操作一起做。处理完两条都进 clearedIds
- **edits 是用户已经手动改完的** —— done deal 不动；只在回复里知会"用户改了 N 处文字 OK"
- **applied-move / applied-style / applied-duplicate 也是 done deal** —— 站点窗的拖拽落地时前端已把改动写回 `path` 指的文件。**不要再应用一遍**（重复应用 = 元素被搬两次）。用它理解用户动了什么；如果用户后续要求"顺一下"，可以把烤进 inline 的 left/top 提炼进样式表，否则不主动动
  - **`path` 在构建产物目录下**（如 `dist/…`）时：改动落在的是构建产物，下次构建会把它冲掉。在做任何会触发重新构建的事之前，先把这条改动同步回对应的源文件（按 anchor/aiContext 找源码里的对应元素）
  - 记录带 `serializedFrom: 'runtime-dom'` 时：落盘走的是整页运行时序列化兜底（干净源码上没定位到锚点），文件里可能混入该页脚本的运行时产物（注入节点/内联动画态）。用户抱怨"页面变怪了"时优先查这份文件
- **pending-move / pending-duplicate** —— 用户已经在画布拖完了视觉，但**源代码还是老样子**。
  - 用 `anchor.dataId` (data-anchor) 在那份文件里 grep 出 source 段
  - 用 `move.container.dataId` 找出 target 容器段
  - 用 `move.before.dataId` 找出"插在它前面"的 sibling（null 时插末尾）
  - 用 Edit 工具完成 DOM 树移动：剪 source 段 → 插到 target 容器内 before sibling 前
  - `pending-duplicate` 同理但保留 source 原位置
  - **`move.intent` 提示语义**：
    - `sibling-before` / `sibling-after`：本质都是"插入 sibling"，按 before 字段定位
    - `child-of`：用户拖到了 target 元素 **内部** → `move.container` 就是 target 元素自己，`move.before` 通常 null（append 到末尾）。这跟 sibling-* 的语义区别是：source 变成了 container 的**子节点**而不是兄弟节点
  - **默认保护邻居 layout**：用户拖动元素时**默认期望邻居视觉位置/尺寸尽量不动**——只挪 source 不动其它。`aiContext.neighbors` 给你**决策上下文**（邻居 anchor + 原几何），由你**自己选合适的 CSS 手段**实现这个目标。

    **aiContext.neighbors 结构**：
    - `pending-move/pending-duplicate`: `{ sourceParent: [...], targetContainer: [...] }`（同容器时两者重合）
    - `pending-style` (free position): `[...]`（source 同容器邻居 flat list）
    - 每条 neighbor：`{ anchor, tag, rect: { w, h } }`

    **手段不是被规定的**——根据具体 layout 情况选最合适的（任意组合）：
    - 把 source 改 `position: absolute` 让它脱离 flow，邻居自然不受影响（自由模式已经这样了）
    - 用 `transform: translate(X, Y)` 视觉移动 source 不动 DOM
    - 给某个邻居加 `min-width` / `min-height` / `flex-basis: Xpx` 防它扩张
    - 给容器加 `min-height` 防塌缩
    - 调整 grid-template-areas / grid-template-columns 精细控制
    - 必要时给个别邻居加 inline `width/height` 锁尺寸
    - 或者**判断本次 reflow 是合理的**（如 3 张卡片走 1 张剩 2 张平分宽度），不做额外保护

    **核心原则**：用户拖动想要的是"我把这个元素挪到那"——副作用越少越好。具体怎么实现你来判断，但要能说出为什么这样选。

    **`linkedToEditId` follow-up comment 的优先级最高**：用户填了"重排 OK" / "保持完全不动" 等明确指令，按 comment 来。没填走默认（你自己判断"尽量不动"）
- **pending-style** —— 按 `styleDelta` 改 inline style 或对应 Tailwind class（如 styleDelta.marginLeft 改 `ml-*`）。
  - **自由模式（free position）—— 最小改动原则**：
    - `styleDelta` 只含 `{position:'absolute', left, top}` —— 这是用户的真实意图（他把东西摆到了哪里）
    - **不要无脑写整个 source 的样式**。默认只改这 3 个定位字段，**保留 source 原本的 CSS class 行为**（响应式、flex/grid 分配的尺寸、margin、transform 等）
    - 看 `aiContext.parentNeedsRelative` —— true 时把 `parentAnchor` 父元素加 `position:relative`
    - **`aiContext.preDragLayout` 是关键决策上下文**——source 拖前的 computed style 快照，让你判断是否需要追加补救：

      | preDragLayout 情况 | 切 absolute 后会怎样 | 落地建议 |
      |---|---|---|
      | `flex > 0` / `flexGrow > 0` / `flexBasis: 0` | source 之前靠 flex 父分配宽度，切 absolute 后宽度变 content-auto 几何突变 | **额外写 inline width/height** = `preDragGeometry.{w,h}` 锁尺寸 |
      | `gridArea` / `gridColumn/Row` 非默认 | source 之前占 grid cell，切 absolute 后 cell 空出 | 同上锁尺寸 + 考虑给 grid 容器加 `grid-template-areas` 显式管理 |
      | `width: 'XXpx'` （source 自己有显式宽度） | 几何稳定，宽度走 CSS class 不变 | **只写 3 字段不动 width**（最小改动） |
      | `display: inline*` | inline 元素切 absolute 后变 block-like | 锁尺寸更稳 |

    - **不要破坏 source 的现有 padding / 内容 / Tailwind class**；优先在 inline style 写定位，必要时追加 width/height 锁尺寸，其它属性原样保留
  - **Constraint anchor**：`item.constraint = { x, y }` 时，用户在 ConstraintPanel 上指定了"父 resize 时跟哪边"。`styleDelta` 已经按 anchor 算好对应 CSS，agent 直接照搬即可。9 种 anchor 组合的 CSS 模式参考：
    | constraint | CSS （除 position:absolute 外）|
    |---|---|
    | `(left, top)` 默认 | `left: Xpx; top: Ypx` |
    | `(right, top)` | `right: Xpx; top: Ypx` |
    | `(left, bottom)` | `left: Xpx; bottom: Ypx` |
    | `(right, bottom)` | `right: Xpx; bottom: Ypx` |
    | `(center, top)` | `left: 50%; top: Ypx; transform: translateX(-50%)` |
    | `(left, center)` | `left: Xpx; top: 50%; transform: translateY(-50%)` |
    | `(center, center)` | `left: 50%; top: 50%; transform: translate(-50%, -50%)` |
    | `(stretch, top)` | `left: Xpx; right: Ypx; top: Zpx; width: auto` |
    | `(center, bottom)` 等组合 | 按规则推 |
    直接复用 `styleDelta` 写到 source 即可；记得**清掉 source 上跟 anchor 冲突的旧 inline style**（比如老 left 切到 right anchor 后老 left 要清，让浏览器只看新写的 right）
- **pending-delete** —— 直接删 source 段。
- **reactMount=true** 的任何 kind —— 改 `<script id="__nd-app">` 里的 JSX 而不是静态 HTML。anchor 的 dataId 仍能在 JSX 里找到（agent 写 JSX 时也该给元素加 data-anchor）。
- 用户消息本身可能是对这些 changes 的进一步说明（"你看我改的字够大吗"），结合上下文一起处理


---

## 常见 anti-pattern（prelude 2026-07-28 挪来）

agent 容易在 pending changes 流程上犯的 4 类错（每条都让用户体感"agent 没看到我的改动"）：

- **跳过 get_pending_changes 直接回应** — 看到 system 提示但忽略，丢掉用户在 canvas 上的全部 edit / comment / 拖移上下文，回应跟用户的实际操作脱节
- **处理完忘记 clear_pending_changes** — 下个 turn 仍见到同样的 changes 重复处理一遍，浪费 turn + 让用户困惑"我刚不是改过了"
- **把 edit 当 comment 处理** — edit 是用户已经手动 done deal（contenteditable blur 已 PUT 文件），把它"按指令再改回去"等于 revert 用户操作
- **pending-move 当成 comment "建议" 处理** —— pending-move 是**结构化操作意图**不是建议。用户已经"在画布上看见东西搬到新位置了"（前端运行时改了 DOM 但没碰源码），你必须按 `anchor.dataId` 真的把 source 段从那份文件里剪走插到 target 容器去；不照做下次 iframe reload 视觉跳回，用户体感"我拖了等于没拖"

---
