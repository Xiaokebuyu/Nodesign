/**
 * pre-workspace-scope-guard —— 结构化工具的项目边界闸（2026-08-15）
 *
 * 沙盒（bwrap）只管 Bash。Read / Grep / Glob / Write / Edit 是 SDK 进程内工具，
 * 不进 bwrap —— 2026-08-15 探针实测：沙盒开着，Read 照样能读别的项目的工作区，
 * Write 照样能往 cwd 外落文件。凭据那部分由 permissions.deny 盖住了
 * （runtime/platform.js），**但"别人的项目"盖不住**：deny 规则没有"除了自己这个"
 * 的写法（deny 压过 allow），而项目是动态新建的。
 *
 * 两条判据，读写不一样严：
 *   - **写**（Write/Edit/NotebookEdit）：只准落在自己的工作区或临时目录。
 *     写东西到别处没有任何正当理由 —— 产物都在工作区里。
 *   - **读**（Read/Grep/Glob）：只拦数据根内部的越界。仓库、plugin/skill 目录、
 *     /tmp 照读不误 —— 那是干活要用的（skill 附件就在仓库里）。
 *
 * 边界（故意窄，别自己脑补更严）：
 *   - 凭据不归它管（那是 platform.protectedPathRules 的活，两边别互相假设）。
 *   - 自己出错就放行（fail-open）—— 闸崩了不该把整个会话堵死。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHALK_DIR } from '../../../lib/chalk.js';
import { ROLE_SLUG_RE } from '../cast.js';

const TARGET_FIELDS = ['file_path', 'path', 'notebook_path'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function insideDir(abs, dir) {
  return abs === dir || abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** 临时目录（沙盒会把 TMPDIR 指到自己那份，两个都认） */
function tempDirs() {
  return [process.env.TMPDIR, os.tmpdir(), '/tmp'].filter(Boolean).map(d => path.resolve(d));
}

/**
 * @returns {null | string} null=放行；string=拒绝理由
 */
export function checkWorkspaceScope(toolInput, { workspaceRoot, dataRoot, toolName } = {}) {
  if (!workspaceRoot) return null;
  const ws = path.resolve(workspaceRoot);
  const isWrite = WRITE_TOOLS.has(toolName);
  if (!isWrite && !dataRoot) return null;
  const root = dataRoot ? path.resolve(dataRoot) : null;
  for (const field of TARGET_FIELDS) {
    const v = toolInput?.[field];
    if (typeof v !== 'string' || !v) continue;
    const abs = path.resolve(ws, v);          // 相对路径按工作区解析
    // ⛔ 角色文件是**判据本身**，不许模型手写（2026-08-26 fable 验收）。
    //
    // 派发闸靠读 `.claude/agents/<slug>.md` 的 tools 行决定放不放行，可那份文件
    // 模型自己能改 —— 于是闸校验的和 CLI 真正使用的**不是同一份内容**：
    //   ① TOCTOU：写宽版 → 结束回合（CLI 缓存了宽版）→ 覆写成窄版 → 同回合派发。
    //      我们现读磁盘拿窄版放行，CLI 用回合开工的宽版快照 → 角色真拿到外发/花钱工具。
    //   ② 解析器分歧：重复的 `tools:` 键，我们的正则取第一处、CLI 的 YAML 取最后一处。
    // 两条都不是对主 agent 提权（它本来就有这些工具），但这条线的正常用法是**导入
    // 酒馆卡/世界书**——外来文本能借主 agent 的手造出一个拿着外发工具的角色。
    // 修法只能是「让判据不可被它改」：正门 cast_role 走服务端 fs（不过这道闸），
    // 模型这侧一律拒。⚠️ Bash 不归这道闸管，那半靠沙盒（isolation.js）。
    if (isWrite && insideDir(abs, path.join(ws, '.claude', 'agents'))) {
      return '角色文件不能手写 —— 用 cast_role。'
        + '那个目录里的文件同时是「这个角色能用哪些工具」的判据，'
        + '手写等于自己给自己发权限，所以一律拒绝（改已有角色也走 cast_role）。';
    }
    // 接续权的文件面（2026-08-27 编排）：角色写的板书文件，主 agent 不许 Edit/Write。
    // 板上那半（reply_to/chain）在 write-on-board 闸；这里堵的是「直接改文件正文」——
    // 改别人的台词比接别人的话头更越界。作者看文件自己的 by: 章（harness 盖的，
    // 角色没有 Write 工具伪造不了）。读不到/没有章 → 放行（fail-open，主 agent 自己的板书本来就能改）。
    if (isWrite && insideDir(abs, path.join(ws, ...CHALK_DIR.split('/')))) {
      try {
        const m = fs.readFileSync(abs, 'utf8').slice(0, 400).match(/^by:\s*(\S+)/m);
        // 判据统一走 ROLE_SLUG_RE（08-27 审计）：真角色名必过它
        if (m && ROLE_SLUG_RE.test(m[1])) {
          return `这份板书是角色「${m[1]}」写的，它的话不是你的稿子 —— 不改、不润色、不代笔。`
            + '想让它改：把意见寄给它（SendMessage）或让用户直接跟它说。';
        }
      } catch { /* 新建/读不到 → 放行 */ }
    }
    if (insideDir(abs, ws)) continue;         // 自己的工作区，放行
    if (isWrite) {
      if (tempDirs().some(d => insideDir(abs, d))) continue;   // 临时文件随便写
      return `${toolName} 只能落在你自己的工作区里（${ws}），或者临时目录。`
        + '产物、草稿、附件全都归工作区管；往外写一律拒绝。';
    }
    if (!root || !insideDir(abs, root)) continue;   // 数据根之外的读不归这道闸管
    return '这个路径在别的项目的工作区里，不是你这个项目的东西。'
      + `你的工作区是 ${ws} —— 用相对路径就好，越过它去读写别人的项目一律拒绝。`;
  }
  return null;
}

export function makePreToolUseWorkspaceScopeGuard({ workspaceRoot, dataRoot }) {
  return async (input) => {
    try {
      const reason = checkWorkspaceScope(input?.tool_input, {
        workspaceRoot, dataRoot, toolName: input?.tool_name,
      });
      if (!reason) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    } catch { return {}; }                    // 闸自己出错不拦工具（fail-open）
  };
}
