/**
 * server/runtime/chromium-fix.js — 缺 Chromium 时给人看的装法（09-17，问题库 iss_mtudxax7_86c5 / iss_mu0e6ur9_irvd）
 *
 * 本地版（npx / 桌面）走组件管理器：runtime/components.js 从镜像下载，不再调 `playwright install`
 * （它的官方源国内不通），桌面用户机器上也没有 npx。托管版是站主自己的机器，照旧用 playwright 的装法。
 *
 * 单独成文件只依赖 platform.js：能力表（capabilities.js）和导出接口（api/exports.js）两个读者共用这一句，
 * 导出接口不必为一句文案把能力表那一串依赖（rembg / 盒子 / relay）拉进来。
 */
import { platform } from './platform.js';

export function chromiumFix(isLocal = platform.isLocal) {
  return isLocal ? '设置 → 组件 → Chromium 安装' : 'npx playwright install chromium';
}
