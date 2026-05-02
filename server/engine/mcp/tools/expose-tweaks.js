/**
 * mcp/tools/expose-tweaks.js — expose_tweaks MCP tool
 *
 * agent 看完 deck 内容后，把这份 deck 专属的"可调参数控制台"暴露成 schema，
 * 写到 spec.json 的 spec.tweaks 字段。前端 TweaksPanel 读 schema 渲染
 * sliders / color picker / segmented，拖动直接改 iframe :root CSS variable
 * 实时预览（不落盘）；用户点 Apply 触发新 chat run，让 agent 把当前数值固化
 * 进 canvas.html 的 :root。
 *
 * spec.json 结构：
 *   spec.tweaks = {
 *     version: 1,
 *     controls: [{ id, type, label, target_var?, target_class_on?, ... }],
 *     updatedAt, updatedBy: 'agent',
 *   }
 *
 * 触发时机（详见 SKILL.md "Tweaks 暴露协议"）：
 *   - 写完 deck 主动暴露 5-8 个核心可调参数
 *   - 用户问"哪些可以调"时
 *   - 用户在前端点了 Apply 时把 inline style 固化进 :root（这种 case agent
 *     除了写 canvas.html 还应该 expose_tweaks 更新 default 值）
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ControlSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'id must be kebab/snake case'),
  type: z.enum(['slider', 'color', 'segmented', 'toggle', 'select']),
  label: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  target_var: z
    .string()
    .regex(/^--[a-zA-Z0-9-]+$/, 'target_var must be a CSS custom property starting with --')
    .optional(),
  target_class_on: z.string().optional(),
  // A6.2：CSS selector 限定 control 影响范围。不传默认 ":root"（全局）。
  // 例：'section[data-page="1"]' / '[data-layout="cover"]' / '[data-purpose*="数据"]'
  // 配合 SKILL.md HTML 规范的"per-page scoped override"教学（让"封面字号"slider
  // 不牵连内页字号）。前端 TweaksPanel 应用时 doc.querySelector(scope) 找元素
  // 在它身上 setProperty 而不是 :root。
  target_scope: z
    .string()
    .max(120)
    .optional()
    .describe('CSS selector for scope (e.g. \'section[data-page="1"]\'); default ":root" applies globally. Use to limit one control to one page / one layout type.'),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().max(8).optional().describe('Suffix appended to numeric value, e.g. "px", "%"'),
  options: z.array(z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
  })).optional(),
});

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeExposeTweaksTool({ workspaceRoot, ctx }) {
  return tool(
    'expose_tweaks',
    `Expose a "tweaks schema" for the current deck — a list of UI controls
(slider, color picker, segmented control, toggle, select) that the user can
drag in the frontend to live-tweak the design without going through chat.

Each control points at a CSS custom property (target_var, must start with --)
or a class to toggle on root (target_class_on). Frontend renders the controls,
binds onChange to set CSS variable on iframe :root for instant preview.

Use this tool when:
- You finished writing/editing canvas.html and want to expose 5-8 most
  valuable tunables (hero font size, accent color, layout density, etc.)
- The user asks "what can I adjust"
- After the user clicks Apply on the frontend Tweaks panel — re-expose with
  updated default values matching what was just baked into :root

The schema is merged into spec.json's spec.tweaks field. Pass replace=true
to wipe existing controls; default false merges by id.

Frontend will refresh once it sees run.tweaks_exposed event.`,
    {
      controls: z.array(ControlSchema).min(1).max(20).describe('Tweak controls to expose'),
      replace: z
        .boolean()
        .optional()
        .describe('If true, replace all existing controls; default false merges by id'),
    },
    async ({ controls, replace }) => {
      try {
        if (!workspaceRoot) {
          return {
            content: [{ type: 'text', text: 'No workspace bound; cannot expose tweaks.' }],
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

        const existing = (spec.tweaks && Array.isArray(spec.tweaks.controls))
          ? spec.tweaks.controls
          : [];

        let merged;
        if (replace) {
          merged = controls;
        } else {
          const byId = new Map(existing.map(c => [c.id, c]));
          for (const c of controls) byId.set(c.id, c);
          merged = [...byId.values()];
        }

        spec.tweaks = {
          version: 1,
          controls: merged,
          updatedAt: new Date().toISOString(),
          updatedBy: 'agent',
        };

        await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');

        try {
          ctx?.emit?.({
            type: 'run.tweaks_exposed',
            count: merged.length,
            added: controls.length,
            replaced: !!replace,
          });
        } catch { /* emit fail-safe */ }

        return {
          content: [{
            type: 'text',
            text: `Exposed ${controls.length} tweak control(s); spec.tweaks now has ${merged.length} total.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `expose_tweaks failed: ${err?.message || String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
