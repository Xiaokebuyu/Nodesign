/**
 * mcp/tools/record-decision.js — record_decision MCP tool
 *
 * agent 在做关键设计决策时调，把"做了什么 + 为什么"沉淀到 spec.json
 * 的 decisions[]。这是设计意图档案的核心 —— 跨 session 帮 agent 拿回
 * 上下文（"我之前为什么选了 #3366FF？哦，因为 brief 说要专业 + 信任感"）。
 *
 * spec.json 结构（约定）：
 *   {
 *     history: [{ ts, source, summary }],     // C7 PostCompact 写
 *     decisions: [{                           // C11 这个工具写
 *       ts: ISO,
 *       title: string,
 *       rationale: string,
 *       scope?: string,
 *       alternatives?: string[],
 *     }],
 *     ...
 *   }
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeRecordDecisionTool({ workspaceRoot, ctx }) {
  return tool(
    'record_decision',
    `Record a key design decision into spec.json's decisions[] array. Use this
to capture WHY you made a particular choice — color, type scale, layout
metaphor, copy strategy. The record persists across sessions, so when you
resume work later you (or another agent) can read spec.json and recover the
design intent.

Use this tool when:
- You make a non-trivial choice that has multiple defensible alternatives
  (e.g., picking a primary color, deciding deck length, choosing a layout)
- The user gives feedback that changes a previous decision (record both)
- You want to document a constraint discovered mid-work

Do NOT use this tool for:
- Trivial implementation details (CSS class names, file structure)
- Things obvious from the canvas itself (the visible design speaks for itself)
- Every change — over-recording bloats spec.json and dilutes signal`,
    {
      title: z
        .string()
        .min(2)
        .max(200)
        .describe('Short decision title (e.g., "Primary color = #3366FF")'),
      rationale: z
        .string()
        .min(2)
        .max(2000)
        .describe('Why this choice — connect to brief / user feedback / design principle'),
      scope: z
        .string()
        .optional()
        .describe('Where it applies (e.g., "Global", "Cover page", "All H1 headings")'),
      alternatives: z
        .array(z.string())
        .optional()
        .describe('Alternatives considered, briefly noting why rejected'),
    },
    async ({ title, rationale, scope, alternatives }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot record decision.' }],
            isError: true,
          };
        }

        const specPath = path.join(workspaceRoot, 'spec.json');
        let spec = {};
        try {
          const raw = await fs.readFile(specPath, 'utf8');
          spec = JSON.parse(raw);
          if (!spec || typeof spec !== 'object') spec = {};
        } catch {
          spec = {};
        }

        if (!Array.isArray(spec.decisions)) spec.decisions = [];

        const entry = {
          ts: new Date().toISOString(),
          title: title.trim(),
          rationale: rationale.trim(),
          ...(scope ? { scope: scope.trim() } : {}),
          ...(Array.isArray(alternatives) && alternatives.length
            ? { alternatives: alternatives.map(s => String(s).trim()).filter(Boolean) }
            : {}),
        };
        spec.decisions.push(entry);

        await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');

        try {
          ctx?.emit?.({
            type: 'run.decision_recorded',
            title: entry.title,
            scope: entry.scope || null,
            decisionsCount: spec.decisions.length,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Decision recorded in spec.json (decisions[${spec.decisions.length - 1}]): "${entry.title}"`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Record decision failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
