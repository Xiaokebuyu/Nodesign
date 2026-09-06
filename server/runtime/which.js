/**
 * runtime/which.js —— 跨平台 which：PATH（Windows 连 PATHEXT）+ 调用方给的额外目录。找不到返回 null。
 * 09-07 从 capabilities.js 拆出来：能力探测要问工具层的选路（relay-tools.js），而工具层又要用 which，
 * 放一起就是环。
 */
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

export function whichBinary(name, extraDirs = []) {
  if (!name) return null;
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs];
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWin && !name.toLowerCase().endsWith(ext) ? name + ext : name);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}
