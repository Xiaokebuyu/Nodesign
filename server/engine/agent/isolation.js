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
 *
 * 09-17 起托管版的读闸从黑名单改成白名单（platform.fenceOutsideReads）：Bash 那半在本文件
 * （家目录整个遮读 + homeReadAllowlist 开天窗），Read/Grep/Glob 那半是 settings 里的
 * blockReadsOutsideWorkingDirectories（工作目录 = cwd + session-loop 传的 additionalDirectories）。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { platform } from '../../runtime/platform.js';
import { autoModeSettings } from './auto-mode-rules.js';
import { MCP_ALLOW_RULE } from '../mcp/server-name.js';
import { PLUGIN_ROOT } from './skill.js';

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
 * - <sharedRoot>/.claude/plugins（09-17）：沙盒对它 denyWrite。路径不存在时沙盒会在宿主上临时建一个
 *   空文件占位（命令跑完再删），这期间服务端从 SystemTab 装 plugin 会撞上它；先建好目录就没有占位。
 *
 * 目录必须先存在 —— bwrap 绑一个不存在的路径会起不来；建不出来也不拦会话。
 * envPatch 直接摊进 sdkEnv。
 */
export async function prepareAgentDirs({ dataRoot, projectId, sessionId, sharedRoot = null }) {
  const npmCacheDir = path.join(dataRoot, '.npm-cache');
  const agentTmpRoot = path.join(os.tmpdir(), 'nd');
  const agentTmpDir = path.join(agentTmpRoot, projectId || String(sessionId || 'anon').slice(0, 12));
  // 桌面版不建（没有沙盒，也不往用户文件夹里多放目录）
  const pluginRoot = sharedRoot && !platform.isLocal ? [path.join(sharedRoot, '.claude', 'plugins')] : [];
  for (const d of [npmCacheDir, path.join(agentTmpDir, 'pip'), ...pluginRoot]) {
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
      // git 的全局配置换成仓库里一份中性的（09-17，托管版）：家目录遮读之后沙盒里读不到 ~/.gitconfig，
      // agent 的 `git commit` 会因为没有身份失败；而遮读之前用的是站主本人的姓名邮箱，会写进用户仓库的提交里。
      // CLI 宿主进程自己跑的 git 也跟着换，站主配置里的凭据助手不再被带进 agent 会话。
      ...(platform.fenceOutsideReads ? { GIT_CONFIG_GLOBAL: AGENT_GITCONFIG } : {}),
    },
  };
}

/** agent 会话的全局 git 配置（中性身份 + 默认分支名），在仓库里，读围栏的白名单已包含 */
export const AGENT_GITCONFIG = path.join(platform.repoRoot, 'server', 'ops', 'agent-gitconfig');

/**
 * Bash 读围栏的白名单（09-17，托管版）—— 家目录被整个遮读之后，沙盒里仍然要读的东西。单一真相源。
 *
 * 每一条都是 09-17 用 sandbox-runtime 复现矩阵逐条去掉验过的：
 *   - 仓库：内置 skill 的附件、node_modules、skill 引用的脚本、agent-gitconfig 都在里面。仓库里的私有部分
 *     （server/db、logs、server/.cache、数据根、.env、兄弟仓）另在 denyRead，嵌套照样生效（已实测）。
 *   - 仓库的 node_modules 若是软链（worktree 的做法），真身也要开，否则依赖解析到一个被遮住的目录。
 *   - node 所在目录（由 process.execPath 推出）：node / npm / npx / codex / wrangler 都装在 ~/.nvm 下，去掉后 rc=127。
 *   - ~/.cache/ms-playwright：浏览器二进制，去掉后 playwright 起不来。
 *   - <配置目录>/shell-snapshots、session-env：CLI 在沙盒里执行每条命令前要读的 shell 快照与会话 env。
 * 本项目 owner 的用户 plugin **不在这张表里**，但照样读得到：每个已装 plugin 的目录是 additionalDirectories，
 * 沙盒把它们当可写目录挂回家目录的遮罩之上（别人的 plugin 不在其中，读不到）。
 * ⛔ 表里不许出现任何可写目录的**上级**：沙盒先挂可写目录、后挂这张表，上级目录的只读挂载会把下面的可写挂载
 *   盖成只读，CLI 随后要在那些目录里给 `.mcp.json` 建占位就失败，**每一条 Bash 命令都起不来**（09-17 SDK 探针实测
 *   `bwrap: Can't create file at …/.mcp.json: Read-only file system`）。所以 owner 的 plugin 根不能放进来；
 *   仓库根是内置 plugin 的上级，靠内置 plugin 目录里常驻一份 .mcp.json 让 CLI 不必建占位（见 pluginWriteFence）。
 * ⛔ 条目一律不带通配：中段通配会被沙盒递归展开进每条命令的参数（08-18 事故，见 platform.credentialBlacklist）。
 * ⛔ 家目录本身或它的上级不许出现：那等于把围栏拆掉，所以直接丢弃并报错。
 */
export function homeReadAllowlist() {
  const home = path.resolve(os.homedir());
  const binDir = path.dirname(process.execPath);
  const nodeDir = path.resolve(binDir, '..');
  const entries = [
    platform.repoRoot,
    ...symlinkedDeps(platform.repoRoot),
    coversPath(nodeDir, home) ? binDir : nodeDir,
    path.join(home, '.cache', 'ms-playwright'),
    path.join(platform.claudeConfigDir, 'shell-snapshots'),
    path.join(platform.claudeConfigDir, 'session-env'),
  ].map((p) => path.resolve(p));
  return [...new Set(entries)].filter((p) => {
    if (!/[*?[\]]/.test(p) && !coversPath(p, home)) return true;
    console.error(`[isolation] 读围栏白名单拒收条目（带通配，或盖住了整个家目录）：${p}`);
    return false;
  });
}

/** p 是否等于 target 或是它的上级目录 */
function coversPath(p, target) {
  return p === target || target.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function symlinkedDeps(root) {
  const out = [];
  for (const rel of ['node_modules', path.join('web', 'node_modules')]) {
    const p = path.join(root, rel);
    try { if (fsSync.lstatSync(p).isSymbolicLink()) out.push(fsSync.realpathSync(p)); } catch { /* 没有就算了 */ }
  }
  return out;
}

/**
 * Bash 读围栏整个遮住的根（09-17，托管版）：家目录、宿主 Claude Code 的 /tmp/claude-<uid>
 * （同机开发用的 Claude Code 会话把工具输出、子代理转录落在这里）。
 *
 * ⛔ /tmp 整个遮读试过，不能做（09-17 SDK 探针实测）：CLI 把沙盒出网代理的 unix socket 放在
 * `/tmp/claude-http-<随机>.sock`，先 bind 进沙盒；/tmp 再盖一层 tmpfs 就把它抹掉，
 * 之后每条命令出网都失败（curl 000、pip 装不上）。socket 名是随机的，allowRead 开不了天窗。
 * 遮 os.tmpdir() 同理（CLI 的 socket 跟着它走），所以这里只列固定名字的子目录。
 */
function hostPrivateRoots() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return [...new Set([
    path.resolve(os.homedir()),
    ...(uid === null ? [] : [path.join(path.resolve(os.tmpdir()), `claude-${uid}`), `/tmp/claude-${uid}`]),
  ])];
}

function insidePath(p, dir) {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * 会话的 additionalDirectories（09-17 起在这里算，session-loop 直接用）。
 *
 * 它有两个作用，第二个是 09-17 才看清的：
 *   ① Read / Grep / Glob 的工作目录：托管版开了 blockReadsOutsideWorkingDirectories，只有这里列出的目录
 *      （加上 cwd）读得到。本项目沙盒 tmp 要在里面（agent 读自己在 tmp 里生成的图），已装 plugin 的目录
 *      要在里面（skill 附件靠 Read）。PreToolUse 钩子的 allow 与 permissions.allow 规则都解不开这道围栏（实测）。
 *   ② **沙盒的可写目录**：CLI 对 additionalDirectories 默认开放 Bash 写（官方 sandboxing 文档原话）。
 *      所以 plugin 目录进来就得在 pluginWriteFence 里关回去。
 * 项目级 plugin 在工作区里，工作区本来就是工作目录，不再重复列（列了就成了可写目录，
 * 而它的上级 .claude/plugins 是 denyWrite，CLI 在里面建 .mcp.json 占位会失败）。
 */
export function agentAdditionalDirectories({ cwdRoot = null, sharedRoot = null, agentTmpDir = null, installedPlugins = null }) {
  const own = [cwdRoot, sharedRoot].filter(Boolean).map((r) => path.resolve(r));
  const pluginDirs = (installedPlugins?.plugins || []).map((p) => path.resolve(p.path))
    .filter((p) => !own.some((r) => insidePath(p, r)));
  return [...new Set([...(sharedRoot ? [sharedRoot] : []), ...(agentTmpDir ? [agentTmpDir] : []), ...pluginDirs])];
}

/**
 * Bash 不许写的 plugin 目录（09-17）。plugin 在下个会话由 CLI 宿主进程加载，hooks 与 skill frontmatter 里的
 * hooks 都在沙盒外执行（SDK 探针实测），所以 agent 写得进去的 plugin 目录 = 沙盒逃逸：
 *   - 项目级 plugin 根 <工作区>/.claude/plugins：在 cwd 里，allowWrite 覆盖它 → 整个 denyWrite。
 *     prepareAgentDirs 先把它建好，免得沙盒在宿主上建占位文件。
 *   - 内置 plugin：是 additionalDirectories（= 沙盒可写），加载时又不校验，写得进去就是所有用户的会话一起中招
 *     → 整个 denyWrite。⚠️ 前提是目录里**常驻一份 .mcp.json**：CLI 会在每个 additionalDirectory 里为 .mcp.json
 *     挂一个写保护，文件不存在时要先在宿主上建占位，而目录已经只读就建不出来，每条 Bash 命令都起不来
 *     （09-17 实测）。文件在仓库里（{"mcpServers":{}}，plugin 都带 skipMcpDiscovery，本来就不读），有测试钉住。
 *   - 用户级 plugin（本项目 owner 的）：同样是 additionalDirectories，但目录里没有 .mcp.json，根目录不能整个关
 *     （理由同上）。只关已存在的 .claude-plugin/ 与 skills/（清单与 skill 正文改不了）；根目录下新长出来的
 *     hooks/ agents/ 等由 plugin-loader 的加载时校验挡掉（用户级每次加载都校验）。
 * Write/Edit 那半在 hooks/pre-workspace-scope-guard.js；加载时的校验（主闸）在 plugin-loader.js。
 */
function pluginWriteFence({ cwdRoot, sharedRoot, installedPlugins }) {
  const own = [cwdRoot, sharedRoot].filter(Boolean).map((r) => path.resolve(r));
  const out = own.map((r) => path.join(r, '.claude', 'plugins'));
  for (const p of installedPlugins?.plugins || []) {
    const dir = path.resolve(p.path);
    if (own.some((r) => insidePath(dir, r))) continue;          // 项目级：上级已整个关掉
    if (dir === PLUGIN_ROOT) { out.push(dir); continue; }
    for (const sub of ['.claude-plugin', 'skills']) {
      const d = path.join(dir, sub);
      if (fsSync.existsSync(d)) out.push(d);                   // 只列已存在的：不存在的会让沙盒去宿主上建占位
    }
  }
  return [...new Set(out)];
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
 * @param {{ plugins?: Array<{path: string}> }} [o.installedPlugins]
 *                                  plugin-loader.loadInstalledPlugins 的返回：plugin 目录按 pluginWriteFence 禁写（09-17）
 * @returns {{ sandbox: object, settings: object }} 直接摊进 query options
 */
export function buildIsolationOptions({ cwdRoot, sharedRoot, npmCacheDir, agentTmpRoot, agentTmpDir, dataRoot, env, installedPlugins = null }) {
  const fence = platform.fenceOutsideReads;
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
          // plugin 目录（09-17）：写进去的 hooks 下个会话在沙盒外执行，理由见 pluginWriteFence
          ...pluginWriteFence({ cwdRoot, sharedRoot, installedPlugins }),
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
        // 全站会话转录（09-17）：别的项目、别的用户的对话都在 <配置目录>/projects 下。Bash 整个遮住；
        // Read 工具读本会话大输出的那一格由 pre-workspace-scope-guard 放行（Bash 不需要读它）
        // 读围栏（09-17，托管版）：家目录与宿主 Claude Code 的 /tmp/claude-<uid> 整个遮住，要用的由 homeReadAllowlist 开天窗。
        // 沙盒按深度由浅到深处理：家目录遮住 → 仓库开 → 仓库里的数据根 / 站点库再遮 → 自己的工作区再开，嵌套逐层生效。
        denyRead: [
          ...platform.credentialBlacklist(), dataRoot, ...(agentTmpRoot ? [agentTmpRoot] : []),
          path.join(platform.claudeConfigDir, 'projects'),
          ...(fence ? hostPrivateRoots() : []),
        ],
        allowRead: [
          cwdRoot, npmCacheDir, ...(agentTmpDir ? [agentTmpDir] : []),
          ...(fence ? homeReadAllowlist() : []),
        ],
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
        // 进程内读工具的围栏（09-17，托管版）：Read / Grep / Glob 在所有权限模式下拒绝工作目录
        // （cwd + SDK 顶层 additionalDirectories）以外的读。本会话的 tool-results、autoMemoryDirectory
        // 由 CLI 内置放行；agent 自己的沙盒 tmp 由 session-loop 放进 additionalDirectories。
        // 跨项目 / 配置目录那几条更细的判据仍在 pre-workspace-scope-guard（纵深，别删）。
        ...(fence ? { blockReadsOutsideWorkingDirectories: true } : {}),
      },
      // auto 模式的分类器规则（只在开了 auto 时注入，省得白占 settings）。
      // ⚠️ 按节替换不是追加 —— 为什么只覆盖 environment / hard_deny 两节，
      // 见 auto-mode-rules.js 文件头。
      ...(platform.autoModeEnabled ? { autoMode: autoModeSettings() } : {}),
    },
  };
}
