/**
 * server/lib/plugin-extract.js — 校验通过的上传包解到 staging（2026-09-08 从 plugin-validator.js 拆出，行数棘轮）
 *
 * 两个函数都假定 validateSkillUpload 已经过，这里只留 path 安全的二次防御。
 * plugin-zip 解完会把 plugin.json **重写**成只含 name / version / description：清单里的 hooks / mcpServers
 * 一类字段不落盘（组件白名单拦文件，这里拦字段）。
 */

import JSZip from 'jszip';

/**
 * 把校验通过的 zip 解压到目标目录（atomic：先解到 staging，调用方完成后 rename）。
 *
 * 注意：本函数假定 `validatePluginZip` 已经过，**只关心 path 安全**这一项二次防御。
 *
 * @param {Buffer} buffer
 * @param {string} stagingDir - 已建好的空目录绝对路径
 * @param {string} rootPrefix - validate 时识别的 wrapper 前缀（可能是 '' 或 'foo/'）
 * @returns {Promise<void>}
 */
export async function extractPluginZip(buffer, stagingDir, rootPrefix = '') {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const zip = await JSZip.loadAsync(buffer);
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // 去 wrapper 前缀
    if (rootPrefix && !entryPath.startsWith(rootPrefix)) continue;
    const relativePath = rootPrefix ? entryPath.slice(rootPrefix.length) : entryPath;
    if (!relativePath) continue;
    // 二次防御：拒绝 .. / 绝对路径（应该已被 validate 拦但保险）
    if (relativePath.includes('..') || relativePath.startsWith('/')) {
      throw new Error(`unsafe entry path during extract: ${relativePath}`);
    }
    const targetPath = path.join(stagingDir, relativePath);
    // 校验解压后路径仍在 stagingDir 下（resolve 后比较 prefix）
    const resolvedTarget = path.resolve(targetPath);
    const resolvedStaging = path.resolve(stagingDir);
    if (!resolvedTarget.startsWith(resolvedStaging + path.sep) && resolvedTarget !== resolvedStaging) {
      throw new Error(`extract target escapes staging dir: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = await entry.async('nodebuffer');
    await fs.writeFile(targetPath, content);
  }
}

/**
 * 把校验通过的 upload 解到 stagingDir，按 SDK plugin 目录结构布局。
 *
 * mode 多态分派：
 *   - 'single-md'        → 写 plugin.json + skills/<name>/SKILL.md
 *   - 'single-skill-zip' → 解 zip 全部内容到 skills/<name>/（含 patterns/ 等附件）+ 写 plugin.json
 *   - 'plugin-zip'       → 走旧 extractPluginZip 逻辑（直接解压）
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer
 * @param {object} opts.validation - validateSkillUpload 返回
 * @param {string} opts.stagingDir - 已建好的空目录绝对路径
 */
export async function extractToStaging({ buffer, validation, stagingDir }) {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  if (validation.mode === 'plugin-zip') {
    await extractPluginZip(buffer, stagingDir, validation.rootPrefix);
    // 清单永远重写成只含 name / version / description：用户带来的 hooks / mcpServers 一类字段不落盘
    // （SDK 会读 manifest 里的组件声明，组件白名单只拦文件，这里拦字段）
    await fs.writeFile(
      path.join(stagingDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: validation.manifest.name, version: validation.manifest.version, description: validation.manifest.description }, null, 2),
      'utf8',
    );
    return;
  }

  // 写 plugin.json（single-md 和 single-skill-zip 都要）
  const manifestDir = path.join(stagingDir, '.claude-plugin');
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({
      name: validation.manifest.name,
      version: validation.manifest.version,
      description: validation.manifest.description,
    }, null, 2),
    'utf8',
  );

  const skillDir = path.join(stagingDir, 'skills', validation.manifest.name);
  await fs.mkdir(skillDir, { recursive: true });

  if (validation.mode === 'single-md') {
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), validation.rawText, 'utf8');
    return;
  }

  if (validation.mode === 'single-skill-zip') {
    const zip = await JSZip.loadAsync(buffer);
    const prefix = validation.skillRootPrefix || '';
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (prefix && !entryPath.startsWith(prefix)) continue;
      const relativePath = prefix ? entryPath.slice(prefix.length) : entryPath;
      if (!relativePath) continue;
      // 二次防御
      if (relativePath.includes('..') || relativePath.startsWith('/')) {
        throw new Error(`unsafe entry path during extract: ${relativePath}`);
      }
      const targetPath = path.join(skillDir, relativePath);
      const resolvedTarget = path.resolve(targetPath);
      const resolvedSkill = path.resolve(skillDir);
      if (!resolvedTarget.startsWith(resolvedSkill + path.sep) && resolvedTarget !== resolvedSkill) {
        throw new Error(`extract target escapes skill dir: ${relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await entry.async('nodebuffer');
      await fs.writeFile(targetPath, content);
    }
    return;
  }

  throw new Error(`unknown validation.mode: ${validation.mode}`);
}
