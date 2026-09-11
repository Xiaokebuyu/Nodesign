/**
 * server/lib/plugin-install.js — plugin 安装 / 卸载核心（2026-07-30 从 api/plugins.js 抽出）
 *
 * 抽出来的原因：crystallize_skill 工具也要往用户的 plugin 根写东西。如果它自己写盘，
 * 就会有第二条不走 validator 的落盘路径——name 合规、保留名、frontmatter 校验、
 * staging 原子 rename 这些全得再实现一遍，且迟早跟上传路径漂移。现在两边同一条。
 *
 * 返回 { status, body } 而不是抛异常：HTTP 路由直接透传，MCP 工具按 status 分支。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { validateSkillUpload, extractToStaging } from './plugin-validator.js';

// plugin name 合规检查（同 validator，但卸载路径需独立查）
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RESERVED_PLUGIN_NAMES = new Set([
  'nodesign', 'claude', 'anthropic', 'system', 'builtin', 'default',
]);

/** 覆盖安装时旧目录让位的名字标记：`.staging/<name>.old-<时间>`（plugin name 不许有点，撞不上真插件） */
const ASIDE_MARK = '.old-';

/** 上次没删掉的让位目录尽力清掉；清不掉不算事 */
async function sweepAsides(stagingRoot) {
  let names = [];
  try { names = await fs.readdir(stagingRoot); } catch { return; }
  for (const n of names) {
    if (!n.includes(ASIDE_MARK)) continue;
    await fs.rm(path.join(stagingRoot, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

export function isValidPluginName(name) {
  return typeof name === 'string'
    && PLUGIN_NAME_RE.test(name)
    && !RESERVED_PLUGIN_NAMES.has(name);
}

export async function installPluginToRoot(buffer, targetRoot, { force } = {}) {
  const validation = await validateSkillUpload(buffer);
  if (!validation.ok) {
    return { status: 400, body: { error: 'validation failed', errors: validation.errors } };
  }
  const { manifest, skills, warnings, mode } = validation;
  const targetDir = path.join(targetRoot, manifest.name);

  let existingManifest = null;
  try {
    const raw = await fs.readFile(path.join(targetDir, '.claude-plugin', 'plugin.json'), 'utf8');
    existingManifest = JSON.parse(raw);
  } catch { /* not installed */ }

  if (existingManifest && !force) {
    return {
      status: 409,
      body: {
        error: 'plugin already installed',
        existing: {
          name: existingManifest.name,
          version: existingManifest.version || '0.0.0',
          description: existingManifest.description || '',
        },
        incoming: manifest,
        hint: '加 ?force=true 强制覆盖（旧 plugin 目录会被删除）',
      },
    };
  }

  // staging：装到目标 root 下的 .staging/<tmpId>/，方便 atomic rename 同设备
  await fs.mkdir(targetRoot, { recursive: true });
  const stagingRoot = path.join(targetRoot, '.staging');
  await fs.mkdir(stagingRoot, { recursive: true });
  const tmpDir = path.join(stagingRoot, `${manifest.name}-${Date.now().toString(36)}`);
  await fs.mkdir(tmpDir);

  // ⭐ 覆盖安装不以"删得掉旧的"为前提（09-11，同 e03d44aa 给组件修的那个病）：
  // 原来是先 rm 旧目录再 rename 新目录 —— Windows 上 rename 随时可能 EPERM（杀软在扫、有文件被攥着），
  // 那一刻旧版已经没了，"升级失败"变成"插件没了"。现在旧目录先挪进 .staging 让位，
  // 新目录就位了才去删它；新的就不了位就把旧的挪回来。挪都挪不动 → 旧版原样留着，这次算装失败。
  const cleanup = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  await sweepAsides(stagingRoot);
  try {
    await extractToStaging({ buffer, validation, stagingDir: tmpDir });
  } catch (err) {
    await cleanup(tmpDir);
    throw err;
  }
  let aside = null;
  if (existingManifest) {
    aside = path.join(stagingRoot, `${manifest.name}${ASIDE_MARK}${Date.now().toString(36)}`);
    try {
      await fs.rename(targetDir, aside);
    } catch (err) {
      await cleanup(tmpDir);
      throw err;
    }
  }
  try {
    await fs.rename(tmpDir, targetDir);
  } catch (err) {
    if (aside) {
      try { await fs.rename(aside, targetDir); } catch (back) {
        console.error(`[plugin-install] ${manifest.name}：新版就不了位，旧版也挪不回去，旧版留在 ${aside}：`, back?.message || back);
      }
    }
    await cleanup(tmpDir);
    throw err;
  }
  if (aside) await cleanup(aside);   // 清不掉只是占地方，下次安装开头 sweepAsides 再试

  return {
    status: existingManifest ? 200 : 201,
    body: {
      installed: { ...manifest, path: targetDir, skills },
      replaced: existingManifest || null,
      warnings,
      uploadMode: mode,  // 'single-md' / 'single-skill-zip' / 'plugin-zip' — UI 用 toast
    },
  };
}

export async function uninstallFromRoot(rootDir, name) {
  if (!isValidPluginName(name)) {
    return { status: 400, body: { error: `plugin name \`${name}\` 不合规或是保留名` } };
  }
  const targetDir = path.join(rootDir, name);
  const resolved = path.resolve(targetDir);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    return { status: 400, body: { error: 'invalid target path' } };
  }
  try {
    await fs.access(targetDir);
  } catch {
    return { status: 404, body: { error: `plugin \`${name}\` not installed` } };
  }
  await fs.rm(targetDir, { recursive: true, force: true });
  return { status: 200, body: { uninstalled: name } };
}
