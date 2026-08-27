/**
 * 物件动作表兑换（2026-08-27 操作条重制，从 BoardObject 抽出）。
 *
 * hover 工具条（BoardObject）和点选操作条（ObjectActionBar）共用这一份 ——
 * 同一件东西两个实例是这个仓库最贵的一课。按钮清单由形态表给
 * （board-kinds.js 的 actions，顺序即渲染顺序），这里只把动作 id 兑换成
 * 图标和回调。
 *
 * 标注和导出**不在形态表里**：表的意义在于记录差异，而这两个动作对每一种
 * 东西都成立、写法一字不差 —— 抄进十条形态就是把同一句话说十遍，下次加
 * 形态还得记着补第十一遍。标注固定收尾（那是"跟 agent 说话"的位置），
 * 导出排它前面。
 */
import {
  Plus, BookOpen, ExternalLink, SlidersHorizontal, Trash2, Download, MessageSquarePlus,
} from 'lucide-react';
import { actionsOf } from '../../../lib/board-kinds.js';

/**
 * @param {object} o 画布物件
 * @param {object} h 回调集（缺谁跳谁）：added, onAdd, onOpenViewer, onOpenFile,
 *   onDetail, onOrchestrate, onDeleteNote, onExport, onAnnotate
 * @returns {Array<{icon, title, fn, anchored?}>}
 */
export function buildObjectActions(o, h = {}) {
  const DEFS = {
    add: { icon: Plus, title: h.added ? '已在托盘' : '加入上下文', fn: h.onAdd },
    read: { icon: BookOpen, title: '阅读', fn: h.onOpenViewer },
    detail: { icon: ExternalLink, title: '详情', fn: h.onDetail },
    // .md 两条路都给：「阅读」是渲染过的（双击也走这条），「打开」是原始文件
    open: { icon: ExternalLink, title: '打开', fn: h.onOpenFile },
    // 编排.yaml：图形设置页（双击也走这条），「打开」仍留给原始文件
    orchestrate: { icon: SlidersHorizontal, title: '编排设置', fn: h.onOrchestrate },
    delete: { icon: Trash2, title: '删除', fn: h.onDeleteNote },
  };
  return [
    ...actionsOf(o).map((id) => DEFS[id]).filter(Boolean),
    ...(h.onExport ? [{ icon: Download, title: '导出这张卡', fn: h.onExport }] : []),
    ...(h.onAnnotate
      ? [{ icon: MessageSquarePlus, title: '标注（发给 agent / 留在画布）', fn: h.onAnnotate, anchored: true }]
      : []),
  ];
}
