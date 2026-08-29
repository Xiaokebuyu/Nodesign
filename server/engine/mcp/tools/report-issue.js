/**
 * mcp/tools/report-issue.js — report_issue MCP tool
 * （2026-08-02 由 report_friction 扩容改名：加 kind 轴，bug / friction / idea）
 *
 * agent 主动给维护者写信：harness 的故障（bug）、能用但绕路的摩擦（friction）、
 * 干活时冒出来的改进想法（idea）。三类走同一张 issues 表同一套指纹聚合。
 *
 * 跟自动层（PostToolUseFailure → issues 表 source='auto'）的分工：
 *   自动层记"发生了什么"——某工具失败 N 次，不依赖 agent 自觉，但指不出修法。
 *   这一层补"为什么难受、期望怎样"——一条 "screenshot 超时 12 次" 没有信息量，
 *   一条 "截长站点页时我只想要首屏，但只能 fullPage 然后自己裁" 才指向修法。
 *
 * 措辞戒律（继承自 report_friction，扩 idea 后同样适用）：
 *   - 压住"遇到困难就上报"的倾向：上报**不是**绕路的替代品，照常把活儿干完。
 *   - idea 通道要具体到可实施——"工具链很棒" 这种话没有收件人，不收。
 *   - 同类按指纹聚合累加，不是刷一万条重复。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { recordIssue, signatureOf } from '../../../lib/issues-store.js';
import { getProject } from '../../../projects/store.js';

/**
 * @param {object} deps
 * @param {string} [deps.projectId]
 * @param {string} [deps.sessionId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeReportIssueTool({ projectId, sessionId, ctx }) {
  return tool(
    'report_issue',
    `Write to the maintainer of this HARNESS — the tools and environment you work
in. This goes to their issue list, not to the user.

This harness is in BETA and you are one of its primary testers: the maintainer
actively wants these reports and reads every one. When you hesitate between
reporting and not reporting — report. Three kinds:

- "bug": something in the harness behaved WRONGLY — a tool crashed on valid
  input, returned corrupt output, or contradicted its own description.
- "friction": it worked, but the path was painful — a missing parameter, a
  return shape you had to fight, a workaround (one detour is enough to report;
  the workaround IS the report).
- "idea": nothing is broken, but while working you saw something the harness
  could do better or do at all — a tool that should exist, a flag that would
  collapse three steps into one, a default that fights real usage, or a
  METHODOLOGY you worked out on the job (a technique, a judgment rule, a
  sequence that reliably works) that the harness should teach every session,
  bake into a skill, or automate. Good ones get built — report it rather than
  let it evaporate.

This is NOT a substitute for doing the work. Finish the task the way you would
have anyway — route around the problem, deliver the result — and log this on
the side. Never report and then hand back less than you could have.

Do NOT report:
- Your own mistakes (wrong path, malformed edit) — not harness issues
- A one-off flake that a single retry fixed (the automatic layer counts those);
  a flake that RECURS is friction — report it
- Anything about the design work itself (that belongs in the conversation)
- Praise or vague sentiment ("the tools are great", "X could be better
  somehow") — a report with no actionable content is noise

Be concrete. "screenshot is slow" is useless. "screenshot_canvas on a 6000px
site page takes ~14s and returns an image too large to read, so I crop by hand
every time; a viewportOnly flag would remove the whole detour" is actionable.`,
    {
      kind: z.enum(['bug', 'friction', 'idea'])
        .describe('bug = behaved wrongly · friction = worked but painful · idea = improvement worth building'),
      summary: z.string().min(8).max(200)
        .describe('One line. bug/friction: what is wrong, concrete. idea: the improvement itself, not "improve X".'),
      detail: z.string().min(20).max(3000)
        .describe('What you were doing and what happened (bug/friction: include the workaround you used; idea: the real situation that made you want this).'),
      // 选填（2026-08-18）：以前是必填，agent 不传就被 zod 打回 —— **信箱把上报挡在
      // 门外**，库里有 4 次这样的失败。能提当然好，提不出来也别丢掉这条上报。
      expectation: z.string().min(10).max(1500).optional()
        .describe('If you can name it: bug → the correct behaviour; friction → what would remove the detour; idea → what it looks like once built and what it unlocks. Leave it out rather than padding it.'),
      toolName: z.string().max(80).optional()
        .describe('The tool involved, if it is about one (e.g. "mcp__nodesign__screenshot_canvas").'),
    },
    async ({ kind, summary, detail, expectation, toolName }) => {
      try {
        const rec = recordIssue({
          source: 'agent',
          kind,
          toolName: toolName || null,
          summary,
          detail,
          expectation,
          projectId,
          sessionId,
          userId: projectId ? getProject(projectId)?.ownerId : null,
          // 按"摘要 + 工具"归一化：同一个抱怨反复出现是累加计数，不是刷屏
          signature: signatureOf(`${toolName || ''}|${summary}`),
        });
        if (!rec) {
          return {
            content: [{ type: 'text', text: 'Could not write the report (logged server-side). Carry on with the task.' }],
            isError: true,
          };
        }
        try {
          // ℹ️ 遥测事件：前端刻意不消费 —— 摩擦上报的读者是站主（信箱/审计），不是当场的用户
          ctx?.emit?.({ type: 'run.friction_reported', kind, summary, toolName: toolName || null, count: rec.count });
        } catch { /* emit fail-safe */ }
        return {
          content: [{
            type: 'text',
            text: rec.count > 1
              ? `Logged (this is the ${rec.count}th time this one has come up). Now carry on and finish the task.`
              : 'Logged. Now carry on and finish the task.',
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `report_issue failed: ${err?.message || String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
