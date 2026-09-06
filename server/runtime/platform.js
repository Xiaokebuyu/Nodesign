/**
 * server/runtime/platform.js — 跨平台决策的单一来源
 *
 * 设计原则：所有跟 OS / 工具 / 外部状态相关的决策**只在这里做**。
 * 业务文件（session-loop.js / session-loop.js / sessions.js / workspace.js）
 * 通过 `import { platform } from '../runtime/platform.js'` 读决策结果，
 * 不再自己 `process.env.HOME || os.homedir()` 拼凑。
 *
 * 为什么需要这个文件：
 *   2026-05 Linux 服务器部署踩到 3 类跨平台坑：
 *     1. CLAUDE_CONFIG_DIR per-session vs 全局（SDK 设计假设全局）
 *     2. bwrap sandbox 不解析 symlink（Mac sandbox-exec 没事）
 *     3. WebFetch preflight 假设 OAuth token 存在（gateway key 模式没 OAuth）
 *   每个坑都涉及多文件改动且容易漏。集中后增/改决策只改这一个文件。
 *
 * 启动建议：在 server/index.js 早期调 `platform.dump()` 打日志，
 *   运维一眼能看到当前平台/路径/sandbox/preflight 配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile } from './profile.js';

const isLinux = process.platform === 'linux';

/** 服务端仓库根（server/runtime/platform.js → ../..），.env 就躺在这 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/**
 * CLAUDE 配置目录（SDK JSONL / settings 的全局根）
 *
 * SDK binary 把 session JSONL 落到 `<configDir>/projects/<encoded-cwd>/<sid>.jsonl`，
 * encoded-cwd = sessionRoot.replace(/[^a-zA-Z0-9]/g, '-')。这个路径是 SDK 内部
 * 硬编码（不能 per-session 自定义）—— 所有 NoDesign session 必须共用一个 configDir，
 * 通过不同 cwd 的编码自然分隔。
 *
 * NODESIGN_CONFIG_DIR 可显式覆盖（容器化 / 多实例共享持久化卷场景）。
 */
const claudeConfigDir = process.env.NODESIGN_CONFIG_DIR
  || path.join(process.env.HOME || os.homedir(), '.claude');

/**
 * 本机有没有能跑内置 Claude 行的凭据（本地版 picker 的闸，08-22）：
 *   - ANTHROPIC_API_KEY 在 env 里（设置页存进 .env 后 setEnvValues 会同步进 process.env，所以每次现查）
 *   - 或 `claude login` 过：<claudeConfigDir>/.credentials.json（Linux/Windows 的 OAuth 落盘处），
 *     或 .claude.json 里有 oauthAccount（mac 走钥匙串时凭据不落文件，但这个账号记录在）。
 * 只是「像是配过」的判据，不是验资格 —— 真假由第一次会话说了算；没配时 picker 空着、
 * 设置页指路，比让用户点一个必失败的 Claude 行强。hosted 不走这条（订阅行按档位放）。
 */
/**
 * ⏸ 站主 09-06：本地版**暂时不认** `claude login` 的订阅登录态 —— 用户机器上的 Claude 订阅骑进来，
 * 计量、外审、封号都够不着，先关掉；只认填进设置页的 ANTHROPIC_API_KEY。要重新打开就把这个翻成 true
 * （bin/nodesign.js 的 login 子命令跟着这一个开关）。hosted 不受影响（服务器自己的登录态照认）。
 */
export const LOCAL_CLAUDE_LOGIN_ENABLED = false;

export function claudeAuthPresent() {
  if (process.env.ANTHROPIC_API_KEY) return 'api_key';
  if (profile.isLocal && !LOCAL_CLAUDE_LOGIN_ENABLED) return null;
  if (fs.existsSync(path.join(claudeConfigDir, '.credentials.json'))) return 'login';
  for (const f of [path.join(claudeConfigDir, '.claude.json'), path.join(process.env.HOME || os.homedir(), '.claude.json')]) {
    try { if (JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount) return 'login'; } catch { /* 没这个文件或不是 JSON */ }
  }
  return null;
}

/**
 * Sandbox 是否开启
 *
 * 2026-08-15 实测重开（此前因 bwrap 不解析 session root 的 symlink 关了三个月；
 * 08-07 工作区扁平化之后软链已经一条都没有，那个阻碍自然消失）。
 * bwrap 0.8.0 在位、user namespace 可用，探针跑通：写只落 cwd、/tmp 与 HOME 都
 * 拒、凭据读不到、外网走代理照常、npm i / vite build / chromium / ffmpeg / codex
 * 全部能跑。
 *
 * ⚠️ 沙盒**只管 Bash**。Read / Grep / Glob / Write 这些结构化工具是 SDK 进程内
 * 实现，不进 bwrap —— 它们靠 protectedPathRules() 那套 permissions.deny 拦。
 * 两套东西缺一不可，改一边记得看另一边。
 *
 * 开关仍然显式：`NODESIGN_SANDBOX=on`。exp 实例已在 ecosystem.exp.config.cjs 里
 * 打开，生产要等 exp 跑一段没事再说 —— 别把它改成默认开，那等于让一次 merge
 * 顺手改了线上进程模型。
 */
const sandboxEnabled = process.env.NODESIGN_SANDBOX === 'on';

/**
 * 权限模式 & auto 模式分类器
 *
 * 历史上一直是 `bypassPermissions`（没有人能回答权限弹窗，只能全放）。
 * SDK 还有个 `auto`：**用一个模型分类器**判每次工具调用该放行还是该拦，
 * 规则从 settings 的 `autoMode` 段注入它的系统提示（见 agent/auto-mode-rules.js）。
 *
 * 分类器用哪个模型由 `CLAUDE_CODE_AUTO_MODE_MODEL` 定 —— 判"这个动作越不越界"
 * 是个需要判断力的活，用强模型，别在这儿省。
 *
 * 开关：`NODESIGN_PERMISSION_MODE=auto`（exp 已开，生产仍是 bypass）。
 * 分类器判不了、升级到 host 的那些调用走 canUseTool，处理策略见
 * `NODESIGN_AUTO_MODE_ESCALATION`（allow=记账放行/deny=拦）。
 */
const permissionModeDefault =
  process.env.NODESIGN_PERMISSION_MODE === 'auto' ? 'auto' : 'bypassPermissions';
const autoModeEnabled = permissionModeDefault === 'auto';
const autoModeModel = process.env.NODESIGN_AUTO_MODE_MODEL || 'opus';
const autoModeEscalation =
  process.env.NODESIGN_AUTO_MODE_ESCALATION === 'deny' ? 'deny' : 'allow';

/**
 * WebFetch preflight 是否跳过
 *
 * SDK binary 内置 `nV7()` preflight：调 Anthropic 服务器侧域名分类 API（需 OAuth
 * claude.ai 登录态）。NoDesign 走 API key gateway（NODESIGN_GATEWAY_KEY）模式
 * 不存在 OAuth → preflight 永远 check_failed → DomainCheckFailedError
 * "Unable to verify if domain X is safe to fetch ... blocking claude.ai"。
 *
 * skipWebFetchPreflight 是 SDK 官方为 enterprise / 自托管场景留的开关。
 * 我们走 gateway 模式 → 永远关。
 */
const skipWebFetchPreflight = true;

/**
 * 凭据/敏感目录黑名单（sandbox.filesystem.denyRead + 结构化工具的 deny 规则共用）
 *
 * 函数形式（不是常量）—— 因为 sandbox.deny 在 spawn SDK 子进程时才计算，
 * 此时如果 HOME env 被改了（比如 ecosystem 显式传 HOME=/home/nodesign），
 * 应该读改后的 homedir。
 *
 * 2026-08-15 补齐：原来只有 .ssh/.aws/.gnupg/gh —— **`.env` 不在里面**，而站主
 * 的中转站 key、CF token、admin 密码、鉴权 secret 全在那一个文件里。这是开沙盒
 * 之前最该补的一条。目录条目按目录整个拦（实测：目录级 denyRead 拦得住 `cat`
 * 目录里的文件，拦不住 `ls` 看文件名 —— 文件名不是秘密，接受）。
 */
/** 数据根（给 credentialBlacklist 用；跟 protectedPathRules 收到的那个同源） */
// ⚠️ 变量名跟 projects/workspace.js 对齐（PROJECTS_DATA_DIR）。08-22 之前这里读的是 PROJECTS_DATA_ROOT，
// 而 .env.example 与生产 .env 写的都是 PROJECTS_DATA_DIR —— 两个名字一个事实，数据根一旦不是默认值，
// 凭据黑名单就盖错目录。旧名留作兜底，别再新增读它的地方。
const PROJECTS_DATA_ROOT_FOR_DENY = path.resolve(
  process.env.PROJECTS_DATA_DIR || process.env.PROJECTS_DATA_ROOT || path.join(repoRoot, 'server', 'projects-data'),
);

function credentialBlacklist() {
  const home = os.homedir();
  return [
    ...siblingEnvFiles(),                 // ⭐ 本仓 + 同机其它仓的 .env（见下）
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config', 'gh'),     // GitHub CLI token
    path.join(home, '.config', 'gcloud'), // GCP 凭据（这台机器就跑在 GCP 上）
    path.join(home, 'apikey'),            // CF token / openai key 的文件版
    path.join(home, '.claude', '.credentials.json'),  // 订阅 OAuth
    path.join(home, '.claude.json'),
    path.join(home, '.codex'),            // codex CLI 登录态
    path.join(home, '.wrangler'),         // CF OAuth
    path.join(home, '.npmrc'),
    path.join(home, '.git-credentials'),
    '/etc/shadow',
    '/etc/passwd',
    '/etc/sudoers',
    // ⛔ 这份清单里**禁止出现中段通配模式**（形如 `<数据根>/*/.browser`）。
    //
    // 2026-08-18 生产事故：那条 .browser 通配把整个生产的 Bash 弄死了 3 小时。
    // 机制（sandbox-runtime 的 sandbox-manager / expandGlobPattern）：
    //   - 尾部 `/**` 会被剥掉，目录整棵 = 1 条 bwrap 挂载，便宜；
    //   - 但**中段的 `*`** 触发展开：拿静态前缀当 baseDir，`readdirSync`
    //     **递归走完整棵树**，匹配的每个文件每个目录各成一条 deny 路径拼进
    //     每条 Bash 命令的 argv。chromium 缓存边逛边涨 → 4000+ 条 ≈ 600KB
    //     → 超过内核单 arg 上限（MAX_ARG_STRLEN 128KB）→ 所有命令 E2BIG。
    //     开沙盒当天验收是过的 —— 用户逛了 20 分钟站，缓存长过判据线才炸。
    //
    // `.browser`（cookie jar，装着用户在第三方站的真实登录态）现在由两层盖住：
    //   - Bash：`dataRoot` 整个在 denyRead（isolation.js），1 条路径，不展开；
    //   - Read/Grep/Glob：pre-workspace-scope-guard 按「在数据根里、不在本
    //     工作区里」判，实测 deny；钩子若静默死，init 契约自检会杀会话兜底。
    // 逃生舱：同机上还有别的东西要拦时不用改代码（冒号分隔绝对路径）。
    // exp 用它拦生产的数据根 —— 两个实例同用户同机器，否则互相读得到。
    ...(process.env.NODESIGN_DENY_READ_EXTRA || '').split(':').map(s => s.trim()).filter(Boolean),
  ].filter((p) => {
    // 上面那条禁令的代码形态：带通配的条目直接丢弃并吼出来，宁可少拦一条
    // 也不能再把整个 Bash 弄死。尾部 /** 不会出现在这份清单里（protectedPathRules
    // 才负责加），所以这里见到任何 glob 字符都算违规。
    if (!/[*?[\]]/.test(p)) return true;
    console.error(`[platform] credentialBlacklist 拒收通配条目（会被沙盒递归展开撑爆 argv，2026-08-18 事故）：${p}`);
    return false;
  });
}

/**
 * 本仓 + 同机兄弟仓的 .env
 *
 * 2026-08-15 真跑抓到的洞：只拦 `repoRoot/.env` 的话，exp 会话里
 * `cat ~/projects/Nodesign/.env` 照样出内容 —— 生产的中转站 key、CF token、
 * admin 密码全在那份里。同一台机器上并排放着 Nodesign / Nodesign-canvas /
 * SillyTavern / claude-tavern-bridge，每个都有自己的 .env，一个都不能漏。
 */
function siblingEnvFiles() {
  const parent = path.dirname(repoRoot);
  const out = [path.join(repoRoot, '.env')];
  let dirs = [];
  try { dirs = fs.readdirSync(parent, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(parent, d.name);
    if (dir === repoRoot) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f !== '.env' && !f.startsWith('.env.')) continue;
      if (f === '.env.example' || f === '.env.sample') continue;  // 示例文件没秘密，留着给人看
      out.push(path.join(dir, f));
    }
  }
  return out;
}

/**
 * 沙盒里要抹掉的环境变量名
 *
 * 实测（2026-08-15）：filesystem 那层拦得住 `cat .env`，但**拦不住 `env`** ——
 * 服务端进程自己的 process.env 原样传给了 Bash 子进程，key 就明晃晃躺在那。
 * SDK 的 sandbox.credentials.envVars 支持 deny（沙盒内直接 unset），拿它堵。
 *
 * 匹配靠命名规律而不是写死清单：以后 .env 里加新 key 自动就被盖住，不用记得
 * 回来改这里。ANTHROPIC_* 也一起抹 —— agent 在 Bash 里没有任何理由自己拿它。
 */
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$/i;

function secretEnvVarNames(env = process.env) {
  return Object.keys(env).filter(
    name => SECRET_ENV_RE.test(name) || /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/.test(name),
  );
}

/**
 * 结构化工具（Read / Grep / Glob / Write / Edit）的 deny 规则
 *
 * ⚠️ 这不是锦上添花，是沙盒的另一半。2026-08-15 探针实测：
 *   - sandbox.filesystem.* **只作用于 Bash**；Read/Grep/Glob/Write 在 SDK 进程内
 *     跑，完全不进 bwrap —— 沙盒开着照样 `Read .env`，还能往 cwd 外 Write 文件。
 *   - additionalDirectories **不是围栏**（它只是"额外允许"，不限制别处）；
 *     bypassPermissions 下 Read 想读哪读哪。
 *   - permissions.deny 规则在 bypassPermissions 下**照样生效** —— 但路径必须写
 *     **双斜杠**绝对形式 `Read(//home/x/**)`。写成单斜杠 `Read(/home/x/**)`
 *     不报错、不生效，静默失效（这一条踩过，别再踩）。
 */
function protectedPathRules({ dataRoot } = {}) {
  const rules = [];
  for (const p of credentialBlacklist()) {
    // 目录 → `/**`，文件 → 精确匹配；两条都发，多余的那条不会误伤
    for (const target of [`/${p}`, `/${p}/**`]) {
      rules.push(`Read(${target})`, `Write(${target})`, `Edit(${target})`);
    }
  }
  // 仓库自身只读：agent 的活全在工作区里，没理由改服务端源码（改得动就等于
  // 能改自己的 prelude / hook / 闸门 —— 隔离的地板就没了）。
  // ⚠️ 生产的数据根是仓库里的 `server/projects-data` —— 一刀切 deny 整个 repoRoot
  // 会把 agent 自己的工作区一起封死。所以沿通往数据根的那条路**逐层下探**，
  // 每层封兄弟、只放行那一支（只封顶层不够：那样整个 server/ 都得放行 =
  // 平台源码对 agent 可写）。exp 的数据根在仓库外，直接封整个仓库。
  for (const child of repoChildrenOutside(dataRoot)) {
    rules.push(`Write(/${child}/**)`, `Edit(/${child}/**)`);
  }
  return rules;
}

/**
 * repoRoot 下与数据根无关的条目（数据根落在仓库内时用来避让）
 *
 * 数据根在仓库外（exp）→ 直接返回 repoRoot，整个仓库禁写。
 * 数据根在仓库内（生产是 `server/projects-data`）→ **沿着通往数据根的那条路
 * 逐层下探**，每层把兄弟条目都封掉，只放行通往数据根的那一支。
 * ⚠️ 只封顶层是不够的：那样整个 `server/` 都得放行，等于平台源码对 agent 可写
 * （2026-08-15 拿生产真实布局算了一遍才看见）。
 */
function repoChildrenOutside(dataRoot) {
  const resolvedData = dataRoot ? path.resolve(dataRoot) : null;
  const dataInsideRepo = resolvedData
    && (resolvedData === repoRoot || resolvedData.startsWith(`${repoRoot}${path.sep}`));
  if (!dataInsideRepo) return [repoRoot];
  const segments = resolvedData.slice(repoRoot.length + 1).split(path.sep).filter(Boolean);
  const out = [];
  let level = repoRoot;
  for (const keepOut of segments) {
    let names = [];
    try { names = fs.readdirSync(level); } catch { break; }
    for (const name of names) {
      if (name === keepOut || name === '.git') continue;
      out.push(path.join(level, name));
    }
    level = path.join(level, keepOut);
  }
  return out;
}

/**
 * 启动时 dump 平台决策到日志
 *
 * 让运维一眼看到：当前进程跑在什么 OS / HOME 是什么 / claudeConfigDir 指哪 /
 * sandbox 开没开 / preflight 关没关。Linux 服务器排查问题的第一信号。
 */
function dump() {
  const info = {
    profile: profile.name,
    ...(profile.isLocal ? { dataRoot: profile.dataRoot, listenHost: profile.listenHost, serveWeb: profile.serveWeb } : {}),
    os: process.platform,
    arch: process.arch,
    node: process.version,
    home: os.homedir(),
    claudeConfigDir,
    sandboxEnabled,
    skipWebFetchPreflight,
    // 沙盒真开没开一眼看到，另外报一下两道闸各盖了多少条 —— 归零就是配错了
    protectedPaths: credentialBlacklist().length,
    scrubbedEnvVars: secretEnvVarNames().length,
    permissionMode: permissionModeDefault,
    ...(autoModeEnabled ? { autoModeModel, autoModeEscalation } : {}),
  };
  console.log('[platform]', JSON.stringify(info, null, 2));
  return info;
}

export const platform = {
  // 部署形态（runtime/profile.js）：hosted | local。消费方一律从这里读，不直接 import profile.js
  profile: profile.name,
  isLocal: profile.isLocal,
  dataRoot: profile.dataRoot,
  cacheRoot: profile.cacheRoot,
  listenHost: profile.listenHost,
  serveWeb: profile.serveWeb,
  webDistDir: profile.webDistDir,
  isLinux,
  isMac,
  isWin,
  repoRoot,
  claudeConfigDir,
  claudeAuthPresent,
  LOCAL_CLAUDE_LOGIN_ENABLED,
  sandboxEnabled,
  permissionModeDefault,
  autoModeEnabled,
  autoModeModel,
  autoModeEscalation,
  skipWebFetchPreflight,
  credentialBlacklist,
  secretEnvVarNames,
  protectedPathRules,
  dump,
};
