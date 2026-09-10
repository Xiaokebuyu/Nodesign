/**
 * server/runtime/local-prefs.js — 本地分发版的用户偏好（<dataRoot>/prefs.json）。
 *
 * 跟 .env（钥匙与开关，白名单制）分开：这里放的是**应用体验**层面的选择——模型选择器里藏哪些行、
 * 默认模型——不是凭据。界面字体 / 缩放 / 语言在浏览器 localStorage 里（前端自己管，改了立刻生效不用请求）。
 *
 * 只有这几个键，且每个都有校验；不认识的键丢掉。hosted 下不读不写（多用户站的偏好在账号上，另说）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { profile } from './profile.js';

export const prefsPath = profile.isLocal ? path.join(profile.dataRoot, 'prefs.json') : null;

const DEFAULTS = Object.freeze({
  hiddenModels: [],     // 选择器里不列的行（appModel id）；设置页「模型」的开关
  defaultModel: null,   // 新会话默认模型（null = 表的默认）
  setupDone: false,     // 首启引导页走过了（装完或点了「稍后」）
  componentsDir: null,  // 外部程序装哪（绝对路径；null = <dataRoot>/components）。09-08 站主：不能只装 C 盘
  extraBinDirs: [],     // 用户自己装在别处的程序目录（D:\LibreOffice\program 这类），能力探针先搜这些
  exportDir: null,      // 导出往哪儿写（绝对路径；null = 系统「下载」）。09-10 站主：导出的存放位置要能自己定
});

let cache = null;

export function loadPrefs() {
  if (!prefsPath) return { ...DEFAULTS };
  if (cache) return cache;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch { raw = {}; }
  cache = sanitize(raw);
  return cache;
}

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (Array.isArray(raw?.hiddenModels)) out.hiddenModels = [...new Set(raw.hiddenModels.filter((x) => typeof x === 'string' && x))];
  if (typeof raw?.defaultModel === 'string' && raw.defaultModel) out.defaultModel = raw.defaultModel;
  if (raw?.setupDone === true) out.setupDone = true;
  if (typeof raw?.componentsDir === 'string' && path.isAbsolute(raw.componentsDir)) out.componentsDir = raw.componentsDir;
  if (typeof raw?.exportDir === 'string' && path.isAbsolute(raw.exportDir)) out.exportDir = raw.exportDir;
  if (Array.isArray(raw?.extraBinDirs)) out.extraBinDirs = [...new Set(raw.extraBinDirs.filter((x) => typeof x === 'string' && path.isAbsolute(x)))].slice(0, 20);
  return out;
}

/** 合并写入（只动传进来的键）；返回写后的全量 */
export function savePrefs(patch) {
  if (!prefsPath) throw new Error('hosted profile 没有本地偏好文件');
  const next = sanitize({ ...loadPrefs(), ...(patch || {}) });
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  const tmp = `${prefsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, prefsPath);
  cache = next;
  return next;
}

/** 测试用 */
export function _resetPrefsCache() { cache = null; }
