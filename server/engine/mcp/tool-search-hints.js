/**
 * server/engine/mcp/tool-search-hints.js —— 延迟加载工具的检索关键词（2026-09-13）
 *
 * 不在 ALWAYS_LOAD_TOOLS 里的工具，agent 只看得到名字，要用 ToolSearch 按关键词把 schema 找回来。
 * ToolSearch 是词法打分：名字命中权重最高，其次 `_meta['anthropic/searchHint']`，再其次描述。
 * 这里给「名字说不出用途」的那些补同义词，装配时统一打标（mcp/index.js）。
 *
 * 09-13 真跑探针（SDK 0.3.269，haiku）：
 *   - 两个名字、描述都一样含糊的工具，只给一个挂 hint "cutout remove background …"，搜 "cutout" 只返回挂了的那个；
 *   - ⛔ 搜「抠图」返回 "No matching deferred tools found" —— 分词只认 ASCII 单词，中文关键词无效。
 *     所以这里只写英文，lint（tool-search-hints.lint.test.js）钉住只许 ASCII。
 *
 * 写法：空格分隔的小写英文词，写 agent 会用来搜的**同义词和场景词**，名字里已有的词不用重复。
 */
export const TOOL_SEARCH_HINTS = Object.freeze({
  generate_image: 'picture illustration artwork draw paint render hero cover poster photo art dalle',
  paint_still: 'anime illustration local gpu stable diffusion sdxl noobai pony krea character art',
  roll_film: 'video animation clip movie motion shot footage',
  remove_background: 'cutout transparent png matte mask isolate subject',
  lookup_tags: 'danbooru prompt keywords anime tag search',
  build_docx: 'word document docx report memo export office',
  read_document: 'docx xlsx pptx word excel powerpoint spreadsheet slides extract text',
  deliver_files: 'download send give user files attachment handoff',
  export_handoff: 'zip package bundle source code handoff developer',
  publish_site: 'deploy host website online public url cloudflare pages launch',
  expose_tweaks: 'controls sliders knobs parameters customize panel',
  crystallize_skill: 'showcase portfolio save style reusable skill template',
  draw_trend: 'chart graph line plot stats progress over time',
  explain_style: 'css cascade specificity why computed style debug',
  trace_motion: 'animation timing curve easing measure frames',
  profile_scroll: 'scroll performance jank fps lag smoothness',
  start_process: 'dev server npm run serve watcher background process launch',
  read_process_log: 'server output logs console stdout',
  stop_process: 'kill terminate server process',
  list_processes: 'running servers processes',
  organize_board: 'folder tidy move files canvas group',
  pin_to_board: 'show bring front canvas place item',
  read_user_view: 'viewport what user sees selection camera zoom',
  // 09-17：用户要「整合我说过的话」、回退后找原话时要搜得到
  read_user_messages: 'history previous earlier prompts said wrote original wording recall chat rollback rewind interrupted',
  report_issue: 'bug feedback harness maintainer problem',
  web_search: 'internet google lookup research find online',
  read_tavern_json: 'sillytavern character card lorebook preset import',
  roll_dice: 'random chance check dice roll rng',
  set_vars: 'state table variables stats hp values update',
  open_stage: 'story performance display play start roleplay',
  stage_backdrop: 'background image story display backdrop',
  stage_status: 'story state progress display',
  cast_role: 'character card register persona role',
  jot_memory: 'remember note memory character',
});

/** 装配时打标：只加 _meta 的 searchHint 键，其余原样 */
export function withSearchHint(toolDef) {
  const hint = TOOL_SEARCH_HINTS[toolDef?.name];
  if (!hint) return toolDef;
  return { ...toolDef, _meta: { ...toolDef._meta, 'anthropic/searchHint': hint } };
}
