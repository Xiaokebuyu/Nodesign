/**
 * mcp/tools/export-handoff.js — export_handoff MCP tool
 *
 * agent 觉得设计到了交付时机时主动调，把 canvas.html / spec.json /
 * assets / chat-history / README 打包成 handoff.zip。
 *
 * 复用 server/api/exports.js 的 buildHandoffZip pipeline，agent 端和
 * 用户按钮路径输出一致。
 *
 * 输出位置：写到 workspace/exports/handoff-<ts>.zip。agent 不能直接给
 * 用户文件，所以告诉用户路径，用户从前端 UI 看到 / 下载。
 *
 * 调用约定（agent 端）：
 *   mcp__nodesign__export_handoff
 *     notes?: string  可选记录"为什么这个时机交付"
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildHandoffZip } from '../../../api/exports.js';
import { getProject, listRunsForProject } from '../../../projects/store.js';

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {string} [deps.projectId]
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeExportHandoffTool({ workspaceRoot, projectId, ctx }) {
  return tool(
    'export_handoff',
    `Build a handoff zip package containing the current design, spec, assets,
chat history, and a README. Use this when you decide the design is ready to
deliver to the user (or the user explicitly says "give it to me" / "export").

The zip is written to workspace/exports/handoff-<timestamp>.zip. After
building, tell the user the path so they can download it via the UI.

Returns: text describing the path + size.

Use this tool when:
- The design meets the user's brief and you've verified it (e.g., via screenshot_canvas)
- The user says "I want this delivered" / "package it up" / "give me the files"

Do NOT use this tool when:
- The design is still in iteration
- canvas.html doesn't exist yet`,
    {
      notes: z
        .string()
        .optional()
        .describe('Optional notes about why exporting now (gets logged but not in the zip)'),
    },
    async ({ notes }) => {
      try {
        let projectMeta = null;
        let runs = [];
        if (projectId) {
          try {
            projectMeta = getProject(projectId);
            runs = listRunsForProject(projectId);
          } catch { /* DB not available 或 project 已删 */ }
        }

        const buf = await buildHandoffZip(workspaceRoot, {
          projectId: projectMeta?.id || projectId || 'unknown',
          projectName: projectMeta?.name || 'design',
          skillId: projectMeta?.skillId,
          runs,
        });

        const exportDir = path.join(workspaceRoot, 'exports');
        await fs.mkdir(exportDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const relPath = `exports/handoff-${stamp}.zip`;
        const absPath = path.join(workspaceRoot, relPath);
        await fs.writeFile(absPath, buf);

        try {
          ctx?.emit?.({
            type: 'run.export_built',
            format: 'handoff',
            path: relPath,
            sizeBytes: buf.length,
            notes: notes || null,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Handoff zip built: ${relPath} (${(buf.length / 1024).toFixed(1)} KB). `
              + `Tell the user the package is ready — they can download it from the UI's export menu.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Export handoff failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
