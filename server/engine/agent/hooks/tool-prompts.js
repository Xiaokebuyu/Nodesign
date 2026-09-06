/**
 * 工具 prompt lazy 注入文件加载（首调即缓存）。仿 agents/index.js loadPrompt 模式。
 *
 * 用途：cookbook / vision-checker-dispatch 这些 reference 文档
 * 不放系统 prompt 恒驻（每 turn 拖累），改由 PreToolUse hook 在 agent 首次调对应工具时
 * 通过 additionalContext 注入。文件存 prompts/tools/*.md，模块加载时一次性读完缓存到 map。
 *
 * fail-soft：缺失 / 读失败返回 stub 字符串，hook 注入也不至于崩；console.warn 让部署
 * 日志能立刻发现。
 */
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// prompts/ 住在 agent/ 层（本模块在 agent/hooks/ 下一层，要往上跳一级）
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'tools');

const TOOL_PROMPT_CACHE = {};
export function loadToolPrompt(name) {
  if (TOOL_PROMPT_CACHE[name] !== undefined) return TOOL_PROMPT_CACHE[name];
  const file = path.join(PROMPTS_DIR, `${name}.md`);
  try {
    TOOL_PROMPT_CACHE[name] = fsSync.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[hooks] failed to load tool prompt ${name}.md (${err.message}); using stub`);
    TOOL_PROMPT_CACHE[name] =
      `(tool prompt ${name}.md not found at ${file}. PreToolUse hook will skip lazy injection — `
      + `agent fallbacks to whatever guidance lives in SKILL.md core.)`;
  }
  return TOOL_PROMPT_CACHE[name];
}
