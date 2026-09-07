/**
 * mcp/tools/publish-site.js — publish_site MCP tool（2026-08-02）
 *
 * agent 版的「一键上线」：把任务里的目录站点发到 Cloudflare Pages 公网。
 * 与站点窗的上线按钮共用 lib/site-publish.js 的全部闸门 —— 额度和权限按
 * **项目 owner** 算（basic 档不能发、pro 档每人 2 个；档位见 auth/tier.js），不是"谁触发算谁"。
 *
 * 发到公网是外发动作：工具描述里写死"用户明确要求才调"。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { publishSite, unpublishSite, lookupPublished } from '../../../lib/site-publish.js';

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 */
export function makePublishSiteTool({ projectId }) {
  return tool(
    'publish_site',
    `Publish a site task to the public web (Cloudflare Pages), update an already
published site, or take it offline.

Call this ONLY when the user explicitly asks to put the site online / update the
live version / take it down. Never publish unprompted — going public is the
user's call, not yours.

action:
- "publish": deploy the current files. First publish returns the permanent URL
  (a brand-new domain may take a minute or two to start resolving); republishing
  keeps the same URL.
- "unpublish": delete the deployment; the public URL dies immediately.
- "status": just report whether this task is published and at which URL.

If the workspace contains more than one site, the tool refuses to guess and lists
the candidates — pass "root" to name the one to publish ("." = the workspace root).
Each site holds ONE public URL, keyed by its own root directory.

**The public domain**: by default it is derived from the site's root directory
name; Chinese names slug down to nothing, so those fall back to a short hash
("a1b2c3.share..."). Pass "slug" to choose a readable one — do that whenever the
site has a name worth showing, because the URL is what the user hands to other
people. A slug is claimed on first publish and reused on every republish.

**Verifying a fresh publish**: a brand-new domain needs a certificate issued
before https works; until then screenshot_url fails with an SSL error. This tool
now waits for it and tells you whether it is ready. Also note Cloudflare Pages
serves the site's own 404.html for unknown paths — an HTTP 200 does NOT prove a
path exists, check the content type and body.

The user's publish quota and permissions apply (basic-tier accounts cannot publish;
pro accounts have a per-user site limit). If the tool returns a quota or
permission error, relay it as-is — do not retry.`,
    {
      task: z.string().describe(
        '站点标识：站点根目录的相对路径（工作区根上那个站传 "."）。'
        + '不确定就传 "." —— 只有一个站时工具会自己认出来'),
      action: z.enum(['publish', 'unpublish', 'status']).default('publish'),
      root: z.string().optional().describe(
        '有多个平行站点时点名要发布哪个（相对工作区根，根上那个站传 "."）。单站点省略'),
      slug: z.string().optional().describe(
        '自选公网域名前缀，如 "chenxi" → chenxi.share.<域>。'
        + '小写字母开头、3-32 位小写字母/数字/连字符。被占用会明确报错让你换一个'),
    },
    async ({ task, action, root, slug }) => {
      const asText = (text) => ({ content: [{ type: 'text', text }] });
      try {
        const project = getProject(projectId);
        if (!project) return asText('错误：项目不存在');
        const owner = project.ownerId ? getUserById(project.ownerId) : null;
        if (!owner) return asText('错误：找不到项目归属用户，不能发布');

        if (action === 'status') {
          const site = await lookupPublished(projectId, task);
          return asText(site
            ? `已发布：${site.url}（站点根 ${site.task}，最近发布 ${site.lastPublishedAt}）`
            : '未发布');
        }
        if (action === 'unpublish') {
          const removed = await unpublishSite({ projectId, task });
          return asText(removed ? '已下线，公网地址即刻失效。' : '本来就没有发布。');
        }
        const r = await publishSite({ projectId, task, root, slug, user: owner });
        return asText([
          `已上线：${r.site.url}`,
          `发布的是 ${r.root === '.' ? '工作区根' : `${r.root}/`}，${r.files} 个文件，入口 ${r.entry || '(无 html)'}`,
          r.certReady === true
            ? '证书已就绪，现在就能 screenshot_url 自检。'
            : (r.certReady === false
              ? '⚠ 证书还没签发完（等了 150 秒，通常 2-3 分钟）—— 此时截图会返回 SSL 错误，请稍后重试。'
              : '重新发布地址不变。'),
          r.warning ? `注意：${r.warning}` : null,
        ].filter(Boolean).join('\n'));
      } catch (err) {
        return asText(`发布操作失败：${err.message}`);
      }
    },
  );
}
