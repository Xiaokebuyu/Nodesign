/**
 * server/lib/plugin-origin.js — 从市场装来的 plugin 的来源记录（2026-09-08）
 *
 * 装的时候在 <plugin>/.claude-plugin/nodesign-origin.json 记一笔 { publicationId, skillSha256, installedAt }。
 * 用途两个：
 *   - 追溯：这份 skill 是从哪条发布来的、装的是哪一版字节（改过没有一比 sha 就知道）
 *   - 撤回：站主 revoke 一条发布后，plugin-loader 在会话 init 时按来源问一次「这条还在不在」，
 *     不在就跳过不加载（文件留在盘上，用户自己删）。判决函数由外环注入（setPluginOriginPolicy）：
 *     hosted 直接查库，本地版看 relay 目录里站点给的 revoked 名单。内核自己不认识市场。
 *
 * 用户自己上传 / crystallize 的 plugin 没有这个文件，policy 不会被问到。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ORIGIN_FILE = 'nodesign-origin.json';

export async function writePluginOrigin(pluginDir, { publicationId, skillSha256, site = null }) {
  await fs.writeFile(
    path.join(pluginDir, '.claude-plugin', ORIGIN_FILE),
    JSON.stringify({ publicationId, skillSha256, site, installedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

/** @returns {Promise<{ publicationId: string, skillSha256?: string, site?: string|null, installedAt?: string } | null>} */
export async function readPluginOrigin(pluginDir) {
  try {
    const o = JSON.parse(await fs.readFile(path.join(pluginDir, '.claude-plugin', ORIGIN_FILE), 'utf8'));
    return o && typeof o.publicationId === 'string' ? o : null;
  } catch { return null; }
}

/** @type {(origin: object) => boolean | Promise<boolean>} 回 true = 这份已被撤回，别加载 */
let policy = () => false;

export function setPluginOriginPolicy(fn) { policy = typeof fn === 'function' ? fn : () => false; }

export async function isPluginOriginRevoked(origin) {
  try { return !!(await policy(origin)); }
  catch (err) { console.warn('[plugin-origin] policy 抛错，按未撤回处理：', err.message); return false; }
}
