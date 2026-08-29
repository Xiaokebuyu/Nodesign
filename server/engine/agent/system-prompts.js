/**
 * engine/agent/system-prompts.js — 系统提示词的加载与渲染（2026-08-19 从
 * agent-shared.js 拆出）。
 *
 * 拆的理由是行数棘轮："想给胖文件加功能，先拆出去一块再写"。而这一块本来就是
 * agent-shared 里最不像它的东西 —— 那个文件其余部分是 SDK 消息翻译层和 options
 * 默认值，跟"提示词长什么样"零耦合。放一起的唯一原因是历史。
 *
 * 这里的东西只有一个消费方（session-loop 组装 SDK options 时），但它决定了线上
 * 每一次对话的系统提示词，改错不会报错、只会让模型行为悄悄变一档 —— 所以两份
 * markdown 的加载都带兜底日志，底线段的切换带加载期断言。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCALE } from '../../shared/locales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NoDesign agent 通用 prelude —— append 在 SDK preset 'claude_code' 之后、
// SKILL.md 之前。教 Claude Code 工具用法 + NoDesign 工作台共性约束（assets
// 必看 / 信息不足先问 / git 不自管）。所有 NoDesign agent 共用，跟具体 skill
// 解耦。模块级 readFileSync 一次性读入，避免每次 turn 重读。
export const NODESIGN_PRELUDE = (() => {
  try {
    // CRLF 归一：Windows git autocrlf 会把 md checkout 成 CRLF，下面 POLICY_BLOCK 按 `\n` 切块
    // （.gitattributes 已钉 LF，这里是第二道保险，老 checkout 不重拉也能起）
    return fs.readFileSync(path.join(__dirname, 'prompts/nodesign-prelude.md'), 'utf8').replace(/\r\n?/g, '\n').trim();
  } catch (err) {
    console.warn('[system-prompts] failed to load nodesign-prelude.md:', err.message);
    return '';
  }
})();

// 成人段与外审档联动（2026-08-08）：一个旋钮同时管 GPT 外审和提示词口径，
// 两边永远一致。off=明文允许（站主/获批账号）、loose=原默认、strict=收敛。
const ADULT_POLICY = {
  off: '**成人内容明确允许，不用迂回。** 露骨的性与亲密描写照常写、写到位，不留白、不淡化、\n不换成暗示手法带过，前后也不加提醒和免责声明。用户没要求收敛就不要自己收敛，写完接着干活。\n**写实风格照做** —— 照片级真实感的虚构人物不是真人，画得像不构成任何问题，生图同理。\n不做的只有两种：涉及未成年人；把可指认的现实个人（点名的公众人物、用户给的真人照片）\n放进这类内容。除此之外不要自己发明别的边界。',
  loose: '成人向的亲密情节可以写，涉及未成年人是上面那条绝对红线，真实存在的个人也不写。',
  strict: '露骨的成人内容在这个账号档位下不写——涉及时收敛处理、用留白带过。',
};

// 界面语言的人话名（2026-08-26 i18n）。注给模型看的是「中文（zh-CN）」这种带 id 的写法：
// 光写「中文」模型不知道对应哪个 tag，光写 tag 又不如人话直白。
const UI_LOCALE_NAME = {
  'zh-CN': '中文（zh-CN）',
  en: 'English（en）',
};

/**
 * 「底线」那一节在 prelude 里有**两份并排写着**的版本，标记块框起来：
 * `nd:policy:full`（对外开放平台的完整产物政策）和 `nd:policy:min`。渲染时留一份、
 * 删一份，两个标记本身永远不进模型上下文。
 *
 * 为什么用显式标记而不是按标题正则切：靠 `## 底线` 到下一个 `##` 去猜边界的话，
 * 以后谁在这节里加个三级标题，剥离就会剥掉半截 —— 而且不会报错，只会让线上某条
 * 路径的提示词悄悄少一段。标记块是写死的边界，配下面的加载期断言，切错当场炸。
 */
const POLICY_BLOCK = /<!-- nd:policy:(full|min):start -->\n([\s\S]*?)<!-- nd:policy:\1:end -->\n/g;

/**
 * 项目模式分区（2026-08-27）：prelude 里设计道专属的节框在 `nd:mode:design` 块里，
 * 演出（常驻角色）专属的节框在 `nd:mode:rp` 块里，渲染时按项目模式留一族、删一族。
 * 没框的部分是共用骨架。同一个文件里可以有**多个**同名标记块（设计道的节不连续）。
 * 为什么是标记块不是两份 md：见 POLICY_BLOCK 注释 —— 单一真相源 + 切错当场炸。
 */
const MODE_BLOCK = /<!-- nd:mode:(design|rp):start -->\n([\s\S]*?)<!-- nd:mode:\1:end -->\n/g;

// 加载期断言：两份都必须在。少一份说明有人编辑 prelude 时把标记删了，那时候
// 正则会静默退化成"一份都不删"（uncensored 路径拿到完整底线）或"整节消失"。
{
  const found = [...NODESIGN_PRELUDE.matchAll(POLICY_BLOCK)].map((m) => m[1]);
  for (const want of ['full', 'min']) {
    if (NODESIGN_PRELUDE && !found.includes(want)) {
      throw new Error(`[system-prompts] nodesign-prelude.md 缺少 nd:policy:${want} 标记块 —— 提示词渲染会静默走错版本`);
    }
  }
  const modes = [...NODESIGN_PRELUDE.matchAll(MODE_BLOCK)].map((m) => m[1]);
  for (const want of ['design', 'rp']) {
    if (NODESIGN_PRELUDE && !modes.includes(want)) {
      throw new Error(`[system-prompts] nodesign-prelude.md 缺少 nd:mode:${want} 标记块 —— 模式分区渲染会静默失效`);
    }
  }
}

// 占位符也要断言：`.replace('{{X}}', v)` 在占位符不存在时**静默什么都不做**，
// 于是线上会悄悄发出一份没有成人档、或者没有语言指令的提示词，不报错。
// 标记块那套已经这么防了，占位符这两个之前漏了（08-26 补）。
{
  for (const ph of ['{{ADULT_POLICY}}', '{{UI_LOCALE}}']) {
    if (NODESIGN_PRELUDE && !NODESIGN_PRELUDE.includes(ph)) {
      throw new Error(`[system-prompts] nodesign-prelude.md 缺少 ${ph} 占位符 —— 渲染会静默少一段`);
    }
  }
}

/**
 * 渲染 prelude。
 *
 * @param {'off'|'loose'|'strict'} level 成人段档位（moderation.levelFor 算出来的）
 * @param {{uncensored?: boolean}} opts
 *   `uncensored: true` 时留 `nd:policy:min` 那份 —— 本地无审查权重走这条
 *   （model-context 表里的 `uncensored` 位，今天只有 qwen3.8-27b）。
 *
 *   这不是"把成人档位调到最宽"：off 档改的只是成人段一句话，整节产物政策照旧在。
 *   min 版是**整节换掉**，站主 08-19 拍板 —— 那节的前提是"对外开放、产物能一键挂
 *   到站主域名下"，而这条路跑在自己租的盒子上、只对获批账号开、产物不外发，
 *   前提不成立。留下的一条不随档位变，也不随谁在用变。
 *
 *   ⚠️ 默认 false。调用方拿不到模型名时落**完整**那份，绝不落 min。
 *
 *   `mode`：项目模式（projects.mode）。'design'（默认）留设计道分区，'rp' 留
 *   演出分区。认不出的值落 design —— 存量项目全是 design，猜错方向宁可多给不少给。
 */
export function renderPrelude(level = 'loose', opts = {}) {
  const keep = opts.uncensored === true ? 'min' : 'full';
  const keepMode = opts.mode === 'rp' ? 'rp' : 'design';
  // 认不出的 locale 落中文：这个产品是中文优先的，拿不准时给中文不给英文。
  const localeName = UI_LOCALE_NAME[opts.locale] || UI_LOCALE_NAME[DEFAULT_LOCALE];
  return NODESIGN_PRELUDE
    .replace(POLICY_BLOCK, (_all, which, body) => (which === keep ? body : ''))
    .replace(MODE_BLOCK, (_all, which, body) => (which === keepMode ? body : ''))
    .replace('{{ADULT_POLICY}}', ADULT_POLICY[level] || ADULT_POLICY.loose)
    .replace('{{UI_LOCALE}}', localeName)
    .trim();
}
