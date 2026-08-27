/**
 * server/engine/mcp/index.js — Nodesign 内置 MCP server
 *
 * 暴露给 agent 的自定义工具集（in-process，via SDK 的 createSdkMcpServer）：
 *
 *   感知层（playwright headless 跑出真实渲染元数据）：
 *     screenshot_canvas / list_pages / read_page / query_elements / get_computed_styles
 *   控制层（emit 事件让前端同步）：
 *     navigate_to_page / highlight / preview_deck
 *   反馈层（用户在 canvas 上的直接编辑 + 评论 buffer）：
 *     get_pending_changes / clear_pending_changes
 *   产物层（NoDesign 差异化能力）：
 *     export_handoff …（expose_tweaks 08-24 暂退役待升级；record_decision 08-24 拆除，记忆体系接棒）
 *   研究层：
 *     web_search（4 provider，CJK auto baidu）
 *
 * 调用约定（SDK 自动给 tool name 加前缀）：
 *   tool 名在 agent 端是 mcp__nodesign__<tool>，比如 mcp__nodesign__screenshot_canvas
 *
 * 实例化策略：
 *   每个 runAgent 创建一个新的 MCP server 实例（through createNodesignMcpServer）。
 *   开销小（in-process，没起 process），但能让 deps（workspaceRoot / projectId / ctx）
 *   绑死到当前 turn 的上下文，避免 cross-talk。
 *
 * 安全：
 *   tool handler 在 SDK 进程内（本服务器进程）跑，不通过 stdio/sse/http。
 *   handler 自己不做沙盒，由 PreToolUse hook + workspace cwd 隔离兜底。
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { withParamSanitizer } from './param-sanitizer.js';
import { withCapabilityGate, shouldRegisterTool } from './capability-gate.js';
import { shouldRegisterForMode, assertModeProfileNames } from './mode-profile.js';
import { MCP_SERVER_NAME } from './server-name.js';
import { makeScreenshotCanvasTool } from './tools/screenshot.js';
import { makeScreenshotUrlTool } from './tools/screenshot-url.js';
import { makeExportHandoffTool } from './tools/export-handoff.js';
import { makeWebSearchTool } from './tools/web-search.js';
import { withTierGate } from './tools/tier-gate.js';   // 档位闸包装器（auth/tier.js；按项目 owner）
import { makeReadPageTool } from './tools/read-page.js';
import { makeListPagesTool } from './tools/list-pages.js';
import { makeQueryElementsTool } from './tools/query-elements.js';
import { makeProfileScrollTool } from './tools/profile-scroll.js';
import { makeExplainStyleTool } from './tools/explain-style.js';
import { makeTraceMotionTool } from './tools/trace-motion.js';
import {
  makeBrowserNavigateTool, makeBrowserReadTool, makeBrowserClickTool,
  makeBrowserRequestHelpTool, makeBrowserCaptureTool,
} from './tools/browse.js';
import { makeBrowserScreenshotTool } from './tools/browse-screenshot.js';
import { makeBrowserComputerTool } from './tools/browse-computer.js';
import { makeBrowserFindTool, makeBrowserBatchTool, makeBatchTool } from './tools/browse-find-batch.js';
import { makeArtifactOpenTool, makeArtifactComputerTool, makeArtifactFindTool, makeArtifactMotionTool, makeArtifactBatchTool } from './tools/artifact-session.js';
import { makeGetComputedStylesTool } from './tools/get-computed-styles.js';
import { makeNavigateToPageTool } from './tools/navigate-to-page.js';
import { makeHighlightTool } from './tools/highlight.js';
import { makePreviewDeckTool } from './tools/preview-deck.js';
import { makeBuildDocxTool } from './tools/build-docx.js';
// expose-tweaks 08-24 暂退役（能力不足待升级再加回）：本体与前端 TweaksPanel 留档休眠，不注册
import { makeGetPendingChangesTool } from './tools/get-pending-changes.js';
import { makeClearPendingChangesTool } from './tools/clear-pending-changes.js';
import { makeGenerateImageTool } from './tools/generate-image.js';
import { makeRemoveBackgroundTool } from './tools/remove-background.js';
import { makePinToBoardTool } from './tools/pin-to-board.js';
import { makeEditBoardTool, makeEditSketchAlias, makeArrangeOnBoardAlias, makeRelateOnBoardAlias } from './tools/edit-board.js';
import { makeReadBoardTool } from './tools/read-board.js';
import { makeCreateOnBoardTool } from './tools/create-on-board.js';
import { makeFinishSketchTool } from './tools/sketch-on-board.js';
import { makeWriteOnBoardTool, makeSketchOnBoardAlias } from './tools/write-on-board.js';
import { makeLookAtBoardTool } from './tools/look-at-board.js';
import { makeReadUserViewTool } from './tools/read-user-view.js';
import { makeOrganizeBoardTool } from './tools/organize-board.js';
import { makeReadDocumentTool } from './tools/read-document.js';
import { makeReadTavernJsonTool } from './tools/read-tavern-json.js';
import { makeDeliverFilesTool } from './tools/deliver-files.js';
import { makeCrystallizeSkillTool } from './tools/crystallize-skill.js';
import { makeCastRoleTool } from './tools/cast-role.js';
import { makeAwaitUserTool, makeCheckInboxTool } from './tools/role-inbox.js';
import { makeSetSceneTool, makeReadSceneTool, makePassTurnTool } from './tools/scene-tools.js';
import { assertRoleToolsRegistered } from '../agent/cast.js';
import { makePublishSiteTool } from './tools/publish-site.js';
import { makeReportIssueTool } from './tools/report-issue.js';
import { makeRollFilmTool } from './tools/roll-film.js';
import { makePaintStillTool } from './tools/paint-still.js';
import { makeLookupTagsTool } from './tools/lookup-tags.js';

/**
 * 创建 Nodesign 的 MCP server，绑定当前 run 的依赖。
 *
 * @param {object} deps
 * @param {string} deps.workspaceRoot       绝对路径，project workspace（sessions/<sid>/）
 * @param {string} [deps.sharedRoot]        project shared/ 根（跨 session 共享 assets / .claude）
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]          NoDesign sessionId（活跃产物指针 / 会话级锁 / 出处记账用）
 * @param {import('../agent/context.js').AgentContext} [deps.ctx]  EventBus 入口
 * @returns SDK MCP server config（喂给 query options.mcpServers）
 */
// 常驻 schema 白名单（2026-07-23 订阅模式 token 瘦身）：
// 高频 + schema 小的工具第一 turn 就注入 prompt；不在名单里的走 SDK 默认
// deferred —— system prompt 只留工具名，agent 用 ToolSearch 按需拉 schema
// （需要 ENABLE_TOOL_SEARCH=true + allowlist 含 ToolSearch，见 session-loop）。
// 实测 defer 掉 generate_image/web_search/remove_background 等 6 个胖工具
// 省 ~80k 字符常驻 schema。prelude 的工具速查表仍列全部工具名 + 一句话用途，
// agent 知道存在什么、需要时先 ToolSearch("select:mcp__nodesign__<tool>")。
// （kimi 时代曾全局 alwaysLoad —— kimi 不认 ToolSearch；claude 系模型原生受训，可放心 defer）
const ALWAYS_LOAD_TOOLS = new Set([
  'screenshot_canvas', 'read_page', 'list_pages', 'query_elements',
  'get_computed_styles', 'navigate_to_page', 'highlight', 'preview_deck',
  'get_pending_changes', 'clear_pending_changes',
  // screenshot_url 常驻：explorer 显式 tools 列表没有 ToolSearch，defer 了它就
  // 永远拉不到 schema；schema 本身很小（4 字段），常驻成本可忽略
  'screenshot_url',
  // ⭐ 浏览通道六件（2026-08-18 当天从 deferred 改常驻；08-21 加到九件，见下）。
  //
  // 它们最初跟着「新工具默认 deferred」的习惯走，而那条习惯的依据是**成本**：
  // defer 掉的是 expose_tweaks / paint_still / roll_film 那种十万字符级的胖子。
  // 这六个实测 description 合计 4980 字符、连参数区 ≈ 6.9k —— 比那几个小
  // 30~100 倍，塞进被缓存的 system prompt 每轮增量约等于零。
  //
  // 而 deferred 的代价是具体的：agent 只看得到**名字**。`browser_capture`
  // 这个名字一个字都没说它能带回调色板、字体、命中的 CSS 规则和结构三数 ——
  // 于是它不会去搜这个 schema，做 deck / 做文档的会话里整条浏览通道等于不存在
  // （只有加载了 site-craft skill 才会被点名）。**名字自解释的工具可以 defer，
  // 卖点藏在描述里的不能。**
  'browser_navigate', 'browser_read', 'browser_click', 'browser_screenshot',
  'browser_request_help', 'browser_capture',
  // 08-21 加的三件（坐标/引用级操作 + 词法找元 + 一次往返跑一串）。同一条理由：
  // browser_batch 的卖点"省掉模型往返"和 browser_find 的"ref 比像素稳"都在描述里，
  // 名字本身不卖；三件描述合计 ≈ 5.5k 字符，缓存里每轮增量约等于零。
  'browser_computer', 'browser_find', 'browser_batch',
  // 08-21 产物会话五件：成品检查的交互半边（状态跨调用留着）。artifact_batch 的卖点
  // "一趟跑完 + 结尾截图"和 live:true 的存在都只在描述里说，常驻。
  'artifact_open', 'artifact_computer', 'artifact_find', 'artifact_batch', 'artifact_motion',
  // ⭐ 板面核心五件（2026-08-27 用户拍板「板书是基础交互方式」）：合计约 3.4k token
  // 的描述量进缓存前缀，每轮增量趋零；换来的是 write 的件数判据/lane/ink、edit 的
  // 18 个 op、batch 的按拍打包这些**只活在描述里的卖点**每回合都在场 —— 此前它们
  // 全在 deferred 区，agent 只看得到名字，教义在 prelude 里教、schema 却要现搜。
  // 膨胀由模式闸控：rp 模式 unregister 掉 artifact/量具族后常驻集自动收缩。
  // read_user_view 不进：视口已经每回合自动进状态块，它降级成"看画面细节"的按需件。
  'write_on_board', 'edit_board', 'read_board', 'board_batch', 'look_at_board',
]);

/**
 * 常驻表的启动期对账（08-27 审计补）：跟 mode-profile 同病同药 —— 工具改名后
 * 这张表的旧名字不会报错，只会让那件工具静默退回 deferred（agent 又只看得到名字）。
 * 对照的是**过滤前**的全量名单：能力/模式闸下架某件时它照常在 builtTools 里。
 */
function assertAlwaysLoadNames(registeredNames) {
  const have = new Set(registeredNames);
  const ghosts = [...ALWAYS_LOAD_TOOLS].filter((n) => !have.has(n));
  if (ghosts.length) {
    throw new Error(`[always-load] 常驻表里有注册表不存在的名字: ${ghosts.join(', ')} —— 改名后表没跟上，这些条目在静默空转`);
  }
}

export function createNodesignMcpServer({ workspaceRoot, sharedRoot, projectId, sessionId, ctx, roleRoster = null, projectMode = 'design' } = {}) {
  // 浏览通道里能被 browser_batch 串起来的七件：先建一次，batch 拿**同一批实例**
  // （projectId/ctx 绑在 handler 里，不能再造第二份）。只有 request_help 不进
  // batch（它阻塞等人）；capture 在里面 —— 逐页采 token 正是 batch 要省的那种回合。
  // batch 的运行时解析表（2026-08-27 重置）：装配管线（能力闸/模式闸/消毒）跑完后
  // 回填，三个 batch 的子调用一律取**包装后**的实例 —— 08-26「batch 绕闸」挂账在此清账。
  const wrappedByName = new Map();
  const resolveTool = (n) => wrappedByName.get(n);
  const writeOnBoard = makeWriteOnBoardTool({ projectId, sharedRoot: workspaceRoot || sharedRoot, sessionId, ctx });
  const boardBatchable = [
    writeOnBoard,
    makeEditBoardTool({ projectId, sharedRoot, ctx }),
    makeReadBoardTool({ projectId, sharedRoot }),
    // create_on_board 08-27 铲成真转发别名（第三份 textBox + 第七套避让之死）
    makeCreateOnBoardTool({ write: writeOnBoard.handler }),
  ];
  const browseBatchable = [
    makeBrowserNavigateTool({ projectId, ctx }),
    makeBrowserReadTool({ projectId }),
    makeBrowserClickTool({ projectId }),
    makeBrowserScreenshotTool({ projectId, workspaceRoot }),
    // 采集：把可复用的东西（调色板/字体/CSS/结构骨架/截图）落进
    // assets/references/web/ + 出处 sidecar —— 下个会话还在
    makeBrowserCaptureTool({ projectId, workspaceRoot, sessionId, ctx }),
    // 坐标/引用级指针与键盘 + 词法找元（08-21，形状照 browser_toolset_20260801）
    makeBrowserComputerTool({ projectId, ctx }),
    makeBrowserFindTool({ projectId }),
  ];
  // 五个能骑到产物会话上（live:true）的量具：先建一次，artifact_batch 拿同一批实例
  const screenshotCanvas = makeScreenshotCanvasTool({ workspaceRoot, projectId, sessionId, ctx });
  const queryElements = makeQueryElementsTool({ workspaceRoot, projectId, sessionId, ctx });
  const getComputedStyles = makeGetComputedStylesTool({ workspaceRoot, projectId, sessionId, ctx });
  const explainStyle = makeExplainStyleTool({ workspaceRoot, projectId, sessionId });
  const traceMotion = makeTraceMotionTool({ workspaceRoot, projectId, sessionId });
  // 产物会话四件（engine/perception/session.js）：artifact_open / computer / find / motion
  const artifactSessionTools = [
    makeArtifactOpenTool({ projectId, workspaceRoot, sessionId }),
    makeArtifactComputerTool({ projectId }),
    makeArtifactFindTool({ projectId }),
    // 自己的产物靠什么在动：跟 browser_capture motion 同一份引擎（engine/motion/inventory.js）
    makeArtifactMotionTool({ projectId, workspaceRoot, sessionId }),
  ];
  const builtTools = [
      // C9 screenshot_canvas — playwright headless 截图 → image content block
      screenshotCanvas,

      // screenshot_url — 外部 URL 截图（2026-07-29）。explorer 找视觉参考不再
      // 只能 WebFetch 文本转述；主 agent 也能直接看参考站。http/https only。
      makeScreenshotUrlTool({ projectId, ctx }),

      // deliver_files — agent 挑好的产物直接进用户浏览器下载列表（emit run.download_ready）
      makeDeliverFilesTool({ workspaceRoot, projectId, sessionId, ctx }),

      // read_document — Word / Excel / PowerPoint 的读取口（2026-08-07）。
      // 普通 Read 读这三种只会拿到二进制乱码**而且不报错**，agent 会拿着空气
      // 往下干。PDF 不在此列：Read 原生支持，真跑验过。
      makeReadDocumentTool({ workspaceRoot, sharedRoot }),

      // 酒馆 JSON 读取口：预设/角色卡/世界书先摘要再取正文（Read 会被 460KB 预设撑爆）
      makeReadTavernJsonTool({ workspaceRoot, sharedRoot }),

      // C10 export_handoff — 复用 exports.js 的 buildHandoffZip，写到 workspace/exports/
      makeExportHandoffTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // cast_role — 把一张角色卡变成真的常驻子代理（2026-08-26 RP 线）。
      // 写 .claude/agents/rp-<id>.md，CLI 的 watcher 几秒后拾取就能派。
      // 角色是常驻的：派一次，之后靠 SendMessage 唤醒，它记得自己写过的一切。
      makeCastRoleTool({ workspaceRoot, sessionId, ctx, roster: roleRoster }),

      // await_user / check_inbox — 角色的收件箱（2026-08-26）。用户在画布上回角色的话
      // 直达它，不惊动主 agent。角色**主动来取**（服务端没法给子代理投消息），
      // await_user 挂着等 = 「像主 agent 一样对话」的形态。见 agent/inbox.js
      makeAwaitUserTool({ projectId, ctx }),
      makeCheckInboxTool({ projectId }),
      // 场务三件（2026-08-27 编排）：set_scene 只认主控，pass_turn 只认角色
      makeSetSceneTool({ projectId, ctx }),
      makeReadSceneTool({ projectId }),
      makePassTurnTool({ projectId, ctx }),

      // crystallize_skill — 把探索出来的方法论固化成用户自己的 skill + 作品进橱窗
      // （2026-07-30）。用户明确要求才调；写的是判断依据不是成品 HTML。
      makeCrystallizeSkillTool({ projectId, sessionId, ctx }),

      // publish_site — 站点一键上线 Cloudflare Pages（2026-08-02）。用户明确要求
      // 才调（发公网是外发动作）；额度按项目 owner 算，与站点窗按钮共用一套闸门。
      makePublishSiteTool({ projectId }),

      // roll_film — 自部署 MiniMax-H3 视频产线（2026-08-08）。默认走站主 5090
      // 盒子（h3box over SSH；Modal 余额告急降备用档，NODESIGN_FILM_BACKEND=modal
      // 显式才走，绝不自动回退烧余额）；配方恒定 Turbo8步 ≤12.25s；试用号拒
      // （owner 闸门同 publish_site）。视觉 QC 归用户，工具只回文本路径。
      makeRollFilmTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // paint_still — 站主本地 GPU 盒子生图（NoobAI/Anima，2026-08-08）。盒子
      // 在线才可用（NODESIGN_H3BOX_SSH）；动漫向/视频关键帧首选，通用生图仍走
      // generate_image。视觉 QC 归用户。
      makePaintStillTool({ workspaceRoot, sharedRoot, projectId, sessionId, ctx }),

      // lookup_tags — danbooru 标签画前查询（2026-08-20）。paint_still 画完的体检
      // 只能事后说"这批图别信"；这个把查的动作挪到画前，配手册的起手纪律
      // （先理解用户要什么 → 想候选标签 → 查 → 再画）。薄壳，逻辑与体检共用
      // lib/danbooru-tags.js。deferred：名字自解释，且 paint_still 描述里点了名。
      makeLookupTagsTool(),

      // report_issue — agent 给维护者写信（08-02 由 report_friction 扩容改名）：
      // bug / friction / idea 三类走同一张 issues 表。跟 PostToolUseFailure 的
      // 自动记录分工：自动层记"发生了什么"，这层补"为什么难受、期望怎样"。
      makeReportIssueTool({ projectId, sessionId, ctx }),

      // web_search — 4 provider 联网搜索（baidu/tavily/exa/zhipu，CJK auto route to baidu）
      // 移植自 ~/.deskclaw/skills/deskclaw-search-pro/scripts/search.py，0 外部依赖。
      // WebFetch 不在这里 — 用 SDK 内置（session-loop.js DEFAULT_TOOL_ALLOWLIST 启用），
      // 它自带 LLM summarize 能控制上下文，不需要自实现。
      withTierGate(makeWebSearchTool({ workspaceRoot, sharedRoot, ctx }), 'webSearch', projectId),   // basic 档有日上限

      // S1c canvas 焕新升级 — read_page 让 agent 精确读 canvas.html 任意页
      // （`<section data-page="N">` 一段），不必 Read 整文件 + Grep + offset/limit。
      // 解 2026-05-02 用户观察"agent 只看第一页"痛点。
      makeReadPageTool({ workspaceRoot, sessionId, ctx }),

      // ── Canvas 焕新 C1（2026-05-02）：完整 agent "感知 + 操作" 工具链 ──
      // 感知层：list_pages / query_elements / get_computed_styles —— playwright
      // headless 跑出来真实 render 后的元数据，agent 不再盲改
      makeListPagesTool({ workspaceRoot, projectId, sessionId, ctx }),
      queryElements,

      // profile_scroll — 滚动性能量具（2026-08-18）。用户说"一顿一顿"时 agent
      // 以前手里零工具，只能自己起 http server 手搓 rAF 采样。不进常驻工具表
      // （deferred，用得上时自然搜到），schema 不白占每轮上下文。
      makeProfileScrollTool({ workspaceRoot, projectId, sessionId }),

      // explain_style — CSS 级联诊断（2026-08-18）。computed 只给结果不给原因，
      // 而 agent 手里没有 devtools 的 Styles 面板。同样走 deferred。
      explainStyle,

      // trace_motion — 动画数值示波器（2026-08-19，iss_mszv782a_toab）。缓动/过冲/
      // 硬切从"看静帧猜"变成逐帧采样量出来。deferred：名字自解释，且常驻的
      // screenshot_canvas 描述里点了名（胶片条管看、这个管量）。
      traceMotion,

      // ── 浏览通道（2026-08-18）：agent 真的会用浏览器 ──
      // 常驻一个 chromium（按项目键、带持久 profile），所以能点链接、翻子页、
      // 留住登录态。跟 screenshot_url 的分工：那个是一次性一张图，这组是有会话的逛。
      // ⭐ 每个请求都过 lib/ssrf-guard.js 的出网闸（含跳转每一跳、iframe、子资源），
      // 闸在工具实现体里，agent 关不掉。**全部常驻**（理由见 ALWAYS_LOAD_TOOLS）。
      //
      // ⚠️ 刻意**没给 explorer 子代理**：registry 按 projectId 键 = 主 agent 和
      // 子代理共用同一只浏览器、同一个 page。mutex 保证不撕裂，但保证不了不抢 ——
      // 子代理一导航就把主 agent 正在看的那一页带走了，症状是"我刚打开的页面
      // 自己变了"。要给的话得先有"借用后还原"（存 URL、用完 goto 回去），
      // 或者第二个常驻名额；1 vCPU 上后者不成立。
      ...browseBatchable,
      // 一次往返跑一串（串行、遇错即停、结尾补截图）—— 省的是模型回合数
      makeBrowserBatchTool({ tools: browseBatchable, resolve: resolveTool }),
      // ── 产物会话（2026-08-21）：成品检查的交互半边 ──
      // artifact_open 把产物开进常驻会话，artifact_computer/find 对着它点、敲、找；
      // 五个量具 live:true 就量会话里现在这一页；artifact_batch 一趟跑一串。
      ...artifactSessionTools,
      makeArtifactBatchTool({ tools: [...artifactSessionTools, screenshotCanvas, queryElements, getComputedStyles, explainStyle, traceMotion], resolve: resolveTool }),
      // 撞验证墙时举手叫人（阻塞等，默认 120 秒超时 —— 人可能就走了）
      makeBrowserRequestHelpTool({ projectId, ctx }),
      getComputedStyles,

      // 控制层：emit 反向事件给前端，server 主动操作 canvas UI
      makeNavigateToPageTool({ ctx }),
      makeHighlightTool({ ctx }),
      // 把 deck 摊到用户眼前（= 用户双击那张卡）：收起态→内嵌渲染，展开态→最大化窗
      makePreviewDeckTool({ ctx, sessionId, workspaceRoot }),

      // word 形态的构建道：token JSON（真相源）→ .docx（产物）。
      // agent 拿到的是一条命令不是一个构建系统 —— 写 JSON、调它、再 screenshot 看。
      makeBuildDocxTool({ workspaceRoot, sessionId, ctx }),

      // 反馈层：用户在 canvas 上的直接编辑 + 评论 buffer
      // 前端在 chat 时由 turn.js 注入 system 提示，agent 主动调下面两个工具读 + 清
      makeGetPendingChangesTool({ workspaceRoot, ctx }),
      makeClearPendingChangesTool({ workspaceRoot, ctx }),

      // 图片生成（gemini-3.1-flash-image-preview / Nano Banana 2，via NoDesk passthrough）
      // 落档优先 sharedRoot/assets/generated/，fallback workspaceRoot/assets/generated/。
      // 跨 session 共享靠 sessions/<sid>/assets softlink → shared/assets。
      withTierGate(makeGenerateImageTool({ workspaceRoot, sharedRoot, ctx }), 'imageGen', projectId, ctx),   // 先过日限，出图记 $0.20/张

      // 抠图（rembg U²-Net，server 端 spawn .venv-rembg python subprocess）
      // 任何 workspace 里的图都能抠，输出 RGBA PNG 到 assets/generated/<name>.png。
      // 跟 generate_image 解耦：generate_image 只生图，想透明叠加单独调本工具。
      makeRemoveBackgroundTool({ workspaceRoot, sharedRoot, projectId, ctx }),

      // 工作台分区画布（2026-07-27）：agent 协助摆放 —— 把产物/文档/deck 钉进
      // 某 session 的工作区。写 board.json（board-store 单锁）+ 广播 board.updated。
      makePinToBoardTool({ sharedRoot, projectId, ctx }),

      // 关系线（2026-08-07）：agent 把「这版改自那版」「这两个是对照」这类
      // **只有它知道**的关系画到画布上。画布知道每个产物是什么，但不知道它们
      // 之间是什么关系 —— 那是北极星（排出有版面感的布局）真正缺的那一块。
      makeRelateOnBoardAlias({ sharedRoot, projectId, ctx }),
      // 黑板核心四件（08-25 范式重做）：写=write_on_board（件数判据分流一句话/
      // 一张图），改=edit_board（吞 arrange/finish/relate/edit_sketch），看=read，
      // 记号=create。board_batch 用**同一批实例**串行跑（一章 RP 的板面维护
      // 八次往返收成一次）。旧名薄别名一版防 resume。
      ...boardBatchable,
      // board_batch（2026-08-27 重置）：覆盖全板面家族 + 运行时解析（resolve）。
      // 一个思考单位的板面维护 = 一次 batch，这是板面工具的**首选入口**。
      makeBatchTool({
        name: 'board_batch',
        description: `Run several board actions in ONE round-trip — the unit of board upkeep.
One beat of thinking = one batch: read_board first if you have not looked this turn,
then write/edit/pin/organize in order, and pass screenshotAfter:true when looks matter.
Actions run in order; a failure stops the rest (already-ran steps are NOT rolled back —
continue from the failed step). Later steps can use what earlier steps made: chain:true
threads onto the note a previous step wrote (same tag); sketch local ids resolve in
edit_board ops.
Placement and lines are ONE language — put a thing where its relation says (same lane =
chain below, fork = open_lane column, comment = near+side) AND draw the line that says
it; a note with no line and no lane is one nobody can trace back.
Batchable: write_on_board / edit_board / read_board / create_on_board / pin_to_board /
organize_board / finish_sketch / look_at_board / read_user_view.
Example: [{"name":"read_board","input":{}},{"name":"write_on_board","input":{"text":"…",
"tag":"主线","chain":true}},{"name":"edit_board","input":{"ops":[{"op":"add_edge",
"from":"notes/板书/x.md","to":"assets/图.png","type":"link"}]}}]`,
        resolve: resolveTool,
        batchable: [
          ...boardBatchable.map(t => t.name),
          'pin_to_board', 'organize_board', 'finish_sketch', 'look_at_board', 'read_user_view',
        ],
        finalShot: { name: 'look_at_board', input: {}, default: false },
      }),
      makeArrangeOnBoardAlias({ projectId, sharedRoot, ctx }),
      makeOrganizeBoardTool({ projectId, ctx }),
      makeSketchOnBoardAlias({ projectId, sharedRoot: workspaceRoot || sharedRoot, sessionId, ctx }),
      makeFinishSketchTool({ projectId, ctx }),
      makeEditSketchAlias({ projectId, sharedRoot, ctx }),
      makeLookAtBoardTool({ projectId, ctx }),
      makeReadUserViewTool({ projectId }),

      // 注：Phase Image-2 的 request_image_approval 工具已废弃（2026-05-06）。
      // generate_image 的 CallToolResult 已返 image content block，前端自动渲染；
      // agent 在 caption / 自然回话邀请反馈，下一轮用户 chat 即天然 gate。
  ];

  // 模式对照表的启动期对账（2026-08-27）：必须对**过滤前**的全量名单 —— 表校验的
  // 对象是「注册表里有没有这个名字」，跟本机能力/项目模式无关。工具改名后表没跟上
  // 时这里当场炸，不让下架条目静默空转（判据本身要先验一遍）。
  assertModeProfileNames(builtTools.map((t) => t.name));
  assertAlwaysLoadNames(builtTools.map((t) => t.name));

  const tools = builtTools.filter((t) => (
    // 本机能力缺席且该工具是 unregister 档 → 整件不注册（连名字都不进上下文）。
    // 现在只有本地 GPU 盒子那两件：盒子手动开关，关着时留名字只会让 agent 去撞
    // SSH 拒连。对照表在 capability-gate.js 一份。
    shouldRegisterTool(t)
  )).filter((t) => (
    // 项目模式闸（2026-08-27）：rp 项目下架设计产线（deck/站点/交付/产物量具），
    // 同样是 unregister 语义。对照表在 mode-profile.js 一份，下面还有启动期对账。
    shouldRegisterForMode(t, projectMode)
  )).map((t) => (
    // SDK 用 _meta['anthropic/alwaysLoad'] 标记常驻（tool() 第 5 参的等价物，
    // 集中在这打标避免改 16 个工具文件）
    ALWAYS_LOAD_TOOLS.has(t.name)
      ? { ...t, _meta: { ...t._meta, 'anthropic/alwaysLoad': true } }
      : t
  )).map((t) => (
    // 本机能力闸（08-22）：缺 chromium / LibreOffice / 钥匙 的工具，描述前缀「不可用 + 装法」、调用期拦住。
    // 对照表在 capability-gate.js 一份；没探过（单测）原样放行
    withCapabilityGate(t)
  )).map((t) => (
    // 参数标签泄漏消毒（2026-08-19）：上游偶发把下一个参数吞进上一个字符串参数
    // （</rationale><parameter name="scope">… 原样落进 tool_use.input，会话
    // 008fe16c 4/4 实锤）。挂在出口包全部工具 —— 哪个工具中招看 recordIssue。
    withParamSanitizer(t, { projectId, sessionId })
  ));

  // batch 解析表回填：此刻 tools 里的实例已过完 能力闸/模式闸/alwaysLoad/消毒 全套
  for (const t of tools) wrappedByName.set(t.name, t);

  // 角色工具白名单的启动期对账（2026-08-26）：cast_role 会把白名单里的短名写进
  // 角色文件的 frontmatter，名字写错**不会报错**，只会让角色少一只手（CLI 当那个
  // 工具不存在）。所以对着真实注册表核一遍，错了当场炸在启动期。
  assertRoleToolsRegistered(new Set(tools.map((t) => t.name)));


  const server = createSdkMcpServer({
    // 名字收在 mcp/server-name.js：它同时是 session-loop 里 mcpServers 的键
    // （决定模型看到的 mcp__nodesign__* 前缀）和 isolation.js 那条 allow 规则要匹配的名
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    tools,
  });
  // 开局契约自检用（2026-08-14 灭门案第 3 层）：预期工具名从构造本 server 的
  // 同一份 tools 数组上取，不另立第二份清单 —— 第二真相源会漂移。session-loop
  // 收到 system:init 时拿它跟 SDK 实际注册进会话的工具对账。
  server.toolNames = tools.map((t) => t.name);
  return server;
}
