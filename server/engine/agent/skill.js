/**
 * skill.js — Skill 加载器（YAML frontmatter + Markdown body）
 *
 * Skill 文件结构（兼容 Anthropic SKILL.md 标准 + Claude Code skills）：
 *   server/engine/skills/<skill-id>/SKILL.md
 *
 * SKILL.md 格式：
 *   ---
 *   name: deskskill-engine
 *   version: 0.0.1
 *   description: 给 LLM 看的"什么时候用我"的描述
 *   ---
 *
 *   # System Prompt
 *
 *   你是一个 deck 设计 agent...（任意 markdown）
 *
 *
 * MVP：
 *   - 只解析 YAML frontmatter + body
 *   - body 直接当 systemPrompt 传给 SDK
 *   - 不做 references/ 子目录递归加载（Claude Code 那套）
 *   - 不做 cache_control 切分（SDK 的 systemPrompt 数组 + SYSTEM_PROMPT_DYNAMIC_BOUNDARY 留 P3.5+）
 *
 * 未来扩展：
 *   - 嵌套 references/<file>.md 自动 inline
 *   - YAML frontmatter 加 model / effort / tools 的默认值
 *   - 拼 cache boundary：把 description + body 切静态/动态两段
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Skill 根目录（存放 <skill-id>/SKILL.md）*/
export const SKILLS_ROOT = path.resolve(
  process.env.NODESIGN_SKILLS_DIR || path.join(__dirname, '../skills')
);

/**
 * 加载一个 skill。返回 { id, name, version, description, systemPrompt, raw }。
 * 找不到时抛 Error（code='SKILL_NOT_FOUND'）。
 */
export async function loadSkill(skillId) {
  if (!skillId || typeof skillId !== 'string') {
    throw Object.assign(new Error('loadSkill: skillId required'), { code: 'INVALID_SKILL_ID' });
  }

  const skillDir = path.join(SKILLS_ROOT, skillId);
  const skillFile = path.join(skillDir, 'SKILL.md');

  let raw;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(
        new Error(`skill not found: ${skillId} (expected at ${skillFile})`),
        { code: 'SKILL_NOT_FOUND' }
      );
    }
    throw err;
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    id: skillId,
    name: frontmatter.name || skillId,
    version: frontmatter.version || '0.0.0',
    description: frontmatter.description || '',
    systemPrompt: body.trim(),
    frontmatter,
    raw,
  };
}

/**
 * 列出 SKILLS_ROOT 下所有 skill。
 * 每条返回 { id, name, version, description }（不读 body）
 */
export async function listSkills() {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_ROOT, entry.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile, 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      skills.push({
        id: entry.name,
        name: frontmatter.name || entry.name,
        version: frontmatter.version || '0.0.0',
        description: frontmatter.description || '',
      });
    } catch { /* ignore broken skills */ }
  }
  return skills;
}

// ── frontmatter 解析（极简 YAML：只支持 key: value）──

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * 解析 SKILL.md 的 frontmatter + body。
 * 不支持嵌套 / 多行 / list — 只接受 `key: value` 形态。
 *
 * 没 frontmatter 的文件：返回 { frontmatter: {}, body: <整个文件> }
 */
function parseFrontmatter(raw) {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };

  const [, yamlText, body] = m;
  const frontmatter = {};
  for (const line of yamlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // 去掉成对引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: body || '' };
}

// 暴露供单测
export { parseFrontmatter };
