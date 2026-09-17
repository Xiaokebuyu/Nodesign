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
 * 注意：格式深度校验在 plugin-validator.js（上传时）。加载时只再判一件事：**组件白名单**（09-17，见
 * pluginLoadViolations）。原来这里假设「已装的都过过 validator」，可项目级根在工作区里，agent 自己就能写，
 * 写进去的 hooks 在下个会话由 CLI 宿主进程在沙盒外执行（09-17 探针实测）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPluginOrigin, isPluginOriginRevoked, ORIGIN_FILE } from '../../lib/plugin-origin.js';
import { disallowedComponents, frontmatterStrictErrors } from '../../lib/plugin-components.js';
import { recordIssue, signatureOf } from '../../lib/issues-store.js';

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
 * ── 加载时的组件校验（09-17）──
 *
 * 上传口的组件白名单（lib/plugin-components.js）只管从正门进来的包。项目级 plugin 根
 * `<工作区>/.claude/plugins` 在 agent 的工作区里，Write 与 Bash 都写得进去（09-17 以前）；导入的酒馆卡、
 * 网页内容里的注入指令能借 agent 的手造出一个带 hooks 的 plugin，下个会话 CLI 宿主进程加载它，
 * hooks 在沙盒外执行（探针实测）。写入那侧另有两道闸（isolation.js 的 denyWrite、
 * pre-workspace-scope-guard），这里是主闸：用户级与项目级 plugin 逐个列文件树，用上传口同一张表判，
 * 有一个不许的文件就整个跳过。内置 plugin 不走这里：它在仓库里随代码发布，写保护靠 isolation.js 的 denyWrite
 * 与 platform.protectedPathRules 的仓库只读。
 *
 * 清单同口径：上传时清单被重写成只剩 name / version / description（plugin-extract.js），
 * 所以清单里出现 hooks / mcpServers / agents / commands / skills（自定义路径）等组件声明一律不许；
 * 为了不误伤 09-08 之前原样落盘的旧清单，放过几条纯元数据字段。
 * 市场装的来源记录 `.claude-plugin/nodesign-origin.json` 是服务端写的，SDK 不读它，放行。
 * 根目录下的**空** `.mcp.json` 放行：用户级 plugin 目录是会话的 additionalDirectories，别的会话跑 Bash 时
 * CLI 会在那里临时建一个空的 .mcp.json 占位（命令结束就删），开局扫描正好撞上不该把 plugin 判掉；
 * 所有 plugin 都带 skipMcpDiscovery，空文件也不声明任何服务。
 * SKILL.md 的 frontmatter 同口径（lib/plugin-components.js 的键白名单）：`hooks:` 写在 skill 里，
 * skill 被调用时同样在沙盒外执行（09-17 探针实测），上传口 09-17 起拒，这里把 09-17 之前装进来的
 * 与 agent 手写的一起挡住。
 */
const MANIFEST_KEYS_OK = new Set(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', '$schema']);
/** 文件树上限：每会话开局扫一次，正常 plugin 只有几个文件；超过就当不合规（别让一棵大树拖慢开局） */
export const PLUGIN_TREE_MAX_ENTRIES = 500;
const PLUGIN_TREE_MAX_DEPTH = 8;
const SKILL_MD_MAX_BYTES = 1024 * 1024;

/**
 * @param {string} pluginDir
 * @param {object} manifest  已解析的 .claude-plugin/plugin.json
 * @returns {Promise<string[]>} 不许出现的条目（空 = 可以加载）。条目是相对路径；清单字段写成 `plugin.json#<键>`
 */
export async function pluginLoadViolations(pluginDir, manifest) {
  const bad = Object.keys(manifest || {}).filter((k) => !MANIFEST_KEYS_OK.has(k)).map((k) => `.claude-plugin/plugin.json#${k}`);
  const files = [];
  let seen = 0;
  const walk = async (dir, rel, depth) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (++seen > PLUGIN_TREE_MAX_ENTRIES) throw Object.assign(new Error('too many'), { code: 'ND_TREE_LIMIT' });
      const r = rel ? `${rel}/${e.name}` : e.name;
      // 软链一律不许：正门装出来的 plugin 只有普通文件，软链能把组件名指到别处
      if (e.isSymbolicLink()) bad.push(`${r}（软链）`);
      else if (e.isDirectory()) {
        if (depth >= PLUGIN_TREE_MAX_DEPTH) bad.push(`${r}/（层级超过 ${PLUGIN_TREE_MAX_DEPTH}）`);
        else await walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        const { size } = await fs.stat(full);
        if (r === '.mcp.json' && size === 0) continue;   // CLI 的临时占位
        files.push(r);
        // 大小写不敏感：macOS 的文件系统上 skill.md 就是 SKILL.md
        if (e.name.toLowerCase() === 'skill.md') {
          if (size > SKILL_MD_MAX_BYTES) { bad.push(`${r}（超过 ${SKILL_MD_MAX_BYTES} 字节）`); continue; }
          const fm = frontmatterStrictErrors(await fs.readFile(full, 'utf8'));
          if (fm.length) bad.push(`${r}（${fm[0]}）`);
        }
      } else bad.push(`${r}（不是普通文件）`);
    }
  };
  try {
    await walk(pluginDir, '', 0);
  } catch (err) {
    bad.push(err.code === 'ND_TREE_LIMIT' ? `（文件超过 ${PLUGIN_TREE_MAX_ENTRIES} 个）` : `（文件树读不出来：${err.code || err.message}）`);
  }
  bad.push(...disallowedComponents(files.filter((r) => r !== `.claude-plugin/${ORIGIN_FILE}`), 'plugin'));
  return bad;
}

/** 跳过一个不合规的 plugin：日志 + 问题库（同一个 plugin 同一组文件聚成一行计数） */
function reportRejectedPlugin({ sourceLabel, pluginDir, name, bad, projectId, userId }) {
  const shown = bad.slice(0, 8).join(', ') + (bad.length > 8 ? ` 等 ${bad.length} 项` : '');
  console.error(`[plugin-loader] ${sourceLabel}/${path.basename(pluginDir)}（${name}）含不许加载的组件，整个跳过：${shown}`);
  try {
    recordIssue({
      source: 'auto',
      kind: 'bug',
      toolName: 'plugin_loader',
      summary: `${sourceLabel} 级 plugin「${name}」含不许加载的组件，已跳过`,
      detail: `目录 ${pluginDir}\n不许的条目：${bad.join(', ')}\n`
        + '上传口的组件白名单只收 plugin.json 与 skills/<id>/ 下的文本和图片；出现 hooks / agents / commands / .mcp.json 等，'
        + '多半是 agent 在工作区里自己写出来的（可能来自导入内容里的注入指令），请人工查看再删除。',
      projectId: projectId || null,
      userId: userId || null,
      signature: signatureOf(`plugin_loader|${sourceLabel}|${name}|${bad.slice(0, 20).join(',')}`),
    });
  } catch { /* 记账失败不影响跳过 */ }
}

/**
 * 扫单个 plugin root 下所有 plugin 目录，返回每个 plugin 的 {path, skills}
 *
 * @param {string} rootDir
 * @param {string} sourceLabel - 'builtin' | 'user' | 'project'，仅用于日志
 * @param {{ projectId?: string, userId?: string }} [who] - 不合规时记问题库用
 * @returns {Promise<Array<{ path: string, name: string, skills: string[] }>>}
 */
async function scanPluginRoot(rootDir, sourceLabel, who = {}) {
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

    // 组件白名单（09-17）：用户级与项目级逐个判，不合规整个跳过（理由见 pluginLoadViolations 头注释）
    if (sourceLabel !== 'builtin') {
      const bad = await pluginLoadViolations(pluginDir, manifest);
      if (bad.length) {
        reportRejectedPlugin({ sourceLabel, pluginDir, name: manifest.name, bad, ...who });
        continue;
      }
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
 *   userRoot: string|null,   // 本项目 owner 的用户 plugin 根（isolation.js 的读围栏按它开天窗，09-17）
 *   diagnostics: { builtin: number, user: number, project: number }
 * }>}
 */
export async function loadInstalledPlugins({ projectId, userId } = {}) {
  const userRoot = getUserPluginsRoot(userId);
  const who = { projectId, userId };
  // 三 root 并行扫
  const [builtin, user, projectLocal] = await Promise.all([
    scanPluginRoot(path.dirname(PLUGIN_ROOT), 'builtin')
      // builtin root = `server/engine/plugins/`（PLUGIN_ROOT 的父目录），里面只该有 nodesign
      // 但为了将来支持系统自带多个 plugin，统一扫
      .then(items => items.filter(p => p.path === PLUGIN_ROOT)),
    userRoot ? scanPluginRoot(userRoot, 'user', who) : Promise.resolve([]),
    projectId
      ? scanPluginRoot(getProjectPluginsRoot(projectId), 'project', who)
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
    userRoot,
    diagnostics: {
      builtin: builtin.length,
      user: user.length,
      project: projectLocal.length,
    },
  };
}
