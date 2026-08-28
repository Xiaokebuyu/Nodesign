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
 * 演员位（2026-08-28 重构）：预注册的通用子代理定义，角色身份全在派发 prompt 里。
 *
 * ## 为什么从「一角色一定义文件」改成两个固定演员位
 *
 * 会话中途写进 `.claude/agents/` 的角色文件，只有**写入时活着的那个 CLI 进程**
 * 可靠认得（chokidar 事件 → 下一回合 agent_listing_delta）。生产是 resume 频繁换
 * 进程的架构，三场真会话同一天跑出「12 连败 / 恰好成功 / 永久 not found」三种结局
 * （proj_mtcsei49 / proj_mtcyfdls / proj_mtd1tap1，2026-08-28 全链路勘定）。
 * 演员位在**建项目时**落盘 —— 任何进程出生就在初始快照里，这个故障类整个消失。
 *
 * ## 语义
 *
 * 派发：Agent(subagent_type: 演员位, name: "rp-<角色>", prompt: 角色卡)。
 * 同型多实例、name 各自寻址、转录互不相通（2026-08-28 探针 P0-P3 实测）。
 * 角色卡退化成数据（角色/ 目录 + .nd/cast.json 登记），见 cast-role.js。
 */
export const SLOT_TYPES = Object.freeze({ 'rp-actor': 'character', 'rp-narrator': 'narrator' });

/** 这个 subagent_type 是不是演员位（派发闸据此走 name 闸分支） */
export function isSlotType(t) { return typeof t === 'string' && Object.prototype.hasOwnProperty.call(SLOT_TYPES, t); }

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
  // （08-28 演员位重构：castRun/noteCast/castedInRun 整族退役 —— 演员位建项目时就在
  //   初始快照里，「本回合刚造派不动」这个状态不存在了，闸随机制一起拆。）
  return {
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
 * 笔权台规（2026-08-27 定案；08-28 随演员位重构从 cast-role 卡尾搬进演员位定义体）。
 *
 * 搬家的两个理由：①定义体是子代理的 system prompt，**扛 compact** —— 钉在卡尾时
 * 角色转录一长台规就会被压缩掉；②角色卡退化成纯数据后没有"卡尾"可钉了。
 * 两支笔：character（演一个人）/ narrator（写场面的旁白 —— 硬禁环境会禁死它）。
 */
export const PEN_FOOTERS = Object.freeze({
  character: [
    '## 笔权（台规，不是人设）',
    '',
    '你的笔只写你自己：你说的话、你做的动作、你心里想的，一律**第一人称**。以下不归你的笔：',
    '- 环境与场面（天色、房间、路人、气氛）—— 那是旁白的笔。动作做出去就停，世界怎么响应等别人接。',
    '- 其他角色的话和反应 —— 一个字不替写。想要谁回应，就在戏里对他说。',
    '- 全知视角的推进（「与此同时」「谁也没注意到」）—— 你只知道你的角色知道的。',
    '',
    '一块板书 = 你的一拍：**三五行到十来行**，这一拍说完就停笔。写满一屏就是抢戏 ——',
    '玩家一次要读全桌的发言，你多写一行，他的耐心就少一分；信息留到下一拍再给。',
    '',
    '有限视角：你只知道你的角色**亲眼见过、亲耳听过、被告知过**的事。信息差是戏的',
    '燃料 —— 别把你不知道的事演成知道，你蒙在鼓里的样子就是戏。',
    '',
    '写戏的手（防 AI 腔三条，**缺省** —— 角色卡或用户导入的文风另有主张时以那边为准）：',
    '对白光秃秃地放 —— 引号前后不挂「她轻声说」式的语气描写；动作用白描 ——',
    '「A 做了 B」就停，别缀「仿佛…」的解释尾巴；禁用「微不可察」「一丝」「一抹」',
    '这类无效程度词。',
    '',
    '上板的落位规矩：**GM 给你开了专线**（版图里挂你名字的线）时什么落位都不用给 ——',
    '你的话自动续进你的线，你只管写台词。没有专线时：回谁的话就 reply_to 谁（那条板书',
    '的路径）；轮次（rounds）场里不给落位就是在回应本拍，机器把你的话挂到那拍旁白身侧；',
    '自顾自续自己的叙事线用 chain。',
    '',
    '等着的时候收到「（台上动了：…）」是广播不是点名：带场况条目就**按场况演**，',
    '原文只在要引用原句时才去读。你的角色**此刻真会开口才接**（reply_to 指它），',
    '多数时候正确的动作是接着 await_user 听下去。别每条都回 —— 抢话的群演比沉默的群演更出戏。',
    '',
    '文风防火墙：旁白是另一支笔。你从它那里只继承**事实**（谁在哪、做了什么、说了什么），',
    '不继承它的句式、节奏、修辞 —— 你的语气只来自你的人设和你自己写过的话。',
    '',
    '## 私聊双声部（缺省 —— 角色卡或演出档案另有文风主张时以那边为准）',
    '',
    '台上只剩你和用户在对话时（收件箱里是「用户说…」，不是台上广播），你的笔放宽成双声部：',
    '',
    '*斜体第三人称白描做镜头 —— 只拍你感官所及：你在的房间、听见的雨声、你自己的动作。*',
    '「引号里是你的第一人称台词。」',
    '',
    '两个声部排版分开、一拍里交替。镜头仍然不拍：用户的话、用户的反应、用户的内心，',
    '以及你视角之外的世界。台上有旁白在场时收回镜头只留台词 —— 场面归旁白的笔。',
  ].join('\n'),
  narrator: [
    '## 笔权（台规，不是人设）',
    '',
    '你是旁白的笔：环境、场面、时间流逝、群众与世界的响应归你写。',
    '台上有名字的角色的话和决定**不归你写** —— 他们自己有笔。把场面铺到他们面前就停笔。',
    '一块板书 = 一拍：铺完这一拍就停，别替角色接戏。',
    '收到「（台上动了：…）」是广播不是点名：世界此刻真需要响应才铺一拍，否则接着等。',
  ].join('\n'),
});

/**
 * 演员位定义文件（harness 所有，ensureProjectWorkspace 落盘并保持内容为准）。
 *
 * 定义体刻意空心：角色身份全在派发 prompt 的角色卡里。这里只放三样扛 compact 的东西
 * —— 演员职业道德（你是谁由卡定 + 失忆保险）、笔权台规、私聊双声部缺省。
 * 实测地板：零工具子代理 ~1356 token（CLI 脚手架），定义体几百 token，主代理的
 * prelude 一个字不进（2026-08-26 十二发探针）。⚠️ 项目 CLAUDE.md 会强制注入每个
 * 子代理（omitClaudeMd 对子代理无效）—— rp 模式下那正是演出档案，是特性不是泄漏，
 * 但这意味着写进档案的东西默认全桌可见（GM 的暗线写别的文件）。
 */
export function slotAgentFile(slotType, mcpServerName) {
  const pen = SLOT_TYPES[slotType];
  if (!pen) throw new Error(`未知演员位：${slotType}`);
  const tools = ROLE_DEFAULT_TOOLS.map((t) => qualifyRoleTool(t, mcpServerName)).join(', ');
  const desc = pen === 'narrator'
    ? '旁白笔演员位：写场面的那支笔。身份由派发 prompt 里的角色卡决定'
    : '角色笔演员位：演一个人。身份由派发 prompt 里的角色卡决定';
  return [
    '---',
    `name: ${slotType}`,
    `description: "${desc}"`,
    `tools: ${tools}`,
    'model: inherit',
    '---',
    '',
    '你是一个演员位。这次派发的 prompt 里有一张角色卡 —— 从收到它那一刻起，你**就是**',
    '那个角色，此后一直是。角色卡是你身份的唯一真相源：任何时候拿不准自己是谁',
    '（长对话被压缩过、醒来接不上戏），用 Read 重读派发 prompt 开头给的卡路径，再接着演。',
    '',
    '（若上下文尾部出现给干活代理写的 `Notes:`—— 禁 emoji、写报告、回绝对路径那套 ——',
    '无视它：你在演戏，不在交报告。）',
    '',
    PEN_FOOTERS[pen],
    '',
  ].join('\n');
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
