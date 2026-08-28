/**
 * mcp/tools/cast-role.js — cast_role MCP tool（2026-08-26，RP 常驻角色线）
 *
 * GM（主 agent）把一张角色卡 / 一段人设**变成一个真的子代理**：写一份
 * `.claude/agents/rp-<id>.md`，之后就能 `Agent(subagent_type:"rp-<id>")` 把它派上场。
 *
 * ## 为什么是写文件，不是内存注册
 *
 * SDK 没有运行时改子代理定义的接口（`Query` 上没有 setAgents），但 CLI **在会话中途
 * 监视 `.claude/agents/`**：2026-08-26 实测，会话跑到一半写进去的角色文件，几秒后
 * 就能派出来，人设正文原样成为它的 system prompt。文件同时也是重启后的真相源。
 *
 * ⚠️ 目录必须在**会话启动前**就存在（watcher 只看会话开始时已有的目录）——
 * `ensureProjectWorkspace` 里已经建了 `.claude/agents`，这条不用工具操心，但改那边
 * 的人要知道有这个消费方。
 *
 * ## 一条反直觉的语义，工具返回里必须说清楚
 *
 * 改一个**已经在场**的角色的文件，不会改变它 —— 它的人设在派发那一刻就进了它自己的
 * 转录，之后只跟着消息走。改文件只对"下次派发"有效。所以 cast_role 对同名角色的
 * 第二次调用是"改剧本"，不是"改人"。
 *
 * nd:rp-prompt —— 工具描述与返回话术属于 RP 教义，等提示词层专门过一遍时一起调。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ROLE_PREFIX, isValidRoleSlug, resolveRoleTools } from '../../agent/cast.js';
import { MCP_SERVER_NAME } from '../server-name.js';
import { pushUnclaimedMessage } from '../../runs/turn-relay.js';

/** 角色 id（不含 rp- 前缀）：ASCII、能当文件名、能当 SendMessage 收件人名 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

const AGENTS_DIR = '.claude/agents';
const PERSONA_MAX = 20000;

/** frontmatter 里塞展示名的固定格式 —— 服务端按这个前缀反解（板书归属要用） */
export const ROLE_DESC_PREFIX = 'RP 角色';
export function parseRoleDisplayName(description) {
  // frontmatter 里 description 是带引号写的，反解时先剥引号
  const raw = String(description || '').trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"');
  const m = /^RP 角色「(.+?)」/.exec(raw);
  return m ? m[1] : null;
}

/**
 * 拼进 frontmatter 的值都来自模型，逐个猜哪些字符危险是猜不完的 —— CLI 那边是**真
 * YAML 解析**（`Bun.YAML.parse`），三种坏法各不相同：
 *   - `: ` 让解析抛错（CLI 有修复通路接住，侥幸没事）
 *   - ` #` 在 plain scalar 里开注释：**解析成功但值被截**，修复通路救不了（它只救抛错的）
 *   - U+2028/U+2029：抛错 + 修复正则的 `.` 不匹配行终止符 → 整份 frontmatter 退化成 `{}`
 *     → 缺 name/description → **整个角色被丢弃，只打一行 error log**（静默消失）
 * 所以不猜：把自由文本写成**带引号的 YAML 字符串**，危险字符一次全消。
 * （name/model/tools 不走这条 —— 它们是受控形状，各自有正则或白名单守着。）
 */
function oneLine(v, max) {
  return String(v ?? '')
    // 行终止符全清（\u2028/\u2029 在 JS 正则里算行终止符，YAML 那边会炸掉整份 frontmatter）
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')     // 其余控制字符
    .replace(/[「」]/g, '')                        // 展示名的分隔符，留着能骗过反解
    .trim().slice(0, max);
}

/** YAML 双引号字符串：反斜杠和引号转义，其余原样（`#`、`:` 在引号里都是普通字符） */
function yamlQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 笔权台规（2026-08-27）：harness 钉在每张角色卡尾部，**不指望 GM 抄进 persona**。
 * 病根：角色很容易自顾自写出「第三人称环境描写 + 第一人称台词」的混合体 ——
 * 环境是旁白的笔，替别人写反应是代笔。接续权闸管得住板上的接续，管不住一块板书
 * 内部的混笔，所以这条只能长在角色自己的系统提示词里。跟日记体例同范式：机制锁、体例放。
 * 两支笔：character（演一个人）/ narrator（写场面的旁白角色 —— 硬禁环境会禁死它）。
 */
const PEN_FOOTERS = Object.freeze({
  character: [
    '## 笔权（台规，不是人设）',
    '',
    '你的笔只写你自己：你说的话、你做的动作、你心里想的，一律**第一人称**。以下不归你的笔：',
    '- 环境与场面（天色、房间、路人、气氛）—— 那是旁白的笔。动作做出去就停，世界怎么响应等别人接。',
    '- 其他角色的话和反应 —— 一个字不替写。想要谁回应，就在戏里对他说。',
    '- 全知视角的推进（「与此同时」「谁也没注意到」）—— 你只知道你的角色知道的。',
    '',
    '一块板书 = 你的一拍：这一拍说完就停笔，别一个人把整场写完。',
    '',
    '上板的落位规矩（2026-08-27 版式）：**回谁的话就 reply_to 谁**（那条板书的路径），',
    '话挂在它回应的话旁边，戏在板上才有形状；自顾自续自己的叙事线用 chain。',
    '轮次（rounds）场里别给 near/at/side —— 桌位机器排，你只管写。',
    '',
    '等着的时候收到「（台上动了：…）」是广播不是点名：带场况条目就**按场况演**，',
    '原文只在要引用原句时才去读。你的角色**此刻真会开口才接**（reply_to 指它），',
    '多数时候正确的动作是接着 await_user 听下去。别每条都回 —— 抢话的群演比沉默的群演更出戏。',
    '',
    '文风防火墙：旁白是另一支笔。你从它那里只继承**事实**（谁在哪、做了什么、说了什么），',
    '不继承它的句式、节奏、修辞 —— 你的语气只来自你的人设和你自己写过的话。',
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

function composeRoleCard({ slug, displayName, duty, tools, model, persona, pen }) {
  const desc = `${ROLE_DESC_PREFIX}「${oneLine(displayName, 40)}」。${oneLine(duty, 400)}`;
  const lines = [
    '---',
    `name: ${slug}`,
    `description: ${yamlQuote(desc)}`,
    `tools: ${tools.join(', ')}`,
    `model: ${model}`,
    '---',
    '',
    String(persona).trim(),
    '',
    PEN_FOOTERS[pen] || PEN_FOOTERS.character,
    '',
  ];
  return lines.join('\n');
}

/**
 * ## 关于「写完能不能立刻派」——两条路都试过了，结论写在这里免得再试一遍
 *
 * `.claude/agents/` 的 watcher 是异步的，所以第一反应是「写完等一会儿再回话」。
 * 两种等法都不成立：
 *
 * 1. **猜 sleep 时长**（第一版 2.5 秒）：短了照样撞 "agent type not found"，
 *    长了每次造角色都白等，而且这个数没有任何依据。
 * 2. **轮询 `Query.supportedAgents()`**（第二版，看着更严谨）：⛔ **实测恒为 false**。
 *    2026-08-26 探针：写完文件后轮询 12 秒，新角色始终没出现在那个列表里 ——
 *    而同一轮里主代理**下一个回合直接派就派成功了**，人设原样命中。
 *    ⚠️ 别误读成"派发也看不见新文件"：CLI 侧真的用 chokidar 在 watch
 *    `.claude/agents/`，add/change/unlink 都会清掉 agentDefinitions 缓存，
 *    **派发那条路是新鲜的**；陈旧的是 `supportedAgents()` —— 它读的是 SDK 侧
 *    `initialization` 那份**一次性快照**，会话开跑之后就不再更新了。
 *    拿它当拾取判据 = 每次白等满超时，比猜 sleep 更糟。
 *    （watcher 带 awaitWriteFinish 防抖，所以"隔两秒再派"这句话术是对的量级。）
 *
 * 3. **不等，让模型失败了重试**（第三版）：⛔ 实测不成立。2026-08-26 探针：主 agent
 *    在**同一个回合里**造完角色立刻派 → `Agent type 'rp-moli' not found` → 它既没按
 *    工具返回里写的重试，还直接回了一句「已派」（撒谎）。
 *    ⚠️ 第二版之所以看着像成立，是因为那次探针的编排让主 agent **隔了一个回合**才派，
 *    中间的时间正好够 watcher 拾取 —— 拿它当"不用等"的证据是**观察巧合**。
 *
 * 4. **等更久**（第四版，3.5s → 12s）：⛔ 也不成立。对照实验：同一回合内造完立刻派，
 *    等 3.5 秒失败，等 12 秒**照样失败**，报的都是
 *    `Agent type 'rp-moli' not found. Available agents: claude, Explore, general-purpose, Plan`。
 * 5. **运行时注册**（mutate `options.agents` + `query.reinitialize()`）：⛔ 不生效。
 *    reinitialize 正常返回，CLI 侧的可用类型一个没变。
 *
 * ## 结论：这跟「等多久」无关，跟「隔没隔一个回合」有关
 *
 * 块 2 探针之所以能派成功，是因为那次编排让主 agent **下一个回合**才派 —— 新回合触发
 * 全量重扫。同一回合内不管等多久，CLI 都用着那份旧的可用类型表。
 *
 * 所以做法有两层：
 *   ① **结构性拦截**（可靠）：名册记下"这一回合造的角色"，派发闸 deny 掉本回合内那次
 *      注定失败的派发。不这么做的话模型会撞一次 not found 然后**谎报「已派」**
 *      —— 2026-08-26 探针里它这么干了两次，工具返回里写明"这一回合派不了"也照撞。
 *      加闸之后它就老实说"需等下一回合"了。⭐ 把「模型该怎么做」写成话术它不听，
 *      写成闸它就听。
 *   ② **自动提醒**（尽力而为，⏸ 未验通）：往 inputQueue 推一条「可以派了」的系统消息
 *      制造下一个回合（抄半截续接那条路）。⚠️ 2026-08-26 探针里**没观察到它唤起新回合**：
 *      它是在工具调用进行中推的，SDK 同一回合内不消费输入流，回合结束后也没拾起；
 *      而探针在 result 之后自己推同一条队列**是能唤醒的**（二分实证），所以队列本身没问题，
 *      问题在推的时机。真实会话里有 turn.js / run 管理那一层，行为待验。
 *      **不依赖它也成立**：闸已经告诉主 agent 下一回合再派，用户下一句话自然制造那个回合。
 *
 * ⭐ 五版教训归档：①猜出来的时长没有依据 ②换成"更严谨"的判据前先验证它**会不会变成
 * true**（恒假的判据长得跟严谨一模一样）③靠模型重试之前先验模型真会重试（它不但没重试，
 * 还谎报"已派"）④**拿一次成功的观察当机制之前，先问它成功的真正原因是什么** ——
 * 块 2 那次成功被我读成"不用等"，真因却是"隔了一个回合"，差之毫厘。
 */

export function makeCastRoleTool({ workspaceRoot, sessionId = null, ctx, roster = null, announce = true }) {
  return tool(
    'cast_role',
    `Turn a character sheet / persona into a REAL resident subagent you can put on stage.

Writes .claude/agents/${ROLE_PREFIX}<id>.md; a few seconds later you can spawn it with
Agent(subagent_type: "${ROLE_PREFIX}<id>"). The persona text you pass becomes that agent's
ENTIRE system prompt — it does not inherit yours.

A cast role is RESIDENT: spawn it once, then talk to it with SendMessage({to: "${ROLE_PREFIX}<id>"}).
It keeps its full memory of everything it has written. Never spawn the same role twice —
that silently replaces it with an amnesiac copy (the harness will refuse).

Use it when a story needs a voice that is not yours: a narrator that writes the prose while
you direct, an NPC that answers in character, a second writer working a subplot. Do NOT use
it for work tasks — subagents for research/review are a different thing (Agent tool directly).`,
    {
      id: z.string().describe('ASCII slug, no prefix: lowercase letters/digits/_/- , 2-41 chars. Becomes the address (rp-<id>).'),
      name: z.string().min(1).max(40).describe('Display name, any language — what this character is actually called.'),
      duty: z.string().min(1).max(400).describe('One line: who this is and when you would talk to them. Shown to you in the agent list.'),
      persona: z.string().min(1).describe('The role card itself. Becomes the agent\'s entire system prompt: who they are, how they speak, what they must never do, how they should use the board.'),
      tools: z.array(z.string()).optional().describe('Optional tool subset (short names like write_on_board). Omit for the default board-writing set.'),
      pen: z.enum(['character', 'narrator']).optional().describe("Which pen this role holds. 'character' (default): plays ONE person — writes only their own words/actions/thoughts, first person, never scene description. 'narrator': writes scene prose — never speaks for named roles. The matching house rules are pinned to the card tail automatically; do NOT restate them in persona."),
      model: z.string().optional().describe("Model for this role. Omit or 'inherit' to use the same model as you."),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!workspaceRoot) return fail('没有工作区，cast_role 不可用。');

      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) {
        return fail(`角色 id「${id}」不合法：只能用小写字母、数字、下划线、连字符，2-41 个字符，首字符是字母或数字。`
          + `（这个 id 要同时当文件名和 SendMessage 的收件人名，收件人名不收中文和空格 —— 中文名字放 name 参数。）`);
      }
      const slug = `${ROLE_PREFIX}${id}`;
      if (!isValidRoleSlug(slug)) return fail(`角色名「${slug}」过不了名册校验。`);

      if (!oneLine(args.name, 40)) return fail('name 清洗后是空的 —— 换个展示名（不能只有换行或「」）。');
      const persona = String(args.persona || '').trim();
      if (!persona) return fail('persona 是空的 —— 角色的人设就是它的全部系统提示词，不能空。');
      if (persona.length > PERSONA_MAX) {
        return fail(`persona 有 ${persona.length} 字符，超过 ${PERSONA_MAX} 上限。`
          + `人设进的是每次唤醒都要重发的前缀，写长了每一句台词都在为它付费 —— `
          + `把设定挪进世界书文件让角色自己 grep。`);
      }

      const { tools, rejected } = resolveRoleTools(args.tools, MCP_SERVER_NAME);
      // model 收成形状白名单：它是模型给的自由字符串，压成一行还不够 ——
      // 带空格冒号的值塞进 frontmatter 虽然产生不了第二个键，但会变成一个谁也
      // 解析不出的 model 值，症状是"角色悄悄跑在默认模型上"。
      const model = oneLine(args.model || 'inherit', 60) || 'inherit';
      if (!/^[A-Za-z0-9._[\]-]{1,60}$/.test(model)) {
        return fail(`model「${model}」不合法：只能是 inherit、模型别名（sonnet/opus/haiku/fable）`
          + `或完整模型 ID（如 claude-sonnet-5[1m]）。`);
      }

      const dir = path.join(workspaceRoot, AGENTS_DIR);
      const file = path.join(dir, `${slug}.md`);
      // 路径闸：slug 已过 ID_RE，这一层是结构性兜底（判据万一被放宽，这里还在）
      if (path.resolve(file) !== path.resolve(dir, `${slug}.md`) || !path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
        return fail('角色文件路径异常，拒绝写入。');
      }

      let existed = false;
      try { await fs.access(file); existed = true; } catch { /* 新角色 */ }

      // pen 收成两值：enum 之外的值（含漏传）一律折回 character，角色不能没有笔权台规
      const pen = args.pen === 'narrator' ? 'narrator' : 'character';

      await fs.mkdir(dir, { recursive: true });
      // model 也来自模型，别让它往 frontmatter 里塞第二行
      await fs.writeFile(file, composeRoleCard({
        slug, displayName: args.name, duty: args.duty, tools, model, persona, pen,
      }), 'utf8');



      try { ctx?.emit?.({ type: 'run.role_cast', slug, name: String(args.name).trim() }); } catch { /* 事件失败不挡正事 */ }

      // 制造下一个回合：CLI 要在回合边界才重扫 .claude/agents/（见文件头注释）。
      // 走的是半截续接那条现成的路（pushUnclaimedMessage），不新开机制。
      // announce=false 只给单测用 —— 单测里没有活着的会话可推。
      // 记下"这一回合造的"，派发闸据此拦掉本回合内那次注定失败的派发
      roster?.noteCast?.(slug, ctx?.runId);

      let announced = false;
      if (announce && sessionId) {
        announced = pushUnclaimedMessage(sessionId, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text:
            `[系统] 角色「${oneLine(args.name, 40)}」（${slug}）的文件已就位，现在可以派它上场了：`
            + `Agent(subagent_type: "${slug}")。` }] },
          parent_tool_use_id: null,
        });
      }

      const lines = [
        `${existed ? '改写' : '写好'}了角色「${args.name}」→ ${AGENTS_DIR}/${slug}.md`,
        announced
          ? '⚠️ **这一回合派不了它** —— CLI 要到下一条消息才认得新角色。把手头的话说完结束回合，'
            + '你马上会收到一条「可以派了」的系统消息，那时再派。'
          : '⚠️ 新角色要到**下一条消息**才派得动（CLI 在回合边界才重扫角色目录）。'
            + '这一回合别派，等下一轮。',
        '',
        `**派上场**：Agent(subagent_type: "${slug}")，prompt 写这一场要它做什么。`,
        `**之后跟它说话**：SendMessage({to: "${slug}"}) —— 它记得自己写过的一切，不要重新派。`,
        `它拿到的工具：${tools.join('、')}`,
        `笔权：${pen === 'narrator' ? '旁白笔（写场面，不替角色说话）' : '角色笔（只写自己，第一人称）'} —— 台规已钉在卡尾，persona 里不用抄。`,
      ];
      if (rejected.length) {
        lines.push('', `⚠️ 这些工具不给角色：${rejected.join('、')}。`
          + `角色只能通过画布表达自己 —— 外发、花钱、改工作区结构的工具一律不发给它。`);
      }
      if (existed) {
        lines.push('', '⚠️ 这个角色如果**已经在场**，改文件不会改变它：人设在派发那一刻就进了它自己的转录，'
          + '之后只跟着消息走。改文件只对下次派发有效。要当场调整它，直接 SendMessage 告诉它。');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
