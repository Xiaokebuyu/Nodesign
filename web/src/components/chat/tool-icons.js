/**
 * chat/tool-icons.js — 时间线上每个工具的图标（2026-08-21 从 Message.jsx 拆出，行数棘轮）
 *
 * 按"这一步 agent 在干哪一类事"分族：看自己的成品 / 产物会话 / 逛参考站 / 画布 /
 * 反馈决策 / 产线。同一概念同一图标（browser_batch 和 artifact_batch 都是 ListOrdered）；
 * 没映射的落 Wrench —— 新加工具记得来这里登记，否则用户在时间线上只看到一把扳手。
 */
import {
  Activity, Aperture, Binoculars, BookOpen, Bot,
  Bug, Camera, Clapperboard, Compass, Crosshair, Download,
  FileCode2, FileOutput, FilePlus, FileSearch2, FileText, Focus,
  FolderInput, FolderOpen, FolderTree, Gauge, Globe, Hammer,
  Hand, HelpCircle, Highlighter, ImagePlus, Inbox, LayoutDashboard,
  LayoutList, LifeBuoy, ListChecks, ListOrdered, Microscope,
  MousePointerClick, Move, Navigation, Paintbrush, Palette, Pencil,
  Pin, Pointer, Presentation, Rocket, Route, Ruler,
  ScanEye, ScanSearch, Scissors, Search, Sliders, Sparkles,
  SquareMousePointer, Tags, Terminal, TextSearch, Trash2,
  Waves, Wrench,
} from 'lucide-react';

export const TOOL_ICONS = {
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,                                // 铅笔 = 改文件
  Glob: FolderTree,
  Grep: Search,
  Bash: Terminal,
  TodoWrite: ListChecks,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,                                   // 通用 fallback（无 agentType 时）
  AskUserQuestion: HelpCircle,                 // 问号 = 主动问用户
  Skill: BookOpen,                             // SDK 内置 Skill 工具 — agent 加载方法论 body
                                               // （跟 mcp__nodesign__read_page 视觉同源 = "在读方法论"）
  // ── 看自己的成品（感知量具）──
  'mcp__nodesign__screenshot_canvas': Camera,
  'mcp__nodesign__screenshot_url': Aperture,            // 一次性一张外部 URL
  'mcp__nodesign__read_page': BookOpen,
  'mcp__nodesign__list_pages': LayoutList,
  'mcp__nodesign__query_elements': SquareMousePointer,
  'mcp__nodesign__get_computed_styles': Ruler,          // 量出来的值
  'mcp__nodesign__explain_style': Microscope,           // 级联为什么
  'mcp__nodesign__profile_scroll': Gauge,
  'mcp__nodesign__trace_motion': Waves,                 // 示波器
  // ── 产物会话（对着自己的成品点、敲、量）──
  'mcp__nodesign__artifact_open': Focus,
  'mcp__nodesign__artifact_computer': Pointer,
  'mcp__nodesign__artifact_find': Crosshair,
  'mcp__nodesign__artifact_motion': Activity,
  'mcp__nodesign__artifact_batch': ListOrdered,
  // ── 浏览通道（逛参考站）──
  'mcp__nodesign__web_search': Globe,
  'mcp__nodesign__browser_navigate': Route,
  'mcp__nodesign__browser_read': TextSearch,
  'mcp__nodesign__browser_click': MousePointerClick,
  'mcp__nodesign__browser_screenshot': Binoculars,      // 看别人的站
  'mcp__nodesign__browser_capture': FolderInput,        // 把可复用的带回工作区
  'mcp__nodesign__browser_computer': Hand,
  'mcp__nodesign__browser_find': ScanSearch,
  'mcp__nodesign__browser_batch': ListOrdered,
  'mcp__nodesign__browser_request_help': LifeBuoy,      // 叫人接手
  // ── 画布（用户的桌面）──
  'mcp__nodesign__navigate_to_page': Navigation,
  'mcp__nodesign__highlight': Highlighter,
  'mcp__nodesign__preview_deck': Presentation,
  'mcp__nodesign__pin_to_board': Pin,
  'mcp__nodesign__read_board': LayoutDashboard,
  'mcp__nodesign__organize_board': FolderOpen,
  // ── 黑板（08-25 范式重做：写=write_on_board，改=edit_board；旧名别名 08-28 收摊）──
  'mcp__nodesign__write_on_board': Pencil,
  'mcp__nodesign__edit_board': Move,
  'mcp__nodesign__board_batch': ListOrdered,
  'mcp__nodesign__look_at_board': ScanEye,
  'mcp__nodesign__read_user_view': Binoculars,
  // ── 反馈 / 决策 ──
  'mcp__nodesign__get_pending_changes': Inbox,
  'mcp__nodesign__clear_pending_changes': Trash2,
  'mcp__nodesign__report_issue': Bug,
  'mcp__nodesign__crystallize_skill': Sparkles,
  // ── 产线（生成 / 构建 / 交付）──
  'mcp__nodesign__generate_image': ImagePlus,
  'mcp__nodesign__paint_still': Paintbrush,
  'mcp__nodesign__lookup_tags': Tags,
  'mcp__nodesign__roll_film': Clapperboard,
  'mcp__nodesign__remove_background': Scissors,
  'mcp__nodesign__expose_tweaks': Sliders,
  'mcp__nodesign__build_docx': Hammer,
  'mcp__nodesign__read_document': FileSearch2,
  'mcp__nodesign__read_tavern_json': FileCode2,
  'mcp__nodesign__export_handoff': Download,
  'mcp__nodesign__deliver_files': FileOutput,
  'mcp__nodesign__publish_site': Rocket,
};

// Subagent 类型 → 专属 icon（Task 工具特化，让用户一眼分清派的是哪个子代理）
export const SUBAGENT_ICONS = {
  'explorer': Compass,                          // 罗盘 = 研究员探索
  'vision-checker': ScanEye,                    // 扫描眼 = 视觉评审
  'ds-extractor': Palette,                      // 调色板 = 抽 design system
  'tweak-proposer': Sliders,                    // 滑块 = 推 tweak schema
};

// SDK 的子代理工具名：老版 'Task'，新版 'Agent'（2026-07-30 真机确认两名并存期）
export function isSubagentTool(toolName) {
  return toolName === 'Task' || toolName === 'Agent';
}

export function getToolIcon(toolName, agentType) {
  if (isSubagentTool(toolName) && agentType && SUBAGENT_ICONS[agentType]) {
    return SUBAGENT_ICONS[agentType];
  }
  return TOOL_ICONS[toolName] || Wrench;
}
