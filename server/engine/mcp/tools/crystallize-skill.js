/**
 * mcp/tools/crystallize-skill.js — crystallize_skill MCP tool
 *
 * 把一次真实探索的**结论**固化成用户自己的 skill，并把作品收进个人橱窗。
 *
 * 为什么不是"存模板"：模板是把成品存下来，换个主题就崩——真正能复用的是判断依据
 * （为什么这个字号阶梯、为什么这个场合压住动效、哪些默认做法在这个气质里必须反掉）。
 * 所以这个工具收的是方法论，不是 HTML。产物写进用户级 plugin 根
 * （~/.nodesign/plugins/<userId>/<name>/），下次开新会话在**这个用户的所有项目**里
 * 都能用（plugin 发现是 startup-time，当前会话不生效）。
 *
 * 跟长期记忆（记忆/ + 根 CLAUDE.md）的分工：记忆记的是**这个项目/这位用户**的持续状态，随项目走；
 * 这里是跨项目复用的方法论，随用户走。一个是日志，一个是沉淀。
 *
 * 归属：写到**项目 owner** 的目录，不是"当前请求者"——同一个项目谁跑都该产出同一
 * 套资产。owner 查不到就报错，不往共享根写（那是刚修掉的跨用户污染路径）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserPluginsRoot } from '../../agent/plugin-loader.js';
import { installPluginToRoot } from '../../../lib/plugin-install.js';
import { upsertEntry } from '../../../lib/showcase-store.js';
import { getActiveArtifact } from '../../../lib/artifact-target.js';
import { publishToMarket, marketPublisherRegistered } from '../../../lib/market-bridge.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Events } from '../../agent/events.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** 覆盖已有 skill 时版本号递进（0.1.0 → 0.1.1），新建从 0.1.0 起。读不到就当新建。 */
async function nextVersion(root, name) {
  try {
    const md = await fsp.readFile(path.join(root, name, 'skills', name, 'SKILL.md'), 'utf8');
    const m = md.match(/^version:\s*(\d+)\.(\d+)\.(\d+)\s*$/m);
    if (m) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  } catch { /* 没有旧的 */ }
  return '0.1.0';
}

function composeSkillMd({ name, title, description, body, version = '0.1.0' }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n+/g, ' ').trim()}`,
    `version: ${version}`,
    '---',
    '',
    `# ${title.trim()}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeCrystallizeSkillTool({ projectId, sessionId, ctx, workspaceRoot = null }) {
  return tool(
    'crystallize_skill',
    `Put a finished work in the user's personal showcase, optionally distill the
style/approach into a REUSABLE SKILL owned by this user, and optionally publish
the work (with the images you pick) to the public market.

Three uses, all ONLY on the user's explicit request — never unprompted:
1. "Keep this style" → give name/title/description/body (the skill), plus the work.
2. "Put this in my showcase" → omit the skill fields; give artifactPath and a title.
3. "Publish this" / "share it to the market" → set publish: true and pick 1–6
   images (workspace-relative paths: screenshots you took, generated images) that
   show the work best. Publishing makes the images and text PUBLIC to every user
   of the site immediately; say so to the user before calling.

What belongs in \`body\` is the METHODOLOGY, not the artifact:
- The reasoning behind the choices (why this type scale, why this palette works
  for this kind of room, why motion was held back here)
- What the user rejected along the way and why — the negative space is the most
  reusable part
- The anti-default list for this style: what the obvious move would have been,
  and why it was wrong here
- Where this style BREAKS DOWN — occasions it does not suit. A skill that cannot
  state its own boundary is a template wearing a methodology costume, and it will
  produce bad work the first time it is applied off-target.

Do NOT paste HTML/CSS of the finished piece. Concrete values (a specific hex, a
specific scale) belong in only as illustrations of the reasoning.

The skill lands in the user's personal plugin dir and becomes available in NEW
sessions across all their projects (plugin discovery happens at session start,
so it does not apply to the current session).`,
    {
      name: z.string().optional()
        .describe('Skill id, kebab-case, 3-40 chars (e.g. "quiet-editorial-deck"). Omit to skip the skill and only showcase/publish the work.'),
      title: z.string().min(2).max(80)
        .describe('Human-readable name of the style or the work (e.g. "安静的编辑气质 · 长文型站点")'),
      description: z.string().min(20).max(600).optional()
        .describe('Skill frontmatter description — the routing signal. MUST say when to use it AND when not to. Required with name.'),
      body: z.string().min(200).optional()
        .describe('The methodology in markdown: reasoning, rejected alternatives, anti-default list, and where the style breaks down. Required with name.'),
      publish: z.boolean().optional()
        .describe('Also publish to the public market (visible to all users at once). Only when the user asked to publish/share.'),
      images: z.array(z.string()).max(6).optional()
        .describe('Workspace-relative image paths to show on the market card (1–6; png/jpg/webp). First one is the cover. Required when publish is true.'),
      showcaseTitle: z.string().max(80).optional()
        .describe('Title for the showcase card. Defaults to the style title.'),
      showcaseNote: z.string().max(400).optional()
        .describe('One line for the showcase card: what occasion this piece was for.'),
      artifactPath: z.string().optional()
        .describe('Work to show on the card, relative to workspace (e.g. "canvas.html" or "稿件/主稿.html"). Defaults to the active artifact.'),
      overwrite: z.boolean().optional()
        .describe('Replace an existing skill of the same name. Ask the user before setting this.'),
    },
    async ({ name, title, description, body, showcaseTitle, showcaseNote, artifactPath, overwrite, publish, images }) => {
      const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
      try {
        const withSkill = !!name;
        if (withSkill && !NAME_RE.test(String(name || ''))) {
          return fail(`Invalid skill name "${name}" — use kebab-case, 3-40 chars, e.g. "quiet-editorial-deck".`);
        }
        if (withSkill && (!description || !body)) return fail('A skill needs description and body; omit name to only showcase/publish the work.');
        if (!projectId) return fail('No project bound; cannot resolve who owns this skill.');
        const ownerId = getProject(projectId)?.ownerId || null;
        const root = getUserPluginsRoot(ownerId);
        if (!root) {
          return fail('This project has no owner on record, so there is no personal skill library to write to.');
        }
        if (publish && !marketPublisherRegistered()) return fail('This instance has no market to publish to (site market off, or desktop not signed in).');
        if (publish && !(images?.length)) return fail('publish: true needs 1–6 images (workspace-relative paths) for the market card.');

        let result = { body: {} };
        if (withSkill) {
          const version = overwrite ? await nextVersion(root, name) : '0.1.0';
          const md = composeSkillMd({ name, title, description, body, version });
          result = await installPluginToRoot(Buffer.from(md, 'utf8'), root, { force: !!overwrite });
          if (result.status === 409) {
            return fail(`A skill named "${name}" already exists in this user's library `
              + `(${result.body.existing?.description || 'no description'}). `
              + 'Ask the user whether to replace it, then call again with overwrite: true.');
          }
          if (result.status >= 400) {
            const errs = (result.body.errors || []).join('; ') || result.body.error;
            return fail(`Skill rejected by validator: ${errs}`);
          }
        }

        // 橱窗条目：作品 + 它沉淀出来的 skill
        // 橱窗条目指向的是**产物的相对路径**。扁平化前还要顺带记一个 taskId
        // （产物住在哪个任务文件夹里），任务层没了之后这个字段永远是 null ——
        // 留着列是因为 showcase 表里有存量数据，读的时候还认它。
        const rel = String(artifactPath || getActiveArtifact(sessionId)?.path || '').replace(/\\/g, '/');
        const artifactRel = rel || null;
        let entry = null;
        try {
          entry = upsertEntry({
            userId: ownerId,
            projectId,
            taskId: null,
            artifactRel,
            skillName: withSkill ? name : null,
            title: (showcaseTitle || title).trim(),
            note: showcaseNote?.trim() || null,
          });
        } catch (err) {
          console.warn('[crystallize_skill] showcase entry failed:', err.message);
        }

        try {
          ctx?.emit?.({
            type: 'run.skill_crystallized',
            skillName: withSkill ? name : null,
            title: title.trim(),
            showcaseId: entry?.id || null,
          });
        } catch { /* emit fail-safe */ }

        // 发布到市场（09-08 晚 v2）：图从工作区读原字节，站点侧 normalize；发布即上架
        let published = '';
        if (publish) {
          const root2 = workspaceRoot ? path.resolve(workspaceRoot) : null;
          if (!root2) return fail('publish: no workspace root bound; cannot read the images.');
          const bufs = [];
          for (const rel of images) {
            const abs = path.resolve(root2, String(rel).replace(/\\/g, '/'));
            if (!abs.startsWith(root2 + path.sep)) return fail(`Image path escapes the workspace: ${rel}`);
            if (!/\.(png|jpe?g|webp)$/i.test(abs)) return fail(`Not an image file: ${rel} (png / jpg / webp only)`);
            try { bufs.push({ buf: await fsp.readFile(abs), type: /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg', name: path.basename(abs) }); }
            catch { return fail(`Cannot read image: ${rel}`); }
          }
          try {
            const pub = await publishToMarket({ userId: ownerId, title: (showcaseTitle || title).trim(), note: showcaseNote?.trim() || null, skillName: withSkill ? name : null, images: bufs, showcaseId: entry?.id || null });
            published = ` Published to the market as ${pub?.kind === 'work' ? 'a work' : 'a skill'} (id ${pub?.id}, ${bufs.length} image${bufs.length > 1 ? 's' : ''}); it is public now.`;
          } catch (err) {
            return fail(`Showcase updated, but publishing failed: ${err?.message || err}`);
          }
        }

        const warn = (result.body.warnings || []).length
          ? ` Warnings: ${result.body.warnings.join('; ')}.` : '';
        return {
          content: [{
            type: 'text',
            text: (withSkill
              ? `Skill "${name}" saved to the user's personal library${artifactRel ? ' and the work added to their showcase' : ''}. It becomes available in NEW sessions (not this one).`
              : `Work added to the user's showcase${artifactRel ? '' : ' (no artifact path resolved; card has no cover)'}.`)
              + published + warn
              + (withSkill ? ' Tell the user plainly what you captured and what boundary you wrote, so they can correct it while it is fresh.' : ' Tell the user where to find it.'),
          }],
        };
      } catch (err) {
        return fail(`crystallize_skill failed: ${err?.message || String(err)}`);
      }
    },
  );
}
