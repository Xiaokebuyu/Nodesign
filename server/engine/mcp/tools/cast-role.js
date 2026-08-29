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
    `Register a character card so this person can take the stage with a proper name.

Writes the card to ${ROLES_DIR}/<name>/角色卡.md (user-visible, user-editable) and records
the display name for board attribution. The card is DATA — the acting body is a
pre-registered role slot, so you can dispatch IMMEDIATELY after this call (no waiting):

  Agent(subagent_type: "${ROLE_SLOT}", name: "${ROLE_PREFIX}<id>", run_in_background: true,
        prompt: first line "你的角色卡：${ROLES_DIR}/<名>/角色卡.md", then the full card
        text, what has just happened, and what this person is being asked to react to)

A character writes ONE passage per turn and then that turn ends — you wake it again for
the next beat with SendMessage({to: "${ROLE_PREFIX}<id>"}), which resumes it instantly with
its full memory. Never spawn the same name twice: that creates an amnesiac duplicate.
Scene description, the world and everything around the characters is YOUR pen, not theirs.
When the user hands you a ready-made character card, prefer copying it in verbatim over
rewriting it.`,
    {
      id: z.string().describe('ASCII slug, no prefix: lowercase letters/digits/_/- , 2-41 chars. Becomes the address (rp-<id>).'),
      name: z.string().min(1).max(40).describe('Display name, any language — what this character is actually called. Board signatures use it.'),
      duty: z.string().min(1).max(400).describe('One line: who this is and when you would talk to them.'),
      persona: z.string().min(1).describe("The card itself. Goes into the dispatch prompt as this person's entire identity: who they are, how they speak, what they would never do. The division of labour (they write only themselves, you write the world) is already in the role slot — do NOT restate it here."),
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
      const dir = path.join(workspaceRoot, ROLES_DIR, folder);
      const file = path.join(dir, '角色卡.md');
      if (!path.resolve(file).startsWith(path.resolve(workspaceRoot, ROLES_DIR) + path.sep)) {
        return fail('角色卡路径异常，拒绝写入。');
      }
      // 一个家只住一个角色（2026-08-28 对账发现）：文件夹按展示名取，两个不同的
      // slug 用同一个展示名就会共用 角色/<名>/ —— 卡被后来者覆盖，**记忆.md 也共用**，
      // 于是 A 的 jot_memory 写进 B 的记忆里，谁都不会发现。堵在写口，不是在
      // roleHomeDir 那头兜（判据别建在模型可写的登记表上）。
      // 同一个 slug 重登（改卡）不受影响 —— 那本来就是同一个人。
      const claimedBy = Object.entries((await readCastRegistry(workspaceRoot)).roles || {})
        .find(([s2, e2]) => s2 !== slug && typeof e2?.card === 'string'
          && e2.card.split('/').slice(0, 2).join('/') === `${ROLES_DIR}/${folder}`);
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
      await fs.writeFile(file, [
        `# ${displayName}`,
        '',
        `<!-- ${slug} · cast_role 登记。`,
        '     正文就是角色的人设，派发时全文随 prompt 进入角色 —— 想改人设直接改这里，',
        '     对已在场的角色用 SendMessage 告知，对下次开演自动生效。 -->',
        '',
        persona,
        '',
      ].join('\n'), 'utf8');

      // 登记表：板书署名与名册 API 的展示名来源（fail-soft：登记坏了不拦上场）
      const cardRel = path.join(ROLES_DIR, folder, '角色卡.md');
      try {
        const reg = await readCastRegistry(workspaceRoot);
        reg.roles[slug] = { name: displayName, duty: oneLine(args.duty, 400), card: cardRel };
        await fs.mkdir(path.join(workspaceRoot, '.nd'), { recursive: true });
        await fs.writeFile(path.join(workspaceRoot, REGISTRY_REL), JSON.stringify(reg, null, 2), 'utf8');
      } catch { /* 展示层，坏了角色照样能上场（署名退回 slug） */ }

      try { ctx?.emit?.({ type: 'run.role_cast', slug, name: displayName }); } catch { /* 事件失败不挡正事 */ }

      const lines = [
        `${existed ? '改写' : '写好'}了角色卡「${displayName}」→ ${cardRel}（登记为 ${slug}）`,
        '',
        `**现在就可以派它上场**（不用等）：`,
        `Agent(subagent_type: "${ROLE_SLOT}", name: "${slug}", run_in_background: true,`,
        `  prompt: 第一行写「你的角色卡：${cardRel}，你的记忆：${path.join(ROLES_DIR, folder, '记忆.md')}」，`,
        `  然后贴卡的全文 + 场上刚发生了什么 + 要它回应的是哪一句）`,
        `它写完一段就结束这一轮。**下一拍再叫它**：SendMessage({to: "${slug}"}) —— 当场醒，`,
        `记得自己演过的一切，不要重新派。`,
      ];
      if (existed) {
        lines.push('', '⚠️ 这个角色如果**已经在场**，改卡不会改变它 —— 人设在派发那一刻就进了它的'
          + '转录。改卡对下次派发生效；要当场调整它，直接 SendMessage 告诉它。');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}
