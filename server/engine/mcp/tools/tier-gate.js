/**
 * mcp/tools/tier-gate.js —— 按账号档位（auth/tier.js）给 MCP 工具套闸的包装器（08-21 晚）。
 *
 * 为什么是包装器而不是改工具本体：generate-image.js / web-search.js 都是行数棘轮
 * 冻结的胖户（拆不抬），而且"谁能用这个工具"跟"这个工具怎么干活"本来就是两层。
 * 闸按**项目 owner** 算（同 publish_site / paint_still / roll_film 一把尺），不看请求者、
 * 不看会话跑在哪个模型上（用户 08-21 拍板：只做档位隔离，不做模型隔离）。
 *
 * 用法（mcp/index.js 工具列表里）：
 *   withTierGate(makeGenerateImageTool({...}), 'imageGen', projectId)
 *   withTierGate(makeWebSearchTool({...}), 'webSearch', projectId)   // basic 档附带日上限
 */
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { can, webSearchDailyCap, DENIAL } from '../../../auth/tier.js';
import { makeRateWindow } from '../../../lib/rate-window.js';
import { checkQuota, imageChargeUsd } from '../../../lib/quota.js';

/** 项目 owner 的用户对象；无主 / 找不到 → null（tier.can(null) 一律 false，fail-closed） */
export function ownerOfProject(projectId) {
  const ownerId = projectId ? getProject(projectId)?.ownerId : null;
  return ownerId ? getUserById(ownerId) : null;
}

// basic 档 web_search 日上限：tavily/baidu 是花钱的，300 轮/天的回合闸拦不住一轮里连搜几十次。
// 内存滑动窗口按 owner 计（重启清零 —— 保护性关卡不是记账，同 rate-window.js 的定位）；
// 上限数字住 auth/tier.js 能力表（env NODESIGN_BASIC_WEB_SEARCH_PER_DAY，默认 60）。
const DAY_MS = 24 * 60 * 60 * 1000;
const dailyWindows = new Map();   // cap → rateWindow（cap 可被 env 改，按值分桶）
function takeDaily(ownerId, cap) {
  if (!dailyWindows.has(cap)) dailyWindows.set(cap, makeRateWindow({ limit: cap, windowMs: DAY_MS }));
  return dailyWindows.get(cap).take(ownerId);
}

const deny = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * 调用前判一次；返回 null = 放行，否则返回要原样交给 agent 的拒绝结果。
 * 拆出来是为了能不起 SDK 直接测（tier-gate.test.js）。
 */
export function tierDenial(projectId, capability, toolName) {
  return tierDenialForOwner(ownerOfProject(projectId), capability, toolName);
}

/** 同上，但直接给 owner（测试不用造项目）。 */
export function tierDenialForOwner(owner, capability, toolName) {
  if (!can(owner, capability)) {
    const why = capability === 'imageGen' ? DENIAL.imageGen
      : capability === 'webSearch' ? '当前账号档位不含联网搜索。请如实转告用户，不要重试。'
        : `当前账号档位不含 ${toolName}。请如实转告用户，不要重试。`;
    return deny(`${toolName} denied: ${why}`);
  }
  if (capability === 'webSearch') {
    const cap = webSearchDailyCap(owner);
    if (cap != null) {
      const r = takeDaily(owner.id, cap);
      if (!r.ok) {
        const hrs = Math.ceil(r.retryAfterMs / 3_600_000);
        return deny(`${toolName} denied: basic 档每天最多 ${cap} 次联网搜索，今日额度已用尽（约 ${hrs} 小时后恢复）。请如实转告用户，本回合不再发起搜索。`);
      }
    }
  }
  return null;
}

/**
 * 给 SdkMcpToolDefinition 套闸：handler 前先问档位，其余字段原样透传。
 * imageGen（08-21 深夜 basic 开放生图）还多两步：调用前过 owner 的日限（checkQuota，admin 不限）；
 * 成功出图后 ctx.addToolCharge('generate_image', $0.20) 记进本回合账（quota.usedCostToday 同一本）。
 */
export function withTierGate(toolDef, capability, projectId, ctx = null) {
  return {
    ...toolDef,
    handler: async (args, extra) => {
      const denied = tierDenial(projectId, capability, toolDef.name);
      if (denied) return denied;
      if (capability === 'imageGen') {
        const owner = ownerOfProject(projectId);
        const q = checkQuota(owner);
        if (!q.ok) return deny(`${toolDef.name} denied: ${DENIAL.imageQuota}`);
      }
      const result = await toolDef.handler(args, extra);
      if (capability === 'imageGen') chargeForImage(result, ctx);
      return result;
    },
  };
}

/** 出了图才记账（result 非 error 且 content 里有 image 块）；返回记了多少（0 = 没记） */
export function chargeForImage(result, ctx) {
  const ok = result && !result.isError && Array.isArray(result.content) && result.content.some((b) => b?.type === 'image');
  if (!ok) return 0;
  const usd = imageChargeUsd();
  ctx?.addToolCharge?.('generate_image', usd);
  return usd;
}
