/**
 * engine/mcp/mode-profile.js — 项目模式 × 工具面的唯一对照表 + 闸（2026-08-27）。
 *
 * 项目分两种模式（projects.mode，真相源在 projects/store.js）：
 *   - design：设计工作台（现状默认）。工具面不动 —— 含全部 RP 工具，因为存量的
 *     演出全发生在 design 项目里，在这里藏 RP 工具等于把它们全断掉。等演出模式
 *     转正、真会话都迁过去之后，再考虑反向裁剪。
 *   - rp：演出（常驻角色演故事）。下架设计产线 —— 不是防误用那么简单：工具名
 *     进上下文就是注意力，prelude 的设计教义也按同一模式剥（system-prompts.js
 *     的 nd:mode 分区）。两边共用画布/黑板/会话/精灵全部基础设施。
 *
 * 跟 capability-gate.js 的关系：同一个注册期 filter 位置、不同判据 ——
 * 那边按「本机能力在不在」，这边按「这个项目在演哪种戏」。都是 unregister 语义
 * （连名字都不给模型看见），先后串联，谁说不注册都不注册。
 *
 * ⚠️ 改这张表必须跑 assertModeProfileNames（mcp/index.js 启动期已挂）：
 * 表里的名字对不上真实注册名时它当场炸 —— 不然一次工具改名就让这里静默空转，
 * 「配置读数 ≠ 真在生效」这条线上已经栽过太多次。
 */

/**
 * rp 模式下整件不注册的工具。按产线分组 —— 拆的时候用户按功能拍的板
 * （2026-08-27：「文档站点应用都移除，生图黑板精灵和浏览器感知留下」）。
 */
export const RP_HIDDEN_TOOLS = Object.freeze(new Set([
  // deck / 文档产线
  'build_docx', 'preview_deck', 'read_page', 'list_pages',
  // 站点发布
  'publish_site',
  // 设计交付与方法论结晶
  'export_handoff', 'crystallize_skill',
  // ⚠️ get_pending_changes / clear_pending_changes **不在此列**：DirectEdit 是用户
  // 输入通道（圈图说事 / 双击改字），不是设计产线 —— rp 项目里也得能收用户的圈注。
  // HTML 产物量具（板的眼睛是 look_at_board / read_user_view，不在此列）
  'screenshot_canvas', 'query_elements', 'get_computed_styles', 'explain_style',
  'profile_scroll', 'trace_motion',
  // 产物会话五量具
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_motion', 'artifact_batch',
]));

/** 这件工具在该模式下该不该注册（false = 连名字都不给） */
export function shouldRegisterForMode(toolDef, mode) {
  if (mode !== 'rp') return true;
  return !RP_HIDDEN_TOOLS.has(toolDef.name);
}

/**
 * 启动期对账：表里每个名字必须真实存在于注册表。
 * @param {string[]} registeredNames design 模式（全量）下的注册名单
 * @throws 表里出现注册表没有的名字（改名 / 删除后表没跟上）
 */
export function assertModeProfileNames(registeredNames) {
  const have = new Set(registeredNames);
  const ghosts = [...RP_HIDDEN_TOOLS].filter((n) => !have.has(n));
  if (ghosts.length) {
    throw new Error(
      `[mode-profile] RP_HIDDEN_TOOLS 里有注册表不存在的名字: ${ghosts.join(', ')} `
      + '—— 工具改名或下线后对照表没跟上，这些条目在静默空转',
    );
  }
}
