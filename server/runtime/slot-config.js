/**
 * server/runtime/slot-config.js — 插槽配置从哪来（2026-09-10）。
 *
 * 「内置表之外还有哪些模型行」这件事有两个来源，形状完全一样，只是存放处不同：
 *   - **本地分发版**：用户机器上的 `<dataRoot>/config.json`（runtime/local-config.js）
 *   - **站点**：站主在管理台上填的那份，存库（lib/site-model-slots.js）
 *
 * 两边共用同一个 `validateLocalConfig` —— 页面上标红的那句话和启动日志里那句是同一句。
 * model-context.js 的 buildIndex 只认这一个入口，不必知道配置到底存在文件里还是库里。
 *
 * 口径（二选一，不叠加）：**有本地配置文件路径就只读文件**（本地分发版、以及测试用
 * NODESIGN_MODELS_CONFIG 指过来的场合），否则读站点那份。叠加会让"这行到底哪来的"变成一道谜题。
 *
 * ⚠️ 站点那份多一条放宽：允许 `upstream` 直接写内置上游名（allowBuiltinUpstreams）——
 *    站主加一行挂在已有网关上的模型，不该被逼着把网关连钥匙再声明一遍。理由见 local-config.js 那处注释。
 */

import { validateLocalConfig, configPath, loadLocalConfig } from './local-config.js';
import { readSiteSlots } from '../lib/site-model-slots.js';

/** 站点那份：读库 → 同一个 validate（放宽内置上游引用） */
export function loadSiteConfig() {
  const stored = readSiteSlots();
  const v = validateLocalConfig(stored.raw, { allowBuiltinUpstreams: true });
  return {
    ...v,
    errors: [...stored.errors, ...v.errors],
    raw: stored.raw,
    source: 'site',
    path: null,
    exists: !!stored.updatedAt,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/**
 * buildIndex 唯一的入口：这台机器上"内置表之外的行"是哪一份。
 * @returns {{upstreams: object, models: object[], errors: object[], raw: object|null, source: 'local'|'site', path: string|null}}
 */
export function loadSlotConfig() {
  if (configPath) return { ...loadLocalConfig(), source: 'local' };
  return loadSiteConfig();
}
