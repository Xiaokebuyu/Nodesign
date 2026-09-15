/**
 * server/runtime/bundled-crt.js — LibreOffice 组件自带的 VC++ 运行库挪到 soffice 旁边（09-15，问题库 iss_mu2gpsxk_30vh）。
 *
 * 现象：桌面版一台机器上 soffice.com / soffice.bin 一律退出码 127，没有任何输出、不起进程，docx 渲页整条线不可用。
 * 病根：组件包是 `msiexec /a` 管理安装抽出来的（.github/workflows/components.yml）。MSI 里的 VC++ 运行库是合并模块，
 * 真装时进 System32；管理安装只把它们铺在包根的 `System64/`（32 位那份在 `System/`），**不在 program/ 里**。
 * 而 program/ 下的 sal3.dll、mergedlo.dll 要 MSVCP140*.dll / VCRUNTIME140*.dll，soffice.bin 要 VCRUNTIME140.dll。
 * 用户机器装过 VC++ 2015-2022 x64 运行库就从 System32 拿到了（站主那台就是），没装的那台加载器找不到 DLL，
 * Git Bash 里就是 127。
 *
 * 做法：把 `System64/*.dll` 拷进 `program/`。应用目录在 DLL 搜索顺序里排在 System32 前面，所以拷进去之后
 * 用的是包里这一整套，不会跟用户机器上旧版本的 msvcp140 混搭（rembg 09-10 案就是半套混搭，见 components.yml）。
 * 组件工作流从这版起在打包时就拷好；这里给**已经装了旧包的机器**就地补上，不用重新下 570MB。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir  LibreOffice 组件的安装目录（记录里的 dir，包根：下面有 program/ 与 System64/）
 * @returns {{ copied: string[], skipped?: string }}
 */
export function ensureLibreOfficeCrt(dir, { platform = process.platform } = {}) {
  if (platform !== 'win32') return { copied: [], skipped: 'not-win32' };
  if (!dir) return { copied: [], skipped: 'no-dir' };
  const program = path.join(dir, 'program');
  const crt = path.join(dir, 'System64');
  if (!fs.existsSync(program) || !fs.existsSync(crt)) return { copied: [], skipped: 'layout' };
  const copied = [];
  for (const name of fs.readdirSync(crt)) {
    if (!/\.dll$/i.test(name)) continue;
    const dst = path.join(program, name);
    // 包里已经带着的（新工作流打的包）不动：同一批文件，覆盖只会在 soffice 开着时撞 EBUSY
    if (fs.existsSync(dst)) continue;
    try { fs.copyFileSync(path.join(crt, name), dst); copied.push(name); }
    catch (err) { console.warn(`[components] LibreOffice 运行库 ${name} 拷不进 program/：${err.code || err.message}`); }
  }
  if (copied.length) console.log(`[components] LibreOffice：把包里的 VC++ 运行库放到 soffice 旁边（${copied.join(', ')}）`);
  return { copied };
}
