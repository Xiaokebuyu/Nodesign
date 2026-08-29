/**
 * PreToolUse 首调注入族 —— 各工具的 reference 文档 / 起手提醒，agent 首次调
 * 对应工具时才进 context（不放系统 prompt 恒驻，每 turn 拖累）。
 * （2026-08-14 可维护性行动：从 hooks.js 原样迁出，语义零改动）
 *
 * 共同模式：closure 里一个 alreadyInjected 布尔（或 per-kind Set），每 session
 * 只注一次；permissionDecision='allow' 不阻塞工具。
 */
import path from 'node:path';
import { toWorkspaceRel } from '../../../lib/workspace-path.js';
import { kindOfPath, kindDef, KIND_DECK } from '../../../lib/artifact-target.js';
import { loadToolPrompt } from './tool-prompts.js';

/**
 * PreToolUse(get_pending_changes) — 第一次调用时注入 DirectEdit 逐 kind
 * 处理协议全文（字段结构 / pending-move 语义 / 邻居保护 / preDragLayout /
 * constraint anchor 表）。prelude 常驻部分只留流程骨架 + 语义底线三条，
 * ~90 行细则在 agent 真的要处理 pending changes 时才进 context。
 */
export function makePreToolUseGetPendingChangesProtocolInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const protocol = loadToolPrompt('direct-edit-protocol');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[DirectEdit 逐 kind 处理协议 — 首次注入]\n\n'
        + protocol
        + '\n\n本协议每 session 只注入一次，后续处理 pending changes 直接按它做。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(AskUserQuestion) — 第一次问用户时注入 NoDesign 的问法协议
 * （何时用卡片 vs chat、schema、写选项的诀窍、preview 字段的两种形态与限制）。
 * 常驻在 prelude 里是 1.2k tokens，但一次会话里可能一次都用不上。
 */
export function makePreToolUseAskUserQuestionProtocolInjector() {
  // 08-28 用户拍板还原：撤掉 08-27 的「提问上板」deny 闸，AskUserQuestion 走回
  // 侧栏卡片本职。上板问选择仍然可以（nd:controls 是现役件），但那是 agent 的
  // 版面选择，不再由闸强制。
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const protocol = loadToolPrompt('ask-user-question-protocol');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[AskUserQuestion 协议 — 首次注入]\n\n'
        + protocol
        + '\n\n本协议每 session 只注入一次，后续问用户直接按它写。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(Write) — 第一次写 .html 时注入该形态的技术参考。
 *
 * 2026-07-28 加站点后按 kind 分流：以前是"任何 .html 都注入 hybrid deck 参考"，
 * 于是 agent 写站点首页时会被塞一份讲 `data-page` / `__nd-deck-wrap` / babel 的
 * 文档 —— 文不对题，还会诱导它往站点里塞 deck 专属结构。
 *
 * 两种形态各注一次（一个会话理论上只做一种，但试作阶段可能先摸另一种）。
 */
export function makePreToolUseHybridReferenceInjector({ workspaceRoot } = {}) {
  const injected = new Set();
  return async (input, _toolUseId, _options) => {
    const fp = input?.tool_input?.file_path;
    if (typeof fp !== 'string') return {};
    const rel = workspaceRoot ? toWorkspaceRel(fp, workspaceRoot) : fp;
    const kind = workspaceRoot ? await kindOfPath(workspaceRoot, rel) : KIND_DECK;
    // 触发条件从「写 .html」改成「写的文件跟这个形态的入口同类型」（2026-08-01）。
    // 写死 .html 的年代只有 deck 和 site，两者入口都是 html 所以恰好没错；非 html 入口的形态
    // 的入口不是 .html，于是它的技术参考**永远不会被注入**，agent 一辈子不知道
    // 目录结构该长什么样。扩展名从注册表的 entryFile 推，加形态不用再回来改。
    const wantExt = path.extname(kindDef(kind)?.entryFile || '.html').toLowerCase();
    if (path.extname(fp).toLowerCase() !== wantExt) return {};
    if (injected.has(kind)) return {};
    injected.add(kind);
    // 技术参考按注册表分发（kinds/<kind>.referenceDoc）—— 新形态自带自己那份
    const meta = kindDef(kind)?.referenceDoc || kindDef(KIND_DECK).referenceDoc;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          `<system-reminder>\n[${meta.title} — 首次注入]\n\n`
        + loadToolPrompt(meta.file)
        + '\n\n本参考每 session 每形态只注入一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

// paint_still 首调注入本地生图手册：四模型选型 + noobai 标签流 + FLUX.2 官方
// 提示词实践（BFL prompting guide 摘要）+ 装卸税排序纪律。
export function makePreToolUsePaintStillCookbookInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const cookbook = loadToolPrompt('paint-still-cookbook');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[paint_still 本地生图手册 — 首次注入]\n\n'
        + cookbook
        + '\n\n本手册每 session 只注入一次，后续调用直接照用。\n'
        + '</system-reminder>',
      },
    };
  };
}

// roll_film 首调注入 H3 提示词手册：三字段格式 + 多镜纪律（逐字角色块/同种子）
// + 禁视觉检查。模式与 generate_image cookbook 完全同款。
export function makePreToolUseRollFilmCookbookInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const cookbook = loadToolPrompt('roll-film-cookbook');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[roll_film H3 提示词手册 — 首次注入]\n\n'
        + cookbook
        + '\n\n本手册每 session 只注入一次，后续调用直接照用。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(generate_image) — 第一次调用时注 完整 cookbook（A-J 段）。
 *
 * 配套 SKILL.md 里的精简版 cookbook（5 元素公式 + 渲文字铁律 + 反例正例）保第一张
 * 图质量底线；本 hook 注入完整深度内容，让第二张起 agent 拿出更稳的 prompt。
 *
 * 触发：本 session 第 1 次调 generate_image；后续不再注入（避免 spam）。
 * 文件源：prompts/tools/generate-image-cookbook.md（模块加载时缓存）。
 */
export function makePreToolUseGenerateImageCookbookInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const cookbook = loadToolPrompt('generate-image-cookbook');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[generate_image 完整 cookbook — 首次注入]\n\n'
        + cookbook
        + '\n\n本 cookbook 每 session 只注入一次，已读完后续生图调用直接用即可。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(generate_image) — 第一次调用时提醒 agent 先 Read 目标页面。
 *
 * 设计原则 metadata-not-content：不预解析 canvas.html 注入页面 HTML，
 * 而是提醒 agent 自己 Read。避免"被注入摘要后反而不主动读"的反模式。
 *
 * 触发：本 session（hook 工厂调用一次 → closure 一份 alreadyReminded）内
 *      第 1 次调用 generate_image；后续不再注入。
 *
 * 不阻塞工具调用，permissionDecision='allow' 直接放行。
 */
export function makePreToolUseGenerateImageReadPageReminder() {
  let alreadyReminded = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyReminded) return {};
    alreadyReminded = true;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[generate_image 目标页提醒]\n\n'
        + '即将生成图片。如果还没看过目标页（deck 里对应的 <section data-page="N"> / 站点的那一页），建议先 Read 一下：\n'
        + '  - 页面尺寸（多少行 / 多大留给图）\n'
        + '  - 主色（design-tokens 里的 --bg / --accent / --hero）\n'
        + '  - 已有视觉风格（hybrid 范式有无 React 组件 / 已有图片调性）\n\n'
        + '多数情况下第一张图会被当 referenceImages 种子用于全 deck，看一眼能避免后续违和（暖色页塞冷调插图这类）。本提醒每 session 只触发一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(expose_tweaks) — 第一次调用时注 完整控件 schema 语法。
 *
 * SKILL.md 已有"何时暴露 / 暴露什么"哲学（5-8 个核心维度即可）；本 hook 注入完整
 * 控件类型 / target_var vs target_class_on / target_scope / Tailwind 桥接 / 常坑
 * 等参考语法，让 agent 写 controls JSON 时一次到位。
 *
 * 触发：本 session 第 1 次调 expose_tweaks；后续不再注入。
 * 文件源：prompts/tools/tweaks-syntax.md（模块加载时缓存）。
 */
export function makePreToolUseExposeTweaksSyntaxInjector() {
  let alreadyInjected = false;
  return async (_input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    alreadyInjected = true;
    const syntax = loadToolPrompt('tweaks-syntax');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[expose_tweaks 完整语法 — 首次注入]\n\n'
        + syntax
        + '\n\n本语法每 session 只注入一次。\n'
        + '</system-reminder>',
      },
    };
  };
}

/**
 * PreToolUse(Agent) — subagent_type='vision-checker' 时首次注 派遣 prompt 模板。
 *
 * 注：跟 makePreToolUseAgentForceForegroundHandler 共存于同一 'Task|Agent' matcher
 * 下，SDK 按数组顺序串行执行多个 hook。本 hook 仅在 subagent_type==='vision-checker'
 * 命中时注 dispatch 模板（含全 deck 自检 / 有 plan 时按计划 critique / 单页评审 3 模板）。
 *
 * ⚠️ 2026-08-03 修：原来读的是 `input.subagent_type`，而 PreToolUse 的 hook input
 * 形状是 `{ tool_name, tool_input, tool_use_id, ... }`（sdk.d.ts PreToolUseHookInput），
 * 工具入参在 **tool_input** 里 —— 顶层那个字段永远是 undefined，条件永远不成立。
 * 结果：历史上 6 次 vision-checker 派遣，模板一次都没注进去（jsonl 全量 grep 0 命中）。
 * 同文件的 force-foreground handler 一直读的是 `input?.tool_input`，是对的，
 * 这里当初抄漏了一层。
 *
 * 触发：本 session 第 1 次派 vision-checker；后续不再注入。
 * 文件源：prompts/tools/vision-checker-dispatch.md（模块加载时缓存）。
 */
export function makePreToolUseTaskVisionCheckerDispatchInjector() {
  let alreadyInjected = false;
  return async (input, _toolUseId, _options) => {
    if (alreadyInjected) return {};
    if (input?.tool_input?.subagent_type !== 'vision-checker') return {};
    alreadyInjected = true;
    const dispatch = loadToolPrompt('vision-checker-dispatch');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext:
          '<system-reminder>\n[vision-checker 派遣 prompt 模板 — 首次注入]\n\n'
        + dispatch
        + '\n\n本模板每 session 只注入一次。后续派遣按这套结构写 prompt 即可。\n'
        + '</system-reminder>',
      },
    };
  };
}
