/**
 * agent/memory-config.js — auto-memory 的产品化配置（2026-08-24 记忆体系改版）
 *
 * 记忆两层的分工（用户拍板）：
 *   - `记忆/`（工作区根下，画布可见）：SDK auto-memory 的家。提示词、写入、
 *     MEMORY.md 索引加载、权限放行全跟 autoMemoryDirectory 一个值走（二进制 yh()，
 *     08-24 探明）。用户看得到每一条、也可能直接改。
 *   - 根 `CLAUDE.md`：人工筛选的项目档案（指引/风格/习惯），SDK 每会话
 *     确定性全量注入（settingSources 'project' 原生行为，根目录与 .claude/ 两处都读）。
 *
 * ⚠️ EXTRA_GUIDELINES 是**追加**不是替换：SDK 自己的记忆合同（frontmatter 契约、
 * 两步写入、200 行索引上限与截断提醒）原样保留。别换成 CLAUDE_COWORK_MEMORY_GUIDELINES
 * 整段替换 —— 那会把截断提醒一起抹掉，而截断逻辑仍在跑，索引爆了没人说话。
 */

import path from 'node:path';

/** 记忆目录名（工作区根相对）。画布可见是设计要求，不是巧合。 */
export const MEMORY_DIR_NAME = '记忆';

export function memoryDirFor(sharedRoot) {
  return path.join(sharedRoot, MEMORY_DIR_NAME);
}

/** 追加进 SDK 记忆提示末尾的产品口径（env CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES） */
export const MEMORY_EXTRA_GUIDELINES = [
  'This memory directory (记忆/) is VISIBLE on the user\'s canvas — they can read',
  'every file and may edit them between sessions; treat edits as ground truth.',
  'Keep file names as short English kebab-case slugs (the SDK contract), but write',
  'descriptions and content in the user\'s language (中文 for this product).',
  'When a style decision is settled (palette / fonts / materials / art direction),',
  'record it as a `type: project` memory right away — style anchors are the most',
  'expensive thing to lose between sessions.',
  'Hard constraints and curated project guidance live in the workspace-root',
  'CLAUDE.md (deterministically injected every session) — put lasting rules there',
  '(with the user\'s consent), and put evolving facts here.',
].join(' ');

/**
 * 把我们的 settings 跟 isolationOptions.settings **深合并**成 SDK 的最终 settings。
 *
 * ⛔ 存在的理由（08-24 案）：08-15 起 buildIsolationOptions 的返回值里也有
 * settings 键，query options 里对象展开写在后面，把独立写的 settings 整个覆盖 ——
 * autoMemoryEnabled / autoMemoryDirectory / skipWebFetchPreflight 八天没送到
 * SDK 手里（agent 照 SDK 默认路径写记忆被沙盒拒、~/.claude 下堆了 187 个空目录）。
 * 「两处同名键静默互吞」没有任何报错，出口断言在这里兜。
 */
export function mergeAgentSettings(isolationSettings, extra = {}) {
  // ⚠️ 这个第二参是**显式白名单**（它存在的理由就是防 settings 互吞）。所以它有一个
  // 结构性陷阱：往调用点里塞一个这里没解构的新键 = 那个键被静默丢弃，零症状。
  // 2026-08-26 真踩：`crossSessionInbound: 'refuse'`（跨会话入向闸）在调用点写得好好的，
  // 到了 SDK 手里根本不存在 —— 修互吞案的函数自己吞了新键。
  // 所以未知键**当场炸**：白名单的代价必须由加键的人当场付，不能由线上静默付。
  const { skipWebFetchPreflight, sharedRoot, crossSessionInbound, ...unknown } = extra;
  const unknownKeys = Object.keys(unknown);
  if (unknownKeys.length) {
    throw new Error(
      `[memory-config] mergeAgentSettings 收到不认识的键：${unknownKeys.join(', ')} —— `
      + '这个第二参是显式白名单，加新键要同时改这里的解构和下面的出口断言，别指望它透传',
    );
  }

  const settings = {
    ...isolationSettings,
    skipWebFetchPreflight,
    // 跨会话入向（2026-08-26）：实测——不是推断——Nodesign 的每个会话都会以 cwd
    // 派生的名字注册进**本机 peer 名册**（生产上正在跑的用户会话当时显示为
    // `shared-6d`），同机任何一个 Claude 会话 ListAgents 都看得见、都能按名字寄信。
    // SDK 默认「权限模式相同就自动投递」（bypass↔bypass），而我们正是
    // bypassPermissions → 本机任何 bypass 会话都能把文本注进用户会话的上下文。
    // 出向那侧我们自己拦（hooks/pre-peer-guard.js），入向只有这一个旋钮。
    // ⛔ 别写 'hold'：那是「存起来等人批准」，而服务端没有人在批。
    ...(crossSessionInbound ? { crossSessionInbound } : {}),
    ...(sharedRoot ? {
      autoMemoryEnabled: true,
      autoMemoryDirectory: memoryDirFor(sharedRoot),
    } : {}),
  };
  if (sharedRoot && !settings.autoMemoryDirectory) {
    throw new Error('[memory-config] settings.autoMemoryDirectory 被吞了 —— 检查 settings 合并处');
  }
  // 出口断言按「传进来的每个键都要在出口活着」逐条对，不是只看一个样本键
  if (crossSessionInbound && settings.crossSessionInbound !== crossSessionInbound) {
    throw new Error('[memory-config] settings.crossSessionInbound 被吞了 —— 跨会话入向闸会静默失效');
  }
  return settings;
}
