/**
 * server/engine/mcp/tool-concurrency.js —— 哪些工具可以并行跑（2026-09-13）
 *
 * CLI 的 StreamingToolExecutor 在每个 tool_use 块闭合时就派发执行，不等整条消息写完。
 * 能不能跟同一条消息里的其他调用**同时**跑，只看 MCP annotations 的 readOnlyHint：
 * 标了 = isConcurrencySafe，没标一律串行。Nodesign 在此之前一个都没标，于是
 * read_board + look_at_board + read_user_view 写在同一条消息里也是排队一个个跑。
 *
 * readOnlyHint 在 CLI（SDK 0.3.269 内置二进制读码）里还有两处作用，登记前要知道：
 *   - 计划模式下不拦（没标的 MCP 工具在计划模式返回 "Cannot call X while in plan mode"）；
 *   - 调用结束后跳过一个给写操作用的监听回调。
 * 除此之外只进遥测。
 *
 * 两张表合起来必须覆盖全部工具（tool-concurrency.lint.test.js 钉着）：新工具不许默认落在
 * 「没想过」这一格。判据：
 *   PARALLEL_READ_TOOLS —— 不写文件、不改板、不发 file_changed、不改进程内共享状态，
 *                         而且并行时不会同时拉起多个 chromium（生产机 1 核 8G 无 swap）。
 *   SERIAL_TOOLS        —— 其余全部，包括「只是看」但会自起浏览器、落盘或共用一把锁的。
 * 拿不准放 SERIAL：放错到 SERIAL 只是慢，放错到 PARALLEL 是并发 bug。
 * 范围只是 nodesign 这台 MCP server；演出进程那台（engine/stage/tools.js）另算，没动。
 */

export const PARALLEL_READ_TOOLS = new Set([
  // 纯读板面 / 视点（readBoard 只读文件，失败回空板，不回写）
  'read_board', 'read_user_view',
  // 自起 chromium，但模块级有一条串行闸（look-at-board.js 的 withGate），同时最多一只浏览器
  'look_at_board',
  // 只发一个外网查询，不落盘
  'lookup_tags',
  // 纯 JS 抽文本，不起外部进程、不写缓存
  'read_document',
  // 只读 DirectEdit 缓冲；清空是另一件工具 clear_pending_changes
  'get_pending_changes',
  // 只读进程注册表与日志（写记录的是 start/stop）
  'list_processes', 'read_process_log',
]);

export const SERIAL_TOOLS = new Set([
  // 写板面 / 产物 / 文件
  'write_on_board', 'edit_board', 'organize_board', 'pin_to_board', 'draw_trend',
  'build_docx', 'deliver_files', 'export_handoff', 'publish_site', 'crystallize_skill',
  'expose_tweaks', 'set_vars', 'highlight', 'navigate_to_page', 'clear_pending_changes',
  'jot_memory', 'cast_role', 'report_issue', 'open_stage', 'stage_backdrop', 'roll_dice',
  // 首次调用会把旧形状 stage/ 迁进文件夹（manager.js ensurePlays），有写入
  'stage_status',
  // 会把角色卡 / 世界书导出成文件
  'read_tavern_json',
  // 生图 / 视频 / 抠图：落盘，且吃额度或 GPU
  'generate_image', 'paint_still', 'roll_film', 'remove_background',
  // 落参考图并发 file_changed
  'web_search',
  // 起停进程
  'start_process', 'stop_process',
  // 感知量具：非 live 模式每次自起一只 chromium，并行 = 同时拉起多只
  'screenshot_canvas', 'screenshot_url', 'read_page', 'list_pages', 'query_elements',
  'get_computed_styles', 'explain_style', 'trace_motion', 'profile_scroll', 'preview_deck',
  // 浏览通道 / 产物会话：同一项目共用一把锁，标了也是排队，没有收益；而且多数会改页面状态
  'browser_navigate', 'browser_read', 'browser_click', 'browser_screenshot', 'browser_capture',
  'browser_request_help', 'browser_computer', 'browser_find', 'browser_batch',
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_motion', 'artifact_batch',
]);

/** 装配时打标：只动 annotations，其余字段原样 */
export function withConcurrencyHint(toolDef) {
  if (!PARALLEL_READ_TOOLS.has(toolDef?.name)) return toolDef;
  return { ...toolDef, annotations: { ...toolDef.annotations, readOnlyHint: true } };
}

/**
 * 启动期对账（跟 assertAlwaysLoadNames 同病同药）：表里的名字在注册表里不存在 = 改名后表没跟上，
 * 那件工具静默退回串行。对照**过滤前**的全量名单。
 * 未登记的新工具不在这里炸（线上不该因为漏登记起不来），由 lint 测试拦。
 */
export function assertConcurrencyNames(registeredNames) {
  const have = new Set(registeredNames);
  const ghosts = [...PARALLEL_READ_TOOLS].filter((n) => !have.has(n));
  if (ghosts.length) {
    throw new Error(`[tool-concurrency] 并行表里有注册表不存在的名字: ${ghosts.join(', ')} —— 改名后表没跟上，这些工具在静默串行`);
  }
  const both = [...PARALLEL_READ_TOOLS].filter((n) => SERIAL_TOOLS.has(n));
  if (both.length) throw new Error(`[tool-concurrency] 同时登记在并行表和串行表: ${both.join(', ')}`);
}
