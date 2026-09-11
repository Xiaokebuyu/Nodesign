/**
 * export-target.js — 导出落盘的三件算术（2026-09-10）。从 main.js 拆出来是为了能测：
 * 路径拼接和重名让位这种东西，出错的方式都很安静（写去了别的目录、悄悄盖掉上一份）。
 *
 * 背景见 web/src/lib/deliver-file.js：桌面版不再走 Chromium 下载，主进程自己写盘。
 */
import path from 'node:path';

/** Windows 文件名收不了的字符 + 控制字符 */
const BAD_CHARS = new RegExp('[<>:"|?*\\u0000-\\u001f]', 'g');

/**
 * 页面给的文件名只当**文件名**用：剥掉目录（`../..` 一并没了）、去掉收不了的字符。
 * 桥的另一头是我们自己的页面，但"存哪儿"这件事不能由页面说了算 —— 目录归主进程定。
 */
export function safeFileName(name) {
  // posix.basename：分隔符上一行已经统一成 `/`；用 path.basename 的话 Windows 上会把 `a:b.zip` 的 `a:` 当盘符剥掉（09-11 CI 抓到）
  const base = path.posix.basename(String(name || '').replace(/[\\/]+/g, '/')) || '导出';
  return base.replace(BAD_CHARS, '_').slice(0, 180) || '导出';
}

/**
 * 导出往哪儿写：prefs.exportDir 有、是绝对路径、目录还在 → 用它；否则回默认（系统「下载」）。
 * prefs.json 由服务端那半在写（server/runtime/local-prefs.js 校验），这里只读，读不懂就当没有。
 */
export function exportDirFrom(prefs, fallbackDir, isDirectory) {
  const d = prefs?.exportDir;
  if (typeof d === 'string' && path.isAbsolute(d)) {
    try { if (isDirectory(d)) return d; } catch { /* 目录没了 / 权限没了 → 回默认 */ }
  }
  return fallbackDir;
}

/**
 * 重名让位：`x.zip` → `x (2).zip` → `x (3).zip`。
 * ⭐ 09-09 那案就是靠这条读出来的：同名存了五次、**一次序号都没加过** —— 说明每次存之前
 * 上一份已经不在了。所以这个行为本身是个证据源，别改成"直接覆盖"。
 */
export function uniqueTarget(dir, filename, exists) {
  const base = safeFileName(filename);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let target = path.join(dir, base);
  for (let i = 2; exists(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);
  return target;
}
