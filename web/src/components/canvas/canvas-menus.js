/**
 * canvas-menus —— 右键菜单的四张菜单表（2026-08-14 可维护性行动 B3，从
 * BoardCanvas.openContextMenu 原样抽出）。
 *
 * 这里只管**菜单里有什么**；右键落点的命中解析（DOM 属性、窗判定、几何兜底）
 * 留在 BoardCanvas —— 那部分靠 refs 吃画布现实，这部分是纯数据。改菜单项
 * 来这个文件，别再进怪物组件。
 */
import {
  FolderOpen, FolderPlus, FolderInput, Plus, PencilLine, Trash2,
  MessageSquarePlus, Link2, StickyNote, Group, Check, Eraser, Download,
} from 'lucide-react';
import { canAddToContext, isFileBacked } from '../../lib/board-kinds.js';

/**
 * @param {object} ctx 命中解析的结果
 *   { mx, my, at, obj, zoneId, winIn, batch, sel, objs, zones }
 * @param {object} act 动作句柄（BoardCanvas 传入）
 */
/** 黑板组标签：原生物件抬在顶层（board-objects.js），产物卡住 pos 上（pos = layout 条目）*/
const groupTagOf = (o) => o?.tag || o?.pos?.tag || null;

export function buildBoardMenu(ctx, act) {
  const { mx, my, at, obj, zoneId, winIn, batch, sel, objs, zones } = ctx;

  /**
   * 批量菜单：右键落在**选中集里**且选了不止一件。
   * 判据是"点的这一件在选中集里"，不是"有选中集"（跟操作系统桌面一致）。
   */
  if (batch) {
    const addable = objs.filter(canAddToContext);
    const movable = [...objs.filter(isFileBacked).map(o => o.id), ...zones];
    return [
      {
        id: 'move', icon: FolderInput, label: `移动到…`, hint: `${movable.length} 件`,
        disabled: !movable.length,
        onClick: () => act.setMoveTo({ x: mx, y: my, ids: movable, current: '', exclude: zones }),
      },
      {
        id: 'add', icon: Plus, label: '加入上下文', hint: `${addable.length} 件`,
        disabled: !addable.length,
        onClick: () => addable.forEach(act.handleAdd),
      },
      {
        id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理',
        onClick: () => act.setAnnotate({
          x: mx, y: my,
          target: { kind: 'multi', id: sel[0], title: `${sel.length} 件`, typeLabel: '选中' },
          targets: [
            ...objs.map(act.annotTargetOf),
            ...zones.map(z => ({ kind: 'folder', id: z, path: z, title: z.split('/').pop() || z, typeLabel: '文件夹' })),
          ],
        }),
      },
      { divider: true },
      {
        id: 'del', icon: Trash2, label: '删除', danger: true, hint: `${sel.length} 件`,
        // 批量删除加一道确认：单件删错了还能从 git 里捞，一次删十件是另一
        // 个量级的事故，而这个菜单项就挨着"移动到…"
        onClick: () => {
          if (!window.confirm(`删掉这 ${sel.length} 件？`)) return;
          objs.forEach(o => act.handleDeleteNote(o));
          zones.forEach(z => act.handleDeleteFolder(z, z.split('/').pop()));
        },
      },
    ];
  }

  if (obj) {
    return [
      { id: 'open', icon: FolderOpen, label: '打开', onClick: () => act.openObject(obj) },
      // 改名只给磁盘上真有位置的（涂鸦 / 手写文字没有文件可改）
      ...(isFileBacked(obj) ? [{ id: 'rename', icon: PencilLine, label: '重命名', onClick: () => act.setRenamingId(obj.id) }] : []),
      ...(canAddToContext(obj) ? [{ id: 'add', icon: Plus, label: '加入上下文', onClick: () => act.handleAdd(obj) }] : []),
      // 搬家的**唯一显式入口**（拖到空地搬出去那条 2026-08-13 撤了）。
      // 画布原生物件没有磁盘位置，不给。
      ...(isFileBacked(obj) ? [{
        id: 'move', icon: FolderInput, label: '移动到…',
        // 窗里的东西住在窗那一层（`zoneId` 只有桌面上的卡才带）
        onClick: () => act.setMoveTo({ x: mx, y: my, ids: [obj.id], current: obj.zoneId ?? (winIn || '') }),
      }] : []),
      // 连线：从这件东西拉一条关系线到画布上另一件。全类型都给 ——
      // 手写字/涂鸦也能当端点（标注全局化）。
      { id: 'linkto', icon: Link2, label: '连线到…', onClick: () => act.setLinkFrom({ id: obj.id, title: act.titleOfId(obj.id) }) },
      // 黑板组（2026-08-23）：带 #tag 的东西（agent 一张草图 = 一组）可以整组选 / 落定 / 擦
      ...(groupTagOf(obj) ? [
        { divider: true },
        { id: 'grp-sel', icon: Group, label: `选中整组 #${groupTagOf(obj)}`, onClick: () => act.selectGroup(groupTagOf(obj)) },
        ...((obj.staging || obj.pos?.staging) ? [{ id: 'grp-commit', icon: Check, label: '落定这组草稿', hint: '半透明 → 实', onClick: () => act.commitGroup(groupTagOf(obj)) }] : []),
        { id: 'grp-export', icon: Download, label: '导出这组（SVG）', onClick: () => act.exportGraph?.('svg', groupTagOf(obj)) },
        { id: 'grp-export-zip', icon: Download, label: '导出这组 + 产物（zip）', onClick: () => act.exportGraph?.('zip', groupTagOf(obj)) },
        { id: 'grp-erase', icon: Eraser, label: `擦掉整组 #${groupTagOf(obj)}`, danger: true, hint: '黑板擦', onClick: () => act.eraseGroup(groupTagOf(obj)) },
      ] : []),
      // E3：就地标注 —— 在东西上写完一句，按发送 agent 立刻来。
      { id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理', onClick: () => act.setAnnotate({
        x: mx, y: my,
        target: act.annotTargetOf(obj),
      }) },
      { divider: true },
      // 删除只给**真有东西可删**的：磁盘上有文件（note/图/文件…）或者 board.json
      // 里有一条记录（涂鸦/手写字）。浏览器卡两样都不是 —— 它的真相在服务端进程里，
      // 给了这颗按钮只会走进 `Assets.removeNote(pid, undefined)` 静默 404
      // （native 物件当年就是这么"删了没反应"的）。
      ...(isFileBacked(obj) || obj.native
        ? [{ id: 'del', icon: Trash2, label: '删除', danger: true, onClick: () => act.handleDeleteNote(obj) }]
        : []),
    ];
  }

  if (zoneId) {
    return [
      // ⚠️ 这里曾写 `focusZoneAction`（换层时代的函数，08-13 统一窗改造把定义
      // 删了、调用漏了）—— 悬空引用潜伏族第三案：右键文件夹点「进入」白屏炸
      // 了一整天没人发现（都在双击）。B3 抽菜单时因为动作句柄提前求值当场炸出。
      { id: 'enter', icon: FolderOpen, label: '进入', onClick: () => act.openFolder(zoneId) },
      { id: 'new', icon: FolderPlus, label: '在里面新建文件夹', onClick: () => act.createFolderAt(zoneId, null) },
      { id: 'ask', icon: MessageSquarePlus, label: '标注给 agent', hint: '发送即处理', onClick: () => act.setAnnotate({
        x: mx, y: my,
        target: { kind: 'folder', id: zoneId, path: zoneId, title: zoneId.split('/').pop() || zoneId, typeLabel: '文件夹' },
      }) },
      { id: 'linkto', icon: Link2, label: '连线到…', onClick: () => act.setLinkFrom({ id: zoneId, title: act.titleOfId(zoneId) }) },
      { id: 'rename', icon: PencilLine, label: '重命名', onClick: () => act.setRenamingId(zoneId) },
      // 文件夹在这之前**根本没有搬家入口**：卡片能拖，但拖只改画布坐标
      {
        id: 'move', icon: FolderInput, label: '移动到…',
        onClick: () => act.setMoveTo({
          x: mx, y: my, ids: [zoneId],
          current: zoneId.includes('/') ? zoneId.slice(0, zoneId.lastIndexOf('/')) : '',
          exclude: [zoneId],     // 自己和自己的子孙不能当目标
        }),
      },
      { divider: true },
      { id: 'del', icon: Trash2, label: '删除文件夹', danger: true, onClick: () => act.handleDeleteFolder(zoneId, zoneId.split('/').pop()) },
    ];
  }

  if (winIn !== null) {
    // 文件夹窗里的空白：能做的只有"在这一层新建"。写字/涂鸦都是桌面那一层的
    // 动作（窗里是算出来的网格，没有"摆在哪儿"这回事）
    return [
      { id: 'new', icon: FolderPlus, label: '新建文件夹', onClick: () => act.createFolderAt(winIn, null) },
    ];
  }

  return [
    // 桌面上右键就建在桌面上。文件夹**里面**新建走窗里那个按钮 ——
    // 桌面这一层永远是根，这里不需要再问"我在哪一层"
    { id: 'new', icon: FolderPlus, label: '新建文件夹', onClick: () => act.createFolderAt('', at) },
    { id: 'note', icon: StickyNote, label: '新建便利贴', hint: 'agent 能看到', onClick: () => act.createNoteAt(at) },
    { divider: true },
    { id: 'ask', icon: MessageSquarePlus, label: '让 agent 在这儿做…', onClick: () => act.onAskAgent?.({ at }) },
    { divider: true },
    // 连接图导出（2026-08-23 黑板）：节点 + 线 + 位置，真相是 board.json，这里只派生
    { id: 'exp-svg', icon: Download, label: '导出连接图（SVG）', onClick: () => act.exportGraph?.('svg') },
    { id: 'exp-mmd', icon: Download, label: '导出连接图（Mermaid）', onClick: () => act.exportGraph?.('mermaid') },
    { id: 'exp-json', icon: Download, label: '导出连接图（JSON）', onClick: () => act.exportGraph?.('json') },
    { id: 'exp-zip', icon: Download, label: '导出连接图 + 产物（zip）', hint: '可离线打开', onClick: () => act.exportGraph?.('zip') },
  ];
}
