/**
 * server/engine/mcp/tool-concurrency.js —— 哪些工具可以并行跑（2026-09-13）
 *
 * CLI 的 StreamingToolExecutor 在每个 tool_use 块闭合时就派发执行，不等整条消息写完。
 * 能不能跟同一条消息里的其他调用**同时**跑，只看 MCP annotations 的 readOnlyHint：
 * 标了 = isConcurrencySafe，没标一律串行（排在前面所有调用跑完之后）。
 *
 * ⚠️ 有意偏离文档（09-13 第二批，站主定「除了高危操作都鼓励并行」）：SDK 文档说 annotations 要跟 handler
 * 的真实行为一致，readOnlyHint 就该只标只读工具。我们把它当「可以并行」的开关用，给会落盘的
 * web_search / generate_image / 截图类也打了标。偏离的代价逐条核过（SDK 0.3.269 内置二进制读码）：
 *   - 计划模式下不拦（没标的 MCP 工具在计划模式返回 "Cannot call X while in plan mode"）——
 *     Nodesign 计划模式基本不用，打标的这几件在计划模式里跑也不改用户的产物；
 *   - 调用结束后跳过一个给写操作用的监听回调（远程会话同步用，我们不走那条路）；
 *   - 其余只进遥测。
 * 以后 CLI 若给 readOnlyHint 挂上真正的权限语义（比如只读工具免审批、只读模式放行），这张表要重新过一遍。
 *
 * 两张表合起来必须覆盖全部工具（tool-concurrency.lint.test.js 钉着）：新工具不许默认落在
 * 「没想过」这一格。判据：
 *   PARALLEL_SAFE_TOOLS —— 同时跑不会互相踩：
 *     · 不改板面、不改用户正在看的视图、不改进程内共享状态；
 *     · 落盘的话，名字不会撞（按内容哈希 / 进程内序号 / 带毫秒），而且落下的是新文件不是改旧文件；
 *     · 吃资源的有闸：开 chromium 的过 helpers/browser-slots.js（进程级槽位），出图的过会话出图池；
 *     · 不是高危操作（发布、删改文件、起停进程、花钱没上限的）。
 *   SERIAL_TOOLS —— 其余全部。
 * 拿不准放 SERIAL：放错到 SERIAL 只是慢，放错到 PARALLEL 是并发 bug。
 * 范围只是 nodesign 这台 MCP server；演出进程那台（engine/stage/tools.js）另算，没动。
 */

export const PARALLEL_SAFE_TOOLS = new Set([
  // 纯读板面 / 视点（readBoard 只读文件，失败回空板，不回写）
  'read_board', 'read_user_view',
  // 纯读产物文件的一页（regex 切 section，不起浏览器）
  'read_page',
  // 只发一个外网查询，不落盘
  'lookup_tags',
  // 纯 JS 抽文本，不起外部进程、不写缓存
  'read_document',
  // 只 SELECT runs 表（本项目的用户原话，09-17），不写库、不落盘
  'read_user_messages',
  // 只读 DirectEdit 缓冲；清空是另一件工具 clear_pending_changes
  'get_pending_changes',
  // 只读进程注册表与日志（写记录的是 start/stop）
  'list_processes', 'read_process_log',
  // 搜索：参考图按 URL 哈希定名（reference-download.js），同一张图并行下载写的是同一份字节；发 file_changed 是新增
  'web_search',
  // 出图：会话出图池封顶（generate-image-support.js makeImagePool）；没给 outputName 时名字带进程内序号不撞。
  // 给了同一个 outputName 的两次并行调用会互相覆盖 —— 跟串行时后一张覆盖前一张结果一样，不算新问题
  'generate_image',
  // 感知量具：一次性模式开 chromium 过进程级槽位（helpers/browser-slots.js，托管 1 只 / 本地 2 只），
  // 量帧时间的（trace_motion、profile_scroll、胶片条）独占全部槽位；live:true 走产物会话的项目锁，天然排队。
  // look_at_board 另有一条自己的串行闸（打开的是整个前端应用）
  // screenshot_canvas 的 saveTo（09-17）把 docx 页图写进 agent 指定的目录：逐级 mkdir 容忍 EEXIST、逐个原子写，
  // 两次并行写到同名文件 = 串行时后一次覆盖前一次（返回里报覆盖），同 generate_image 的 outputName，不算新问题
  'look_at_board', 'screenshot_canvas', 'screenshot_url', 'list_pages', 'query_elements',
  'get_computed_styles', 'explain_style', 'trace_motion', 'profile_scroll',
]);

export const SERIAL_TOOLS = new Set([
  // 写板面 / 产物 / 文件
  'write_on_board', 'edit_board', 'organize_board', 'pin_to_board', 'draw_trend',
  'build_docx', 'deliver_files', 'export_handoff', 'publish_site', 'crystallize_skill',
  'expose_tweaks', 'set_vars', 'highlight', 'navigate_to_page', 'clear_pending_changes',
  'jot_memory', 'cast_role', 'report_issue', 'open_stage', 'stage_backdrop', 'roll_dice',
  // 切用户正在看的那一页（setActiveDeck + 前端跳页），两个并行就是抢镜头
  'preview_deck',
  // 首次调用会把旧形状 stage/ 迁进文件夹（manager.js ensurePlays），有写入
  'stage_status',
  // 会把角色卡 / 世界书导出成文件
  'read_tavern_json',
  // 本地 GPU 盒子（一台机器一张卡）/ 抠图（rembg 子进程吃内存）
  'paint_still', 'roll_film', 'remove_background',
  // 起停进程
  'start_process', 'stop_process',
  // 浏览通道 / 产物会话：同一项目共用一把锁，标了也是排队，没有收益；而且多数会改页面状态
  'browser_navigate', 'browser_read', 'browser_click', 'browser_screenshot', 'browser_capture',
  'browser_request_help', 'browser_computer', 'browser_find', 'browser_batch',
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_motion', 'artifact_batch',
]);

/** 装配时打标：只动 annotations，其余字段原样 */
export function withConcurrencyHint(toolDef) {
  if (!PARALLEL_SAFE_TOOLS.has(toolDef?.name)) return toolDef;
  return { ...toolDef, annotations: { ...toolDef.annotations, readOnlyHint: true } };
}

/**
 * 启动期对账（跟 assertAlwaysLoadNames 同病同药）：表里的名字在注册表里不存在 = 改名后表没跟上，
 * 那件工具静默退回串行。对照**过滤前**的全量名单。
 * 未登记的新工具不在这里炸（线上不该因为漏登记起不来），由 lint 测试拦。
 */
export function assertConcurrencyNames(registeredNames) {
  const have = new Set(registeredNames);
  const ghosts = [...PARALLEL_SAFE_TOOLS].filter((n) => !have.has(n));
  if (ghosts.length) {
    throw new Error(`[tool-concurrency] 并行表里有注册表不存在的名字: ${ghosts.join(', ')} —— 改名后表没跟上，这些工具在静默串行`);
  }
  const both = [...PARALLEL_SAFE_TOOLS].filter((n) => SERIAL_TOOLS.has(n));
  if (both.length) throw new Error(`[tool-concurrency] 同时登记在并行表和串行表: ${both.join(', ')}`);
}
