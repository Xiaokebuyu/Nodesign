/**
 * engine/agent/cast.js —— 常驻角色（RP 演员）名册的判据层
 *
 * 「常驻角色」= 会话期间一直活着、靠 SendMessage 唤醒的子代理（叙事者 / NPC）。
 * 它跟干活型子代理（vision-checker 那类）只差一条，但这条是结构性的：
 * **它的产出走画布和收件箱，不走 tool_result 报告**，所以不能被强制前台 ——
 * 前台跑等于把主线卡在一个根本不打算结束的角色身上。
 *
 * ## 判据为什么是名字前缀，不是内存注册表
 *
 * 服务器重启 / 会话重开之后，`.claude/agents/*.md` 还躺在工作区里，内存表却是空的。
 * 判据一失效，常驻角色就会被 force-foreground 改回前台 —— 症状是「重启之后叙事者
 * 突然开始阻塞主线」，而且不报错。前缀写在文件名里，跟真相源（那个 md 文件）一起走。
 *
 * ## ASCII 是硬约束，不是风格选择
 *
 * SendMessage 的收件人校验（CLI 2.1.237 实测原文）：
 *   `name must start with a letter or digit and contain only letters, digits,
 *    underscores, or hyphens (max 64 chars)`
 * 也就是说**「墨璃」这种名字寄不出去**。所以寻址名一律是 ASCII slug（rp-molli），
 * 中文展示名另存（见 cast_role 工具与板书的 by 字段）。同族教训见记忆
 * feedback-ascii-tool-params：中文参数名会让 agent 静默结束回合。
 */

/** 常驻角色的 subagent_type 前缀。改它等于改判据，两个消费方（前台豁免、归属盖章）一起动。 */
export const ROLE_PREFIX = 'rp-';

/**
 * 常驻角色名的**唯一**判据（2026-08-26 收成一份）。
 *
 * 收之前这条正则有三份拷贝：这里、`lib/chalk.js` 的 normalizeBy、
 * `projects/board-sanitize.js` 的 sanitizeBy。三份"同一件事"里裂了一道缝——
 * 这里是「`rp-` 前缀 + 整名字符集」，另两份要求 `rp-` **之后**的首字符是字母数字。
 * 于是 `rp--x` 这种名字：派发闸放行、名册登记、byOf 也认，但落盘时两个白名单
 * 把它剥掉 → 板上条目没有 by、板书 frontmatter 折回 'agent'，**静默失名**。
 *
 * 字符集本身抄的是 CLI 对 SendMessage 收件人名的校验（letters/digits/_/-，≤64），
 * 因为这个名字要同时当收件人名和文件名。
 */
export const ROLE_SLUG_RE = /^rp-[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;

/**
 * 这个 subagent_type 是不是常驻角色。
 * 只认前缀 + 合法 slug —— `rp-` 开头但含中文/斜杠的名字一律不算，
 * 免得后面拿它去拼文件路径（cast_role 会写 .claude/agents/<slug>.md）。
 */
export function isResidentRole(subagentType) {
  // 不 trim：判据要对**下游实际使用的那个值**成立。带空白的 slug 派发本来就会失败，
  // 但「判据看 trim 后、下游用 trim 前」是同族病的幼苗（08-26 复审指出）。
  return typeof subagentType === 'string' && ROLE_SLUG_RE.test(subagentType);
}

/** 合法的角色 slug（含前缀）。cast_role 写文件前用它守门。 */
export function isValidRoleSlug(slug) {
  return isResidentRole(slug);
}

/**
 * 会话级角色名册 —— H1 的修法（2026-08-26 fable 审出）。
 *
 * ## 为什么形状判据不够
 *
 * SendMessage 的裸名解析范围是**整台机器**（CLI schema 原文：a name that exactly
 * matches one live agent *or session (on this machine)* delivers directly；并且
 * "if the same name also names an in-process agent, the bare name always wins"）。
 * 也就是说「本会话有同名 agent」时我们才被 in-process 优先保护，**本会话没有的时候，
 * 裸名会落到同机别的会话上**。
 *
 * 而 Nodesign 是多用户共机、又给每个用户同一套命名教义（rp-narrator 这种名字必然撞车）。
 * 于是有一条**正路**会漏：服务器重启 → 角色进程没了、名字空出 → 主 agent 按教义
 * `SendMessage({to:'rp-narrator'})` 唤醒 → 落到另一个用户会话里那个活着的同名角色。
 * 重启后恰恰是模型最会去试这个名字的时刻，不需要任何人有恶意。
 *
 * 所以判据从「名字长得像角色」改成「**这个会话真的派过它**」。名册是闭包级的
 * （createHooks 里一会话一个 Set），天然按会话隔离，不需要全局表也不会跨会话看见。
 *
 * 附赠：重派同名角色能被硬拦。重派的后果是**静默失忆**（CLI 的 latest wins：
 * 新角色顶掉名字，旧角色连同它演过的全部剧情失联），只靠提示词劝是拦不住的。
 */
export function createRoleRoster() {
  const names = new Set();
  // slug → 造它的那个回合 id。CLI 只在**回合边界**重扫 .claude/agents/，所以同一回合
  // 内造完就派必然 not found（2026-08-26 对照实验：等 3.5s / 12s / reinitialize 全无效，
  // 唯一有效的差别是"隔了一个回合"）。模型不听劝 —— 工具返回里写明"这一回合派不了"
  // 之后它照派不误，失败了还回一句"已派"谎报。所以这里记下回合，由派发闸结构性拦掉。
  const castRun = new Map();
  return {
    /** 造角色时记下当前回合 */
    noteCast(name, runId) { if (runId) castRun.set(name, runId); },
    /** 这个角色是不是"本回合刚造出来、还没跨回合" */
    castedInRun(name, runId) { return !!runId && castRun.get(name) === runId; },
    /** 派发时登记。返回 false = 这个名字本会话已经在场（重派会顶掉旧的） */
    claim(name) {
      if (!isResidentRole(name)) return false;
      if (names.has(name)) return false;
      names.add(name);
      return true;
    },
    /** 在场吗（收件人闸的唯一判据） */
    has(name) { return names.has(name); },
    /** 显式退场：将来的「重置角色」路径用（块 2 的 cast_role 会接） */
    release(name) { return names.delete(name); },
    list() { return [...names]; },
  };
}

/**
 * 角色能拿的工具白名单（短名，不带 `mcp__nodesign__` 前缀）。
 *
 * 定这张表的原则：**角色只能通过画布表达自己**。
 * - 给：板上写字画画读板看板、跟人说话（SendMessage）、取工具 schema（ToolSearch）、
 *   读工作区里的设定与世界书（Read/Glob/Grep —— 每章动笔前 grep 世界书是酒馆
 *   触发词在我们这儿的原生形态）。
 * - 不给：任何**外发**或**花钱**的东西（publish_site / deliver_files / 生图产线），
 *   任何**改工作区结构**的东西（Write/Edit/Bash），以及 Task（角色不再派角色）。
 *
 * ⚠️ 内置工具那一栏其实是"求个心安"：后台子代理本来就被 CLI 剥得只剩
 * Read/Glob/Grep/ToolSearch/SendMessage/Agent（2026-08-26 实测）。写在这里是为了
 * 让"角色能干什么"在一处读得全，而不是散在 CLI 的过滤逻辑里。
 */
export const ROLE_TOOL_WHITELIST = Object.freeze([
  // 板上（MCP 短名；旧别名 create/relate/arrange/sketch/edit_sketch/finish 08-28 随注册表一起收摊）
  'write_on_board', 'read_board', 'edit_board',
  'look_at_board', 'read_user_view', 'organize_board', 'pin_to_board', 'board_batch',
  // 收件箱（2026-08-26）：角色跟用户直接对话的唯一通路。后台子代理的内置
  // AskUserQuestion 被 CLI 剥掉了，MCP 工具豁免 —— 所以「问用户话」只能是这两件。
  'await_user', 'check_inbox',
  // 场（2026-08-27 编排）：看轮到谁 / 这一拍不想说就跳过（rounds 模式的机器认它）
  'read_scene', 'pass_turn',
  // 内置
  'SendMessage', 'ToolSearch', 'Read', 'Glob', 'Grep',
]);

/** 内置工具（不加 mcp 前缀）——其余按 MCP 短名加前缀 */
const BUILTIN = new Set(['SendMessage', 'ToolSearch', 'Read', 'Glob', 'Grep']);

/** 角色默认拿到的一套：够它在板上演，不多不少 */
export const ROLE_DEFAULT_TOOLS = Object.freeze([
  'write_on_board', 'read_board', 'board_batch', 'look_at_board', 'read_user_view',
  'await_user', 'check_inbox',
  'read_scene', 'pass_turn',
  'SendMessage', 'ToolSearch', 'Read', 'Grep',
]);

/** 短名 → 写进角色文件 frontmatter 的全名 */
export function qualifyRoleTool(shortName, mcpServerName) {
  return BUILTIN.has(shortName) ? shortName : `mcp__${mcpServerName}__${shortName}`;
}

/**
 * 校验一批请求的工具名。返回 { tools, rejected }。
 * 不认识的名字**不静默丢**——丢了的后果是角色少一只手而没人知道，
 * 调用方要把 rejected 如实回给 agent。
 */
export function resolveRoleTools(requested, mcpServerName) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { tools: ROLE_DEFAULT_TOOLS.map((t) => qualifyRoleTool(t, mcpServerName)), rejected: [] };
  }
  const allow = new Set(ROLE_TOOL_WHITELIST);
  const tools = [];
  const rejected = [];
  for (const raw of requested) {
    // 两种写法都收：短名（write_on_board）和全名（mcp__nodesign__write_on_board）
    const short = String(raw).replace(new RegExp(`^mcp__${mcpServerName}__`), '');
    if (allow.has(short)) tools.push(qualifyRoleTool(short, mcpServerName));
    else rejected.push(String(raw));
  }
  // SendMessage 是角色的命脉（它没有别的方式跟主代理说话），漏了就补上
  const sm = 'SendMessage';
  if (!tools.includes(sm)) tools.push(sm);
  if (!tools.includes('ToolSearch')) tools.push('ToolSearch');   // 没它取不到 SendMessage 的 schema
  return { tools, rejected };
}

/**
 * 启动期断言：白名单里的 MCP 短名必须真的注册过。
 * 名字写错的后果是**角色少一只手而不报错**（frontmatter 里写个不存在的工具名，
 * CLI 只会当它不存在），这种错只有对着真实注册表才查得出来。
 */
export function assertRoleToolsRegistered(registeredShortNames) {
  const missing = ROLE_TOOL_WHITELIST
    .filter((t) => !BUILTIN.has(t))
    .filter((t) => !registeredShortNames.has(t));
  if (missing.length) {
    throw new Error(
      `[cast] 角色工具白名单里这些 MCP 工具并不存在：${missing.join(', ')} —— `
      + '写错名字不会报错，只会让角色少一只手，所以在这里拦住',
    );
  }
}

/**
 * 展示名的保留字闸（2026-08-26；08-26 复审后加固）。
 *
 * 角色的展示名取自它自己的角色文件，**那份文件模型能写** —— 一个角色可以把自己叫
 * 「用户」，渲染进模型上下文之后跟真用户的标签逐字相同，读的人（模型）分不出来。
 * 收件箱上线后「用户说了什么」就是一条决策依据，所以这不是理论风险。
 *
 * 三个真实绕法（都实测过，别删）：
 *   'User' / 'USER'     —— 精确匹配的 Set 放行大小写变体
 *   '用\u200b户'        —— 零宽空格，肉眼同形
 *   'агent'             —— 西里尔 а，肉眼同形
 * 前两个在这里堵死；同形字收不完（Unicode 太大），靠的是**正门也用同一套规则拒名** +
 * 手写文件绕正门时这一层仍在。
 *
 * ⚠️ 这个函数要在**源头**用（listRoleNames 出口），不是在每个渲染面各用一次 ——
 * 08-26 复审实证：三个渲染面里漏了一个，而漏的那个正是携带用户原话的标注回路。
 */
const RESERVED_LABELS = new Set([
  'user', 'agent', 'main', 'system', 'assistant', 'claude', 'human', 'admin', 'root',
  '用户', '主控', '你', '我', '系统', '管理员', '主人', '助手',
]);

/** 比较前的归一：剥不可见字符（Cf：零宽、bidi 控制…）与空白，转小写 */
function normalizeLabel(v) {
  return String(v || '').replace(/[\p{Cf}\s]/gu, '').toLowerCase();
}

/**
 * 安全的展示名：撞保留字或空 → 退回 slug（宁可难看，也不能让署名可冒充）。
 * 返回值里的不可见字符也一并剥掉 —— 渲染出去的字不许藏东西。
 */
export function safeRoleLabel(slug, displayName) {
  const cleaned = String(displayName || '').replace(/\p{Cf}/gu, '').trim();
  if (!cleaned) return slug;
  return RESERVED_LABELS.has(normalizeLabel(cleaned)) ? slug : cleaned;
}
