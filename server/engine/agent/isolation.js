/**
 * agent/isolation.js —— 会话隔离配置的单一来源（2026-08-15）
 *
 * 一件事被拆成两道闸，因为 SDK 的工具分两拨跑：
 *
 *   ① sandbox  → **只管 Bash**。bwrap 起独立 mount/net namespace：写只落工作区、
 *                 凭据读不到、env 里的 key 被 unset、AF_UNIX 与回环被切断、
 *                 外网走代理。开关在 runtime/platform.js（NODESIGN_SANDBOX=on）。
 *   ② settings.permissions.deny → 管 **Read / Grep / Glob / Write / Edit**。
 *                 这些是 SDK 进程内工具，根本不进 bwrap，沙盒对它们零作用。
 *
 * 缺一半等于没关。第三块（跨项目边界）在 hooks/pre-workspace-scope-guard.js ——
 * deny 规则写不出"除了自己这个项目"（deny 压过 allow，项目又是动态新建的）。
 *
 * 08-15 开这套时真跑出来的四件事，改之前先读：
 *   1. `dangerouslyDisableSandbox` 默认允许，agent 撞到偶发失败会自己拿它关沙盒
 *      —— 必须 allowUnsandboxedCommands:false 焊死。
 *   2. deny 规则的路径必须是**双斜杠**绝对形式，单斜杠静默失效。
 *   3. npm 默认缓存在 ~/.npm，沙盒里 HOME 不可写 → `npm i` EROFS，构建道整条断。
 *   4. 目录级 denyRead 拦得住读文件，拦不住 `ls` 看文件名（接受：名字不是秘密）。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { platform } from '../../runtime/platform.js';
import { autoModeSettings } from './auto-mode-rules.js';
import { MCP_ALLOW_RULE } from '../mcp/server-name.js';

/**
 * 会话要用的缓存/临时目录一次备齐（2026-08-19 从 session-loop 下沉）。
 *
 * - npmCacheDir：共用 npm 缓存（数据根下；内容寻址 + 完整性校验，跨会话共用
 *   不构成投毒面）。沙盒里 HOME 不可写，不给它 `npm i` 直接 EROFS。
 * - agentTmpDir：沙盒里 Bash 的 $TMPDIR。SDK 按 CLAUDE_CODE_TMPDIR 派生沙盒
 *   tmp（没设就 os.tmpdir()），而派生出来的 /tmp/claude 在 bwrap 里只读 ——
 *   agent 装个 py7zr 连撞四堵墙、venv 静默失败（iss_msz25m5p_v5so）。
 *   ⚠️ 必须短：SDK 二进制里有条 warn —— 这个路径超 ~30 字节时 AF_UNIX socket
 *   放不下，子进程 $TMPDIR **静默回退**默认值（= 白配）。所以挂 /tmp/nd 下、
 *   按项目分目录；沙盒里遮兄弟目录见 buildIsolationOptions。
 * - pip 缓存指进 agentTmpDir/pip，不然每条 pip 命令先吐一段
 *   ~/.cache/pip 不可写的 WARNING 噪音。
 *
 * 目录必须先存在 —— bwrap 绑一个不存在的路径会起不来；建不出来也不拦会话。
 * envPatch 直接摊进 sdkEnv。
 */
export async function prepareAgentDirs({ dataRoot, projectId, sessionId }) {
  const npmCacheDir = path.join(dataRoot, '.npm-cache');
  const agentTmpRoot = path.join(os.tmpdir(), 'nd');
  const agentTmpDir = path.join(agentTmpRoot, projectId || String(sessionId || 'anon').slice(0, 12));
  for (const d of [npmCacheDir, path.join(agentTmpDir, 'pip')]) {
    try { await fs.mkdir(d, { recursive: true }); } catch { /* 起不来也不该拦会话 */ }
  }
  return {
    npmCacheDir,
    agentTmpRoot,
    agentTmpDir,
    envPatch: {
      npm_config_cache: npmCacheDir,
      CLAUDE_CODE_TMPDIR: agentTmpDir,
      PIP_CACHE_DIR: path.join(agentTmpDir, 'pip'),
    },
  };
}

/**
 * bwrap 垫片的 env（PATH 前插一个目录，里面的 `bwrap` 是我们的包装脚本）
 *
 * 治的是 `apply-seccomp: unshare(CLONE_NEWUSER): Invalid argument` 这个偶发
 * —— 内核级竞态，机器越闲越容易撞，实测每十几次 Bash 调用炸一次，而且会把
 * agent 带进错误推断（有一次它干脆自己拿 `dangerouslyDisableSandbox` 绕过去）。
 * 原理与安全不变量写在 server/ops/sandbox-shim/bwrap 里。
 *
 * 📮 上游 issue：https://github.com/anthropics/claude-code/issues/86928
 * ⏳ **临时设施**：垫片认的是 SDK 内部的命令前缀，**SDK 一升级前缀变了就静默
 *    失效**（原样透传 = 悄悄退回那个偶发，不报错）。升级后查
 *    `<数据根>/.sandbox-shim.log` 里 `rewrote=1` 的计数还在不在涨；
 *    上游修好之后连这个函数带 ops/sandbox-shim/ 一起删掉。
 * 关掉：`NODESIGN_SANDBOX_SHIM=off`。
 */
export function sandboxShimEnv({ baseEnv = process.env, dataRoot } = {}) {
  if (!platform.sandboxEnabled) return {};
  if (process.env.NODESIGN_SANDBOX_SHIM === 'off') return {};
  const dir = path.join(platform.repoRoot, 'server', 'ops', 'sandbox-shim');
  return {
    PATH: `${dir}${path.delimiter}${baseEnv.PATH || ''}`,
    // 改写次数记一笔：SDK 升级后 pattern 变了会静默退回现状，靠这个计数发现
    ...(dataRoot ? { NODESIGN_SHIM_LOG: path.join(dataRoot, '.sandbox-shim.log') } : {}),
  };
}

/**
 * @param {object} o
 * @param {string} o.cwdRoot       会话工作区（= sharedRoot，扁平化之后同一个目录）
 * @param {string} o.sharedRoot    项目共享根
 * @param {string} o.npmCacheDir   共用 npm 缓存（在数据根下，必须可写可读）
 * @param {string} [o.agentTmpRoot] 所有项目沙盒 tmp 的根（/tmp/nd）—— 整体遮读
 * @param {string} [o.agentTmpDir]  本项目的沙盒 tmp（CLAUDE_CODE_TMPDIR 指它）——
 *                                  开可写可读天窗。两个一起传或都不传。
 * @param {string} o.dataRoot      PROJECTS_DATA_ROOT
 * @param {object} o.env           传给 SDK 的 env（凭据抹除按它的键名算）
 * @returns {{ sandbox: object, settings: object }} 直接摊进 query options
 */
export function buildIsolationOptions({ cwdRoot, sharedRoot, npmCacheDir, agentTmpRoot, agentTmpDir, dataRoot, env }) {
  return {
    sandbox: {
      enabled: platform.sandboxEnabled,
      failIfUnavailable: false,
      // ⭐ 逃生门焊死：SDK 给 Bash 留了 `dangerouslyDisableSandbox` 参数，**默认允许**。
      // 08-15 开沙盒当天就被 agent 自发用上了 —— 它撞到 apply-seccomp 偶发失败，
      // 第三次自己带上这个参数关掉沙盒，然后读到了隔壁项目的文件（它老实汇报了，
      // 所以我们看见了）。一个能被工具参数关掉的沙盒等于没有沙盒。
      allowUnsandboxedCommands: false,
      network: {
        allowLocalBinding: false,
        // 全域允许：这层留着不是为了管出口，是为了 Linux 上顺带切断 unix socket
        // —— pm2 的 rpc.sock 就在家目录里，通了的话 `pm2 start` 能起一个沙盒外的
        // 进程（完整逃逸）。只读挂载拦不住 socket 连接，实测过。
        allowedDomains: ['*'],
      },
      filesystem: {
        allowWrite: [
          cwdRoot,
          ...(sharedRoot ? [
            path.join(sharedRoot, '.claude', 'agent-memory'),
            path.join(sharedRoot, 'assets'),
          ] : []),
          npmCacheDir,
          // 本项目的沙盒 tmp（CLAUDE_CODE_TMPDIR / $TMPDIR / pip 缓存都指这里）。
          // 没有它 Bash 的 tmp 只读：venv 静默失败、pip --user EROFS、npm 装不上
          ...(agentTmpDir ? [agentTmpDir] : []),
        ],
        // ⛔ 角色文件不许模型写（2026-08-26）：它是派发闸的判据本身，模型能改就等于
        // 自己给自己发工具权限（TOCTOU + 解析器分歧两条绕法，详见
        // hooks/pre-workspace-scope-guard.js 那段注释）。
        // 这半只管 Bash —— Write/Edit 是进程内工具**不进 bwrap**，那半在上面那道闸。
        // 正门 cast_role 走服务端 fs，不经沙盒，照写不误。
        denyWrite: [
          '/etc', '/usr', '/bin', '/sbin', '/private/etc',
          ...(cwdRoot ? [path.join(cwdRoot, '.claude', 'agents')] : []),
        ],
        // 数据根整个盖住、再用 allowRead 给自己的工作区开天窗。
        // ⚠️ 口径要准（08-18 上生产时实测纠正）：`ls 数据根` **看得见别的项目的
        // 目录名**（沙盒里实测列出了另一个 pid），拦住的是**进去读**——
        // `cat <别人的>/board.json` 与 `ls <别人的>/` 都空。
        // 原注释写的"连 ls 数据根都只看得见自己那一个条目"过强，是错的；
        // platform.js 那边的说法才对：「目录级 denyRead 拦得住 cat，拦不住 ls
        // 看文件名 —— 文件名不是秘密，接受」。
        // agentTmpRoot（/tmp/nd）同 dataRoot 一个待遇：根整个遮住、自己的子目录
        // 开天窗 —— 不遮的话 /tmp/nd/<别的项目>/ 就是跨项目读通道
        denyRead: [...platform.credentialBlacklist(), dataRoot, ...(agentTmpRoot ? [agentTmpRoot] : [])],
        allowRead: [cwdRoot, npmCacheDir, ...(agentTmpDir ? [agentTmpDir] : [])],
      },
      credentials: {
        // filesystem 那层拦得住 `cat .env`，拦不住 `env` —— 服务端 process.env
        // 原样继承给了 Bash 子进程，key 就明晃晃躺着。按名字在沙盒内 unset。
        envVars: platform.secretEnvVarNames(env).map(name => ({ name, mode: 'deny' })),
      },
    },
    settings: {
      permissions: {
        deny: platform.protectedPathRules({ dataRoot }),
        // 本平台自己的 MCP 工具整服务放行，不过 auto 模式分类器（2026-08-25 用户拍板）。
        //
        // 为什么：这些工具是我们自己写的，每一件的边界在服务端**已经**有闸
        //   —— 出网走 ssrf-guard，publish_site / 本地产线走 owner + 档位闸，
        //   生图走额度闸，路径走 permissions.deny + 沙盒。让一个模型分类器
        //   再判一遍 `read_board` 安不安全，既判不出新东西，还多一次外部依赖。
        // 真实账：真用户会话里分类器**从没拦下过一次真越界**（唯一那条是
        //   Stage 2 classifier error 误伤 deliver_files 交稿），却因为自身不可用
        //   挡掉过 8 个会话的正经活（08-24 一天 15 次）。闸门的净效用是负的。
        // Bash **不在**名单里：它跑的是任意命令，语义判断正是分类器的本职。
        //   内置的 Read/Write/Edit/WebFetch 等也照旧不动。
        allow: [MCP_ALLOW_RULE],
      },
      // auto 模式的分类器规则（只在开了 auto 时注入，省得白占 settings）。
      // ⚠️ 按节替换不是追加 —— 为什么只覆盖 environment / hard_deny 两节，
      // 见 auto-mode-rules.js 文件头。
      ...(platform.autoModeEnabled ? { autoMode: autoModeSettings() } : {}),
    },
  };
}
