/**
 * 画布快捷键表（2026-09-12，站主：「找个地方常态显示画布的各种键盘快捷操作」）。
 *
 * 左下角小地图旁边那一条（CanvasCorner）和点开的完整清单都从这张表画。
 *
 * ⛔ 这张表是**第三份拷贝**：真正的监听在 useBoardCamera.js（镜头）和 BoardCanvas.jsx
 * （工具 / 其他），表只是给人看的说明。提示写了一个不存在的功能比不写更坏（BoardCanvas
 * 换工具那段就有过前科：工具栏写着「（V）」，全仓没人监听），所以配了判据
 * canvas-shortcuts.lint.test.js：每条的 probe 必须在监听源码里原样找得到，监听里的键
 * 也必须都在表里。改监听的人会被它叫回来改这张表。
 *
 * keys：一组或几组按法（几组之间是「或」）。组里的记号：
 *   'Mod' = Ctrl（Mac 上印 ⌘）、'Space' = 空格、'wheel' = 滚轮、'drag' = 拖动，其余照字面印。
 * pin：常驻在左下角那条上的短名（只放最常用的几个，其余点「全部快捷键」看）。
 */

export const SHORTCUT_GROUPS = [
  { id: 'camera', label: '镜头' },
  { id: 'tool', label: '工具' },
  { id: 'other', label: '其他' },
];

export const SHORTCUTS = [
  { id: 'pan', group: 'camera', keys: [['Space', 'drag']], label: '平移画布', pin: '平移',
    probe: { src: 'camera', has: ["e.code !== 'Space'"] } },
  { id: 'wheel', group: 'camera', keys: [['wheel'], ['Shift', 'wheel']], label: '上下平移，加 Shift 左右平移',
    probe: { src: 'camera', has: ['e.shiftKey ? e.deltaY : e.deltaX'] } },
  { id: 'zoom', group: 'camera', keys: [['Mod', 'wheel']], label: '缩放', pin: '缩放',
    probe: { src: 'camera', has: ['Math.exp(-e.deltaY * ZOOM_SPEED)'] } },
  { id: 'zoomStep', group: 'camera', keys: [['Mod', '='], ['Mod', '-']], label: '放大 / 缩小一档',
    probe: { src: 'camera', has: ["e.code === 'Equal' || e.code === 'NumpadAdd'", "e.code === 'Minus' || e.code === 'NumpadSubtract'"] } },
  { id: 'zoom100', group: 'camera', keys: [['Mod', '0']], label: '回到 100%',
    probe: { src: 'camera', has: ["e.code === 'Digit0'"] } },
  { id: 'fit', group: 'camera', keys: [['Shift', '1']], label: '全部内容入镜', pin: '看全貌',
    probe: { src: 'camera', has: ["e.code === 'Digit1'"] } },

  { id: 'select', group: 'tool', keys: [['V']], label: '指针：选中和挪动',
    probe: { src: 'board', has: ["v: 'select'"] } },
  { id: 'text', group: 'tool', keys: [['T']], label: '写一段字',
    probe: { src: 'board', has: ["t: 'text'"] } },
  { id: 'draw', group: 'tool', keys: [['P']], label: '涂鸦',
    probe: { src: 'board', has: ["p: 'draw'"] } },

  { id: 'ask', group: 'other', keys: [['/']], label: '唤出 Agent', pin: '问 Agent',
    probe: { src: 'board', has: ["e.key === '/'"] } },
  { id: 'delete', group: 'other', keys: [['Delete']], label: '删除选中的墨迹',
    probe: { src: 'board', has: ["e.key !== 'Delete' && e.key !== 'Backspace'"] } },
  { id: 'esc', group: 'other', keys: [['Esc']], label: '退一层 / 关掉浮层',
    probe: { src: 'board', has: ["e.key !== 'Escape'"] } },
];

/** 这两个记号是动作不是键：印成字，不画键帽 */
export const ACTION_TOKENS = new Set(['wheel', 'drag']);

/** Mac 上修饰键印 ⌘（桌面版只有 Windows，网页版的 Mac 用户看得到） */
export function isMacPlatform() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
}
