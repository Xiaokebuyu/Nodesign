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

/**
 * skill × 模式（2026-08-30）。跟上面那张表同一个语义，另一个载体。
 *
 * ## 为什么 skill 也要按模式筛
 *
 * `session-loop.js` 把 `installed.skills` 整个交给 SDK，而 SDK **只把 description
 * 注进系统提示词**（body 才是按需加载，见 agent/skill.js 头注）。所以每装一个 skill，
 * 它那几百字节的描述就在**每一个会话**里常驻 —— 不分模式。
 *
 * 实测（08-30）：RP 会话现在背着 deskskill-engine-mini(562B) / docx-craft(1123B) /
 * site-craft(782B) 三份描述，合计 ~2.4KB，而这三个 skill 要用的工具
 * （`build_docx` / `publish_site` / `preview_deck`）在 RP 模式下**根本没注册**
 * ——上面那张 RP_HIDDEN_TOOLS 已经把它们摘掉了。工具没了描述还在，是纯亏。
 * 反过来同理：演出侧的文风/技法包不该压在设计会话的常驻区里。
 *
 * ## 判据
 *
 * 表里没有的名字**一律放行** —— 用户自己装的 plugin（用户级 / 项目级）不归我们裁，
 * 只管内置这几个。这条别改成白名单：那会让用户装的 skill 静默消失，
 * 而「静默消失」是这条线上最难查的一类。
 */
export const SKILL_MODES = Object.freeze({
  // 设计产线：工具在 RP 下已下架，描述跟着走
  'deskskill-engine-mini': 'design',
  'docx-craft': 'design',
  'site-craft': 'design',
  // 演出侧：主 agent 在 rp 项目里只做开场前的准备（stage-setup）
  'stage-setup': 'rp',
  // 只给演出进程（manager.js STAGE_SKILLS 点名装），两种主会话都不背它们的描述：
  // 09-06 起主 agent 不再自己写正文，这两包技法它用不上
  'story-craft': 'stage',
  'story-intimacy': 'stage',
  // 两边都要：酒馆卡常常被丢进设计项目，agent 得会拆再建议切模式
  'story-import': 'both',
});

/** 按模式筛 skill 名单。表里没有的一律保留（用户装的不归我们裁）；标 'stage' 的两种主会话都不给。 */
export function filterSkillsForMode(names, mode) {
  const want = mode === 'rp' ? 'rp' : 'design';
  return (Array.isArray(names) ? names : []).filter((n) => {
    const m = SKILL_MODES[n];
    return !m || m === 'both' || m === want;
  });
}

/**
 * 启动期对账：表里每个名字必须真的装着。
 * 跟 assertModeProfileNames 同样的狠法 —— skill 改名/下线后表没跟上就是静默空转。
 * @param {string[]} installedNames 本次会话实际装上的 skill 名单
 */
export function assertSkillModeNames(installedNames) {
  const have = new Set(installedNames || []);
  const ghosts = Object.keys(SKILL_MODES).filter((n) => !have.has(n));
  if (ghosts.length) {
    throw new Error(
      `[mode-profile] SKILL_MODES 里有没装上的 skill: ${ghosts.join(', ')} `
      + '—— skill 改名或下线后对照表没跟上，这些条目在静默空转',
    );
  }
}

/**
 * skill 按模式筛的总入口（08-30；从 session-loop 拆来 —— 行数棘轮）。
 * SDK 只把 description 注进系统提示词（body 按需加载），所以每个 skill 的几百字节
 * 描述是**每个会话**的常驻成本，不分模式。筛之前 RP 会话背着设计三件
 * （deskskill/docx/site 合计 ~2.4KB）的描述，而它们要用的工具在 RP 下压根没注册。
 * 对账跟 assertModeProfileNames 一样狠：表里的名字没装上就当场炸，别静默空转。
 */
export function modeSkillsFor(installedNames, mode) {
  assertSkillModeNames(installedNames);
  const out = filterSkillsForMode(installedNames, mode);
  if (out.length !== installedNames.length) {
    const dropped = installedNames.filter((n) => !out.includes(n));
    console.log(`[session-loop] skills 按 mode=${mode} 筛掉 ${dropped.length}: [${dropped.join(', ')}]`);
  }
  return out;
}
