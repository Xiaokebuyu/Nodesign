/**
 * runtime/agent-env.js —— agent 子进程（会话 CLI、演出进程）从服务端继承哪些环境变量（09-11 收成一份）
 *
 * 此前 session-loop.js 和 stage/env.js 各自解构一遍 process.env 剔掉几个键，两份一样的表。
 * 读者：会话 CLI（session-loop）、演出进程（stage/env）、会话回退的临时 query（api/sessions-rewind）、
 * agent 起的长驻进程（process/registry，里面跑的是 agent 写的代码）。再有 agent 侧的子进程，底子也从这里拿。
 *
 * 要剔的有两类：
 *
 * 1. 服务器自己的运行姿态（08-24 案）：NODE_ENV=production（pm2 注的）会让 agent 沙盒里的
 *    npm install 静默跳过 devDependencies；npm_config_production / npm_config_omit 是同一开关的旁路；
 *    OLDPWD 指着服务端的目录。
 *
 * 2. ⛔ 宿主 Claude Code 会话的身份变量（09-11 案）：在 Claude Code 里跑 `pm2 restart --update-env`
 *    （scripts/safe-restart.sh 原来就这么写）或 `pm2 start`，那个会话 shell 里的整套变量会被 pm2 存进
 *    应用的环境，此后每次重启都带着 —— 09-11 查到生产和 exp 进程里有 CLAUDECODE=1、一个早已结束的
 *    会话的 CLAUDE_CODE_SESSION_ID、跨会话通信的 socket 与 token，pm2 的开机恢复文件（08-23 存的）
 *    里四个应用全有。服务端再把 process.env 原样传给 agent 的 CLI，于是每个用户会话都顶着一个
 *    陌生会话的身份在跑。npx 用户在 Claude Code 的终端里起 Nodesign 是同一条路。
 *    这里只剔**身份/运行时**变量，不剔用户可能有意配的 CLAUDE_CODE_* 设置（如输出上限）。
 *    ANTHROPIC_SMALL_FAST_MODEL 也剔：helper 模型由 session-binding 定（订阅路 = NODESIGN_FAST_MODEL 或主模型，
 *    API 路 = 表内值），session-loop / stage 拿它盖；继承值只在「API 行表里没配 fastModel」时漏过去，
 *    而那时漏进去的是宿主的 Claude 模型名，API 路上会 404。要改 helper 模型用 NODESIGN_FAST_MODEL。
 */

const SERVER_POSTURE_KEYS = ['NODE_ENV', 'npm_config_production', 'npm_config_omit', 'OLDPWD'];

export const HOST_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'MCP_CONNECTION_NONBLOCKING',
  'ANTHROPIC_SMALL_FAST_MODEL',
  // 宿主编辑器终端（Cursor / VS Code 远程）的：askpass 指向编辑器那头的 IPC，ELECTRON_RUN_AS_NODE 会让 agent 起的
  // 任何 Electron 程序当成 node 跑。09-11 生产进程里都有（连同一个 git IPC 的 token）
  'ELECTRON_RUN_AS_NODE',
  'GIT_ASKPASS',
];
/** 按前缀剔的：编辑器宿主的变量整族（VSCODE_GIT_IPC_AUTH_TOKEN 之类），从来不是产品配置 */
const HOST_PREFIXES = ['VSCODE_', 'CURSOR_'];

const DROP = new Set([...SERVER_POSTURE_KEYS, ...HOST_SESSION_ENV_KEYS]);

/** process.env 去掉上面两类之后的副本（给 agent 子进程当底子，调用方再往上盖自己的键） */
export function agentInheritedEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (DROP.has(k) || HOST_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}
