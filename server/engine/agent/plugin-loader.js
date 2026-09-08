/**
 * server/engine/agent/plugin-loader.js — 已装 plugin 扫描 + 合并
 *
 * session-loop 启动时调用，扫三个来源的 plugin，合并成 SDK options 直接吃的形态：
 *
 *   1. **内置**：server/engine/plugins/nodesign/（PLUGIN_ROOT，恒存在）
 *   2. **用户级**：<userHome>/.nodesign/plugins/<plugin>/（用户从 /skills 页面装）
 *   3. **project 级**：<projects-data>/<pid>/shared/.claude/plugins/<plugin>/（从 SystemTab 装）
 *
 * 返回的形态对接 SDK：
 *   { plugins: [{ type: 'local', path }, ...],   // 每个 plugin 一项
 *     skills:  [skillName1, skillName2, ...] }   // 所有 plugin 内 SKILL.md frontmatter.name 合集
 *
 * 现状：plugin discovery 是 startup-time，不支持 hot-reload。装新 plugin 后必须重启 session 才生效。
 * 详见 plan 文件 § "Hot-reload v2"。
 *
 * 容错原则：
 *   - 单 plugin 不合规（缺 plugin.json / SKILL.md / frontmatter.name 等）→ 跳过该 plugin，
 *     warn 日志，**不影响其他 plugin 加载**
 *   - 三个 root 缺失（用户首次跑没装过任何用户级 plugin）→ 返空数组不报错
 *
 * 注意：本模块**只做发现**，不做格式深度校验。深度校验在 plugin-validator.js（上传时）。
 * 这里假设已装的 plugin 是合规的（validator 通过才能装到目标位置）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPluginOrigin, isPluginOriginRevoked } from '../../lib/plugin-origin.js';

import { PLUGIN_ROOT, parseFrontmatter } from './skill.js';
import { getSharedDir } from '../../projects/workspace.js';

/** 用户级 plugin 总根：~/.nodesign/plugins/。env override 给测试用 */
export function getUserPluginsBaseRoot() {
  return process.env.NODESIGN_USER_PLUGINS_DIR
    || path.join(os.homedir(), '.nodesign', 'plugins');
}

/** 用户 id 只该是 users 表那种 `u_xxx`（登录墙关时是 `_anon`）；别的一律不当目录名 */
const USER_DIR_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 某个用户的 plugin 根：~/.nodesign/plugins/<userId>/
 *
 * 2026-07-30 分用户：原来所有人共用总根，任何登录用户装的 plugin 会加载进**每个人**
 * 的 agent 会话（loader 对所有 project 都扫这个根），也能删掉别人的。project 级
 * 早就按 owner 隔离了，用户级是内测隔离唯一漏网的一处。
 *
 * userId 缺失/不合法 → 返 null（调用方按"没有用户级 plugin"处理），不退回总根：
 * 退回去就等于把漏洞留成 fallback。
 */
export function getUserPluginsRoot(userId) {
  if (!userId || !USER_DIR_RE.test(String(userId))) return null;
  return path.join(getUserPluginsBaseRoot(), String(userId));
}

/** project 级 plugin 根：<shared>/.claude/plugins/ */
export function getProjectPluginsRoot(projectId) {
  if (!projectId) return null;
  return path.join(getSharedDir(projectId), '.claude', 'plugins');
}

/** 内置 plugin 根（PLUGIN_ROOT 的父目录，包含 nodesign） */
export function getBuiltinPluginsRoot() {
  return path.dirname(PLUGIN_ROOT);
}

/**
 * 列单个 plugin root 下所有 plugin 目录，返带 manifest + skills 详情的列表。
 *
 * 跟 `scanPluginRoot`（内部用）的区别：这个 export 给 API / UI 用，返 manifest 完整字段
 * + 每个 skill 的 id/name/version/description；scanPluginRoot 只返 SDK options 需要的
 * skill name 字符串数组。
 *
 * @param {string} rootDir
 * @returns {Promise<Array<{
 *   name, version, description, path,
 *   skills: Array<{id, name, version, description}>
 * }>>}
 */
export async function listInstalledPluginsDetailed(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.staging') continue;
    const pluginDir = path.join(rootDir, entry.name);
    const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    let manifest;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch { continue; }
    if (!manifest?.name) continue;

    const skillsDir = path.join(pluginDir, 'skills');
    const skills = [];
    let skillEntries;
    try {
      skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch { skillEntries = []; }
    for (const sk of skillEntries) {
      if (!sk.isDirectory()) continue;
      const skillFile = path.join(skillsDir, sk.name, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillFile, 'utf8');
        const { frontmatter } = parseFrontmatter(raw);
        skills.push({
          id: sk.name,
          name: frontmatter.name || sk.name,
          version: frontmatter.version || '0.0.0',
          description: frontmatter.description || '',
        });
      } catch { /* skip broken */ }
    }

    out.push({
      name: manifest.name,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      path: pluginDir,
      skills,
    });
  }
  return out;
}

/**
 * 扫单个 plugin root 下所有 plugin 目录，返回每个 plugin 的 {path, skills}
 *
 * @param {string} rootDir
 * @param {string} sourceLabel - 'builtin' | 'user' | 'project'，仅用于日志
 * @returns {Promise<Array<{ path: string, name: string, skills: string[] }>>}
 */
async function scanPluginRoot(rootDir, sourceLabel) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[plugin-loader] scan ${sourceLabel} root failed (${err.code}):`, err.message);
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(rootDir, entry.name);
    const manifestPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');

    let manifest;
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (err) {
      // ENOENT = 不是 plugin 目录（也许是其他随机文件夹），静默跳
      if (err.code !== 'ENOENT') {
        console.warn(`[plugin-loader] ${sourceLabel}/${entry.name} manifest 不合规，跳过：${err.message}`);
      }
      continue;
    }

    if (!manifest?.name) {
      console.warn(`[plugin-loader] ${sourceLabel}/${entry.name} plugin.json 缺 name，跳过`);
      continue;
    }

    // 从市场装来的：站主撤回过就不加载（lib/plugin-origin.js；没来源文件的不会被问到）
    const origin = await readPluginOrigin(pluginDir);
    if (origin && await isPluginOriginRevoked(origin)) {
      console.warn(`[plugin-loader] ${sourceLabel}/${entry.name} 来自已撤回的发布 ${origin.publicationId}，跳过`);
      continue;
    }

    // 扫该 plugin 内所有 skills/<id>/SKILL.md，取 frontmatter.name 作为 SDK skill name
    const skillsDir = path.join(pluginDir, 'skills');
    const skillNames = [];
    let skillEntries;
    try {
      skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[plugin-loader] ${manifest.name} skills/ 读取失败：${err.message}`);
      }
      // 没 skills/ 子目录也允许（SDK 可能有别的 plugin 组件，未来扩展），不算 error
      results.push({ path: pluginDir, name: manifest.name, skills: [] });
      continue;
    }

    for (const sk of skillEntries) {
      if (!sk.isDirectory()) continue;
      const skillFile = path.join(skillsDir, sk.name, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillFile, 'utf8');
        const { frontmatter } = parseFrontmatter(raw);
        if (frontmatter?.name) {
          skillNames.push(frontmatter.name);
        } else {
          console.warn(`[plugin-loader] ${manifest.name}/${sk.name} SKILL.md 缺 frontmatter.name，跳过`);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[plugin-loader] ${manifest.name}/${sk.name}/SKILL.md 读取失败：${err.message}`);
        }
      }
    }

    results.push({ path: pluginDir, name: manifest.name, skills: skillNames });
  }
  return results;
}

/**
 * 加载所有已装 plugin（内置 + 用户级 + project 级），返回 SDK options 形态。
 *
 * @param {object} opts
 * @param {string} [opts.projectId] - 不传则跳过 project 级扫描
 * @param {string} [opts.userId]    - 项目 owner 的用户 id；不传则跳过用户级扫描
 *                                    （不是"退回全局共享根"——那正是要修掉的东西）
 * @returns {Promise<{
 *   plugins: Array<{ type: 'local', path: string, skipMcpDiscovery: true }>,
 *   skills: string[],
 *   diagnostics: { builtin: number, user: number, project: number }
 * }>}
 */
export async function loadInstalledPlugins({ projectId, userId } = {}) {
  const userRoot = getUserPluginsRoot(userId);
  // 三 root 并行扫
  const [builtin, user, projectLocal] = await Promise.all([
    scanPluginRoot(path.dirname(PLUGIN_ROOT), 'builtin')
      // builtin root = `server/engine/plugins/`（PLUGIN_ROOT 的父目录），里面只该有 nodesign
      // 但为了将来支持系统自带多个 plugin，统一扫
      .then(items => items.filter(p => p.path === PLUGIN_ROOT)),
    userRoot ? scanPluginRoot(userRoot, 'user') : Promise.resolve([]),
    projectId
      ? scanPluginRoot(getProjectPluginsRoot(projectId), 'project')
      : Promise.resolve([]),
  ]);

  // 合并 + 去重（按 plugin name）—— 用户级或 project 级如果撞内置 name，跳过后者（内置优先）
  const seenNames = new Set();
  const plugins = [];
  const skills = [];

  for (const p of [...builtin, ...user, ...projectLocal]) {
    if (seenNames.has(p.name)) {
      console.warn(`[plugin-loader] plugin name \`${p.name}\` 重复（来源冲突），保留先发现的，跳后续`);
      continue;
    }
    seenNames.add(p.name);
    // skipMcpDiscovery：plugin 目录里的 .mcp.json / manifest 的 mcpServers 一概不读。上传的包里本来就不许带
    // （plugin-validator 组件白名单 + 清单重写），这里是第二道；strictMcpConfig 那行挡的是宿主机的 ~/.claude.json，
    // 别指望它顺带挡这个
    plugins.push({ type: 'local', path: p.path, skipMcpDiscovery: true });
    for (const skillName of p.skills) {
      // SDK skills 列表也去重（两个 plugin 同 skill name 取先发现的）
      if (!skills.includes(skillName)) skills.push(skillName);
    }
  }

  return {
    plugins,
    skills,
    diagnostics: {
      builtin: builtin.length,
      user: user.length,
      project: projectLocal.length,
    },
  };
}
