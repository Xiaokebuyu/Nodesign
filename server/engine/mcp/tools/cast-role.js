/**
 * mcp/tools/cast-role.js — cast_role MCP tool（2026-08-26 建；2026-08-28 演员位重构重写）
 *
 * ## 重写前后
 *
 * 旧语义：写 `.claude/agents/rp-<id>.md`（一角色一个子代理定义），派发要等 CLI 重扫。
 * ⛔ 那条路 08-28 勘定为生产不可靠：会话中途写入的定义文件只有**写入时活着的那个
 * CLI 进程**认得（chokidar 事件），resume 换进程后永久 `not found`（三场真会话：
 * 12 连败 / 恰好成功 / 永久失明）。等待、轮询、公告续接五版都救不了，全史见 git
 * 里本文件的旧版头注。
 *
 * 新语义：角色卡是**数据**，子代理是**预注册的演员位**（rp-actor / rp-narrator，
 * 建项目时就落盘，见 cast.js slotAgentFile）。cast_role 只做两件事：
 *   1. 把人设写成 `角色/<名>/角色卡.md`（用户在画布上看得见、随时能改的文件夹范式）
 *   2. 在 `.nd/cast.json` 登记 slug → 展示名/笔权/卡路径（板书署名与名册 API 的展示源）
 * 写完**当回合就能派**：Agent(subagent_type: 演员位, name: "rp-<id>", prompt: 卡)。
 *
 * 登记不是上场的前置（不登记直接派也行），它换来的是：板上署名是「程晚」不是
 * slug、重启后按卡重新开演有据可查、用户能在角色文件夹里改人设。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ROLE_PREFIX, ROLE_SLOT, isSlotType, isValidRoleSlug } from '../../agent/cast.js';
import { readCastRegistry } from '../../agent/role-card.js';
import { renderCard, rolesDirFor } from '../../stage/card.js';

/** 角色 id（不含 rp- 前缀）：ASCII、能当文件名、能当 SendMessage 收件人名。
 *  ⚠️ 这是 cast.js `ROLE_SLUG_RE` 的**收紧子集**（这边只许小写、≥2 字符）——
 *  两个判据的蕴含关系（ID_RE 过的 id 拼上前缀必被 ROLE_SLUG_RE 认）由
 *  cast-role.test.js 钉着；改任何一边先看那条测试。导出仅供测试。 */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;

const ROLES_DIR = '角色';
const REGISTRY_REL = '.nd/cast.json';
const PERSONA_MAX = 20000;

/** 自由文本压一行：控制字符/行终止符全清（进 JSON 与返回话术都安全） */
function oneLine(v, max) {
  return String(v ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim().slice(0, max);
}

/** 展示名 → 文件夹名：剥路径分隔与点前缀，空了退回 slug（文件夹名坏不了路径） */
function folderNameFor(displayName, slug) {
  const cleaned = oneLine(displayName, 40).replace(/[\/\\]/g, '').replace(/^\.+/, '').trim();
  return cleaned || slug;
}

export function makeCastRoleTool({ workspaceRoot, sessionId = null, ctx, roster = null }) {
  void sessionId; void roster;   // 旧签名的调用方兼容位（公告续接与回合闸已随重构退役）
  return tool(
    'cast_role',
    `Register a character card so this person has a fixed identity to act from.

Writes the card to ${ROLES_DIR}/<name>/角色卡.md (user-visible, user-editable) and records
the display name. The card is DATA, and in this build it is a reference for YOU:
character subagents are disabled, so you write everyone on stage yourself.

Use it for anyone who has a name, will show up again, and whom the user may want to talk
to. **The card is what open_stage puts on stage**: when you hand a play to the stage
process, each cast member's card (persona + their own memory index) goes into its system
prompt verbatim — so write the persona for that reader. When you act a character yourself
instead, re-read the card right before writing their lines. A walk-on with one line needs no card.

⛔ Do NOT dispatch a role subagent after this: no Agent(subagent_type: "${ROLE_SLOT}"),
no SendMessage to a character. That path is being debugged; the cards you write now will
plug straight back in once it returns.
When the user hands you a ready-made character card, prefer copying it in verbatim over
rewriting it.`,
    {
      id: z.string().describe('ASCII slug, no prefix: lowercase letters/digits/_/- , 2-41 chars. Becomes the address (rp-<id>).'),
      name: z.string().min(1).max(40).describe('Display name, any language — what this character is actually called. Board signatures use it.'),
      duty: z.string().min(1).max(400).describe('One line: who this is and when you would talk to them.'),
      persona: z.string().min(1).describe("The card itself: who this person is, how they speak, what they would never do, plus two or three short samples of their voice. You read this back before writing their lines, so write it for that use — no meta rules about who writes what."),
    },
    async (args) => {
      const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });
      if (!workspaceRoot) return fail('没有工作区，cast_role 不可用。');

      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) {
        return fail(`角色 id「${id}」不合法：只能用小写字母、数字、下划线、连字符，2-41 个字符，首字符是字母或数字。`
          + `（这个 id 要当 SendMessage 的收件人名，收件人名不收中文和空格 —— 中文名字放 name 参数。）`);
      }
      const slug = `${ROLE_PREFIX}${id}`;
      if (!isValidRoleSlug(slug) || isSlotType(slug)) return fail(`角色名「${slug}」过不了名册校验（演员位的名字不能当角色名）。`);

      const displayName = oneLine(args.name, 40);
      if (!displayName) return fail('name 清洗后是空的 —— 换个展示名。');
      const persona = String(args.persona || '').trim();
      if (!persona) return fail('persona 是空的 —— 角色卡就是这个角色的全部身份，不能空。');
      if (persona.length > PERSONA_MAX) {
        return fail(`persona 有 ${persona.length} 字符，超过 ${PERSONA_MAX} 上限。`
          + `把大部头设定挪进世界书/设定文件让角色自己 grep，卡上留人设主干。`);
      }

      // 卡落盘：角色/<名>/角色卡.md（文件夹范式：这个文件夹就是该角色的家，
      // 之后的记忆/日记等件都住这里；用户随时可改，改动对"下次派发/唤醒后重读卡"生效）
      const folder = folderNameFor(displayName, slug);
      // 工作区里只有一场戏时卡直接写进它的文件夹（戏自成一体）；否则写根上的 角色/，open_stage 开戏时搬
      const rolesRel = await rolesDirFor(workspaceRoot);
      const dir = path.join(workspaceRoot, rolesRel, folder);
      const file = path.join(dir, '角色卡.md');
      if (!path.resolve(file).startsWith(path.resolve(workspaceRoot, rolesRel) + path.sep)) {
        return fail('角色卡路径异常，拒绝写入。');
      }
      // 一个家只住一个角色（2026-08-28 对账发现）：文件夹按展示名取，两个不同的
      // slug 用同一个展示名就会共用 角色/<名>/ —— 卡被后来者覆盖，**记忆.md 也共用**，
      // 于是 A 的 jot_memory 写进 B 的记忆里，谁都不会发现。堵在写口，不是在
      // roleHomeDir 那头兜（判据别建在模型可写的登记表上）。
      // 同一个 slug 重登（改卡）不受影响 —— 那本来就是同一个人。
      const claimedBy = Object.entries((await readCastRegistry(workspaceRoot)).roles || {})
        .find(([s2, e2]) => s2 !== slug && typeof e2?.card === 'string'
          && e2.card.replace(/\/角色卡\.md$/, '') === `${rolesRel}/${folder}`);
      if (claimedBy) {
        return fail(`「${displayName}」这个家已经是 ${claimedBy[0]} 的了（角色/${folder}/）。`
          + `同名两个角色会共用角色卡和记忆件 —— 换个展示名，`
          + `或者你要的其实是同一个人的话，用 ${claimedBy[0]} 这个名字重登（改卡就是重登同一个 slug）。`);
      }
      let existed = false;
      try { await fs.access(file); existed = true; } catch { /* 新角色 */ }
      await fs.mkdir(dir, { recursive: true });
      // 记忆件骨架（只在不存在时铺）：角色 jot_memory 追加，用户/GM 可整理
      const memFile = path.join(dir, '记忆.md');
      try { await fs.access(memFile); } catch {
        await fs.writeFile(memFile, `# 记忆\n\n<!-- ${slug} 的记忆：角色自己 jot_memory 追加，用户和 GM 可整理改写。还是空的。 -->\n`, 'utf8');
      }
      // 卡的格式收在 engine/stage/card.js（2026-09-05）：frontmatter（name/slug/note）+ 人设正文 +
      // 机器维护的记忆索引块。open_stage 按名字找到这张卡整份进演出进程的系统提示词。
      // 重登（改卡）时保住机器块：人设由这次的 persona 替换，索引块以磁盘上的为准
      let keepMemory = null;
      if (existed) {
        try {
          const { parseCard } = await import('../../stage/card.js');
          keepMemory = parseCard(await fs.readFile(file, 'utf8')).memory || null;
        } catch { /* 读不动就当新卡 */ }
      }
      let cardText = renderCard({ name: displayName, slug, note: oneLine(args.duty, 60), persona });
      if (keepMemory) {
        const { replaceMemoryBlock } = await import('../../stage/card.js');
        cardText = replaceMemoryBlock(cardText, keepMemory);
      }
      await fs.writeFile(file, cardText, 'utf8');

      // 登记表：板书署名与名册 API 的展示名来源（fail-soft：登记坏了不拦上场）
      const cardRel = path.join(rolesRel, folder, '角色卡.md');
      try {
        const reg = await readCastRegistry(workspaceRoot);
        reg.roles[slug] = { name: displayName, duty: oneLine(args.duty, 400), card: cardRel };
        await fs.mkdir(path.join(workspaceRoot, '.nd'), { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, REGISTRY_REL), JSON.stringify(reg, null, 2), 'utf8');
      } catch { /* 展示层，坏了角色照样能上场（署名退回 slug） */ }

      try { ctx?.emit?.({ type: 'run.role_cast', slug, name: displayName }); } catch { /* 事件失败不挡正事 */ }

      // ⚠️ 这段话和工具 description 是**同一条教义的两个读者**，改一头必须改另一头 ——
      // 08-30 停用子代理那一刀只改了 description，这里还留着「现在就可以派它上场」，
      // 而返回文案离模型的下一个动作更近，等于白改（fable 评审当场抓到）。
      const lines = [
        `${existed ? '改写' : '写好'}了角色卡「${displayName}」→ ${cardRel}（登记为 ${slug}）`,
        '',
        `⛔ **不要派子代理**：这一版角色由你自己演，`
        + `Agent(subagent_type: "${ROLE_SLOT}") 和 SendMessage 给角色这两条路正在调试。`,
        `轮到「${displayName}」说话时，**先 Read 一遍 ${cardRel}** 把腔调找回来，再由你写他这一段。`,
        `几个人同场就一个个来，每人开口前各读各的卡 —— 这是防止全场一个腔的正事。`,
        `要开一场正式的戏：把台面（世界 / 规矩）写好后调 open_stage，cast 里报「${displayName}」，这张卡就整份进演出进程。`,
      ];
      if (existed) {
        lines.push('', '⚠️ 卡改了，下次写他的话之前重新 Read 一遍 —— 你上下文里那份是旧的。');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
