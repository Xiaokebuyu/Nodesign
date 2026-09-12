import { formatAllowed, KIND_SITE } from '../../lib/artifact-target.js';

/**
 * 形态 × 格式守卫（注册表驱动）：不适用的格式提前 400，不白烧 playwright /
 * esbuild。以前是 if kind === site 的散装判断，第三种形态进来就得再改一轮 ——
 * 现在各形态可用的格式表在 kinds/ 注册条目里，这里只查表。
 */
export function rejectFormat(res, target, formatId, label) {
  if (formatAllowed(target.kind, formatId)) return false;
  res.status(400).json({
    error: `${target.relPath} 是 ${target.kind} —— ${label} 导出不适用于这种形态。`
      + (target.kind === KIND_SITE ? '站点请用「整站打包」（/exports/site）或导出菜单里的站点 zip。' : ''),
  });
  return true;
}
