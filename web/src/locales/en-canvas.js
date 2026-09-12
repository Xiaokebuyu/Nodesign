/**
 * 英文词表 · 画布那一摊（2026-09-12 从 en.js 拆出来）。
 *
 * 拆的理由是行数棘轮：en.js 顶到 600 行，规矩是胖了就拆、别抬上限。
 * 这里只放画布壳上的词 —— 快捷键条、工具栏收放、新手引导五步、示例项目那张签。
 * en.js 把它摊进同一个对象，所以对 t() 和对账 lint 来说没有第二份词表。
 */
export default {
  // 画布快捷键条（09-12，lib/canvas-shortcuts.js + CanvasCorner.jsx）
  '画布快捷键': 'Canvas shortcuts',
  '全部快捷键': 'All shortcuts',
  '收起': 'Close',
  '镜头': 'View',
  '工具': 'Tools',
  '其他': 'Other',
  '空格': 'Space',
  '滚轮': 'Wheel',
  '拖动': 'drag',
  '平移画布': 'Pan the canvas',
  '上下平移，加 Shift 左右平移': 'Scroll to pan; hold Shift to pan sideways',
  '缩放': 'Zoom',
  '放大 / 缩小一档': 'Zoom in / out one step',
  '回到 100%': 'Back to 100%',
  '全部内容入镜': 'Fit everything in view',
  '指针：选中和挪动': 'Pointer: select and move',
  '写一段字': 'Write text',
  '涂鸦': 'Draw',
  '唤出 Agent': 'Call the agent',
  '删除选中的墨迹': 'Delete the selected ink',
  '退一层 / 关掉浮层': 'Go back a level / close the overlay',
  '平移': 'Pan',
  '看全貌': 'Fit all',
  '问 Agent': 'Ask the agent',
  '收起工具栏': 'Hide toolbar',
  '展开工具栏': 'Show toolbar',
  '收起 / 展开工具栏': 'Hide / show toolbar',
  '快捷键': 'Shortcuts',
  '收起快捷键提示': 'Hide the shortcut hints',
  '展开快捷键提示': 'Show the shortcut hints',
  '收起 / 展开快捷键提示': 'Hide / show the shortcut hints',
  '示例': 'Sample',
  // 新手引导的五步（09-12，lib/canvas-tour.js + CanvasTour.jsx）
  '新手引导': 'Getting started',
  '重看新手引导': 'Replay the intro',
  '下一步': 'Next',
  '开始吧': 'Start',
  '这是你的画布': 'This is your canvas',
  'Agent 做出来的东西都摆在这块画布上：一个站点、一份演示稿、一份 Word、几张图。它们是文件，不是聊天记录里的片段。':
    'Everything the agent makes sits on this canvas: a website, a deck, a Word document, a few images. They are files, not fragments buried in a chat log.',
  '双击打开它': 'Double-click to open it',
  '在窗口里看、改、导出。关掉窗口，画布上这张卡跟着更新 —— 卡就是那件东西本身。':
    'Open it in a window to read, edit and export. Close the window and the card updates, because the card is the thing itself.',
  '线就是关系': 'A line is a relationship',
  '两件东西之间连一条线，Agent 就知道它们相关。改其中一件的时候，它会顺着线找到另一件。':
    'Draw a line between two things and the agent knows they belong together: change one and it follows the line to the other.',
  '在这里跟它说话': 'Talk to it here',
  '在这里说一句，它看得到画布上的全部内容。想改哪一件，先点那一件再说话，它就知道你指的是谁。':
    'Say one line here and it can see everything on the canvas. To change one thing, select it first and then speak.',
  '工具和快捷键在这里': 'Tools and shortcuts live here',
  '底边正中是工具栏，左下角是常用快捷键。看完回首页，在那句输入框里写一句，就是你自己的第一个项目。':
    'The toolbar sits at the bottom, the common shortcuts at the lower left. When you are done, go back home and write one line to start your own first project.',
  // ── 圈选说事（RegionSelect.jsx / DocxRegionSelect.jsx，09-12）──
  '已攒 #{n}': 'Saved #{n}',
  '框住 {n} 个元素': '{n} elements inside the box',
  '等 {n} 个': 'and {n} in all',
  '这一块想说什么…（可以不写，框本身就是话）': 'What do you want to say about this area… (optional, the box already says something)',
  '记下这一块，接着圈下一块；攒够了从右下角那条浮钮一起发': 'Note this area down and box the next one; send them together from the button at the lower right',
  '攒着（已 {n}）': 'Save for later ({n})',
  '不攒，这一块现在就发给 agent 起一轮（已攒的一起带上）': 'Do not save it: send this area to the agent now and start a turn (anything already saved comes along)',
  '截图中…': 'Taking the screenshot…',
  '重画': 'Draw it again',

  // ── 浏览器窗底下的采集架（BrowserShelf.jsx，09-12）──
  '采到的东西 · {sites} 个站 · {files} 件': 'Collected · {sites} sites · {files} items',
  '{dir}（{n} 件）': '{dir} ({n} items)',
  '{dir}/ · {n} 件': '{dir}/ · {n} items',
  '没有截图': 'No screenshot',
  '原图': 'Original',
  '关闭（Esc）': 'Close (Esc)',
  '另开标签页看原图': 'Open the original in a new tab',

  // ── 物件动作条（cards/object-actions.js，09-12）──
  '已在托盘': 'Already in the tray',
  '加入上下文': 'Add to context',
  '阅读': 'Read',
  '详情': 'Details',
  '打开': 'Open',
  '编排设置': 'Orchestration settings',
  '收回成缩略图': 'Back to a thumbnail',
  '展开：按原比例整张铺在画布上': 'Expand: lay the whole thing on the canvas at its own aspect ratio',
  '导出这张卡': 'Export this card',
  '标注（发给 agent / 留在画布）': 'Annotate (send to the agent / leave it on the canvas)',
};
