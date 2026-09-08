/**
 * server/lib/plugin-pack.js — 把一个已装的 plugin 目录打回 zip（2026-09-08，市场线）
 *
 * 用在两处：
 *   - 网页 / 本地版「导出」：Skill 管理页那句「先导出文件互传」以前指向一个不存在的按钮
 *   - 发布到市场：发布的是**当前装着的那份**，打成 zip 交给站点重新过一遍 validator
 *
 * 打出来的 zip 是 plugin-zip 形态（根上有 .claude-plugin/plugin.json），validateSkillUpload 认得。
 * 只收文本类和图片类文件，别的一律不进包：白名单直接用 plugin-validator 的 disallowedComponents，
 * 导出一个带 hooks/ 的 plugin 也只会得到它的 skill 部分——导出面和发布面口径一致，不然导出再上传
 * 就成了绕过白名单的路。
 *
 * 目录里的 .staging / 隐藏目录不打；单文件上限和总量上限沿用 plugin-validator 的 LIMITS。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

import { LIMITS, disallowedComponents } from './plugin-validator.js';
import { getUserPluginsRoot, listInstalledPluginsDetailed } from '../engine/agent/plugin-loader.js';
import { isValidPluginName } from './plugin-install.js';

/** 走目录树，回相对路径列表（正斜杠） */
async function walk(dir, rel = '', out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;   // 只有这个不走（太大）；别的都走完让 packableEntries 判，skipped 才列得全
      await walk(path.join(dir, e.name), relPath, out);
    } else if (e.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/** 一个 plugin 目录里哪些文件会进包：白名单就是 plugin-validator 的那一张（disallowedComponents），不另抄 */
export function packableEntries(relPaths) {
  const bad = new Set(disallowedComponents(relPaths, 'plugin'));
  return relPaths.filter((p) => !bad.has(p));
}

/**
 * @param {string} pluginDir 装好的 plugin 根（含 .claude-plugin/plugin.json）
 * @returns {Promise<{ buffer: Buffer, files: string[], skipped: string[] }>}
 */
export async function packPluginDir(pluginDir) {
  const all = await walk(pluginDir);
  const files = packableEntries(all);
  if (!files.includes('.claude-plugin/plugin.json')) throw new Error('不是 plugin 目录：缺 .claude-plugin/plugin.json');
  if (!files.some((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p))) throw new Error('plugin 里没有任何 skills/<id>/SKILL.md');
  if (files.length > LIMITS.ENTRY_MAX_COUNT) throw new Error(`文件数 ${files.length} 超过 ${LIMITS.ENTRY_MAX_COUNT}`);
  const zip = new JSZip();
  let total = 0;
  for (const rel of files) {
    const buf = await fs.readFile(path.join(pluginDir, rel));
    if (buf.length > LIMITS.ENTRY_MAX_BYTES) throw new Error(`${rel} 超过单文件上限`);
    total += buf.length;
    if (total > LIMITS.ZIP_MAX_BYTES) throw new Error('总大小超过上限');
    zip.file(rel, buf);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const skipped = all.filter((p) => !files.includes(p));
  return { buffer, files, skipped };
}

/**
 * 按用户 + plugin 名找到装好的目录。找不到 / 名字不合规 → null（不抛：调用方回 404）。
 * 只认用户级根；内置的 nodesign plugin 不能导出也不能发布（它不是谁的作品）。
 */
export async function findUserPluginDir(userId, name) {
  if (!isValidPluginName(name)) return null;
  const root = getUserPluginsRoot(userId);
  if (!root) return null;
  const hit = (await listInstalledPluginsDetailed(root)).find((p) => p.name === name);
  return hit ? { dir: hit.path, plugin: hit } : null;
}
