/**
 * server/projects/workspace.js — 项目工作区（2026-08-07 扁平化）
 *
 * **一个项目 = 一个工作区 = 一个目录。会话是对话线程，不是文件容器。**
 *
 * 结构：
 *   <PROJECTS_DATA_ROOT>/<projectId>/
 *     ├── shared/                    ← **项目工作区**：agent 的 cwd，产物的家
 *     │   ├── CLAUDE.md              项目档案（指引/风格/习惯；08-24 挪到根，画布可见）
 *     │   ├── 记忆/                   SDK auto-memory（08-24 起，画布可见）
 *     │   ├── .claude/               settings.json · skills/ agents/ · projects/（SDK 转录）
 *     │   ├── assets/                上传素材 + 生成图
 *     │   ├── .nd/<sid>/             会话私档（spec.json / design-plan.md）
 *     │   ├── .git/                  项目历史
 *     │   └── <产物…>                 canvas.html / index.html / notes/ …
 *     └── sessions/                  扁平化前的旧结构，迁移后只剩空壳（不删，留退路）
 *
 * ## 为什么 cwd 是工作区，不是 sessions/<sid>/（2026-08-07 改）
 *
 * 旧模型是三层：项目 → `shared/tasks/<任务>/` → 产物，会话跟任务一对一绑定。
 * 线上 22 个项目的数据说这一层是空的：**13 个项目有任务，每个都恰好 1 个**，
 * 没有任何一个项目有第二个任务。三个名字（项目 / 任务 / 会话）指同一样东西，
 * 而代价是画布上要养一整套工作区几何（分区 / 格子 / 聚焦模式 / 文件夹卡），
 * 落点被吸附到 244×210 的格子上 —— 用户能感觉到的就是"拖了不跟手"。
 *
 * 所以任务这一层整个退役。产物直接住工作区根，会话只剩"对话线程"这一个含义。
 *
 * 顺带解决的：cwd 就是工作区之后，`tasks/` `assets/` `skills/` `agents/`
 * `agent-memory` 五条软链**全部不需要了**。那条写进 prelude 的老坑
 * （"Glob/Grep 不跟软链，对 assets/* 返回空"）跟着一起消失。
 *
 * ⚠️ 目录名仍叫 `shared/`：改名要动 22 个项目的磁盘路径，换不来任何功能。
 * 它现在的含义是"**被所有会话共享的那个工作区**"，字面上依然成立。
 *
 * 边界：
 *   - validateProjectId / validateSessionId 防 traversal
 *   - git ops 走 child_process spawn（不开 shell，args 不被 shell 解释）
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { mutex } from 'async-mutex-lite';
import { validateProjectId, getProject } from './store.js';
import { resolveModelContextWindow } from '../engine/agent/model-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Per-sessionRoot read-modify-write 串行 utility（spec.json）。
 * 08-24 起唯一写入方 = 暂退役的 expose_tweaks（决策贴/PostCompact 摘要已拆）；
 * 锁留着 —— tweaks 升级回归时并发结构不变。
 *
 * @param {string} workspaceRoot - sessions/<sid>/ 路径
 * @param {(spec: object) => (object|void|Promise<object|void>)} mutator
 *        接收已 parse 的 spec object（不存在 / 解析失败时是 {}），同步或异步 mutate；
 *        return 的 object 当新 spec 写回（或 mutate 原 object 不 return 也行）。
 * @returns {Promise<object>} 写入后的 spec
 */
export async function mutateSpecJson(workspaceRoot, mutator) {
  return mutex(`spec:${workspaceRoot}`, async () => {
    const specPath = path.join(workspaceRoot, 'spec.json');
    let spec = {};
    try {
      const raw = await fs.readFile(specPath, 'utf8');
      spec = JSON.parse(raw);
      if (!spec || typeof spec !== 'object') spec = {};
    } catch { /* file not exist / parse error → fresh */ }
    const next = (await mutator(spec)) || spec;
    await fs.writeFile(specPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}

export const PROJECTS_DATA_ROOT = path.resolve(
  process.env.PROJECTS_DATA_DIR || path.join(__dirname, '../projects-data'),
);

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SDK sessionId 必须 UUID 格式（防路径 traversal） */
export function validateSessionId(sid) {
  if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
    throw Object.assign(new Error(`非法 sessionId: ${JSON.stringify(sid)}`), { code: 'INVALID_SESSION_ID' });
  }
}

import {
  DEFAULT_GITIGNORE, DEFAULT_CLAUDE_MD, DEFAULT_CLAUDE_MD_RP,
} from './workspace-templates.js';
import { migrateMemoryLayout } from './memory-migration.js';

/**
 * NoDesign 全局默认 settings.json — 代码是 source of truth。
 *
 * 每次 ensureProjectWorkspace 都会跟 shared/.claude/settings.json merge
 * （existing 字段优先，新增 default 字段补上）。这样升级现存 project 不需要
 * 用户手动改文件。
 *
 * autoCompactEnabled / autoCompactWindow：
 *   2026-05-01 加 — Kimi gateway 上下文上限 256k（262144 tokens）。当前默认
 *   模型 kimi-k2.6 一旦 prompt 累积超 256k → gateway 直接 400 报错（用户实测
 *   request id 20260501104913995449543DV62Dl5F：requested 418547 tokens）。
 *   按 256k × 90% = 230400 tokens 触发自动 compact，SDK 用同模型压缩对话历史。
 *   PostCompact hook（hooks.js:84）已就位，compact 后摘要写 spec.json 长期记忆。
 *
 *   ⚠️ 历史坑（2026-05-08 修）：SDK binary 内部 model registry 不识别 kimi-*，
 *   rawMaxTokens fallback 到 Anthropic 标准 200000，链式后果 maxTokens
 *   = min(autoCompactWindow=230400, rawMaxTokens=200000) = 200000，
 *   autoCompactWindow=230400 永远被卡 200k，浪费 60k+ Kimi gateway 真实容量。
 *   修法：engine/agent/model-context.js 把 sdkOptions.model spoofing 成
 *   `claude-opus-4-7[1m]`（SDK 认 1M context），rawMaxTokens=1M 不再卡 230400；
 *   binary-fixup-proxy 在出口把 model 还原成真 kimi-k2.6 给 gateway。
 *   现在 230400 真生效，SDK auto-compact 在 230k 触发，留 26k margin 防 400。
 *
 *   2026-07-27 起不再写死 230400：按 NODESIGN_MODEL 真实窗口 × 0.9 计算。
 *   sonnet-5[1m] → 900000（SDK 在此再扣内部 reserve，实际 compact 触发 ~86w）；
 *   kimi-k2.6 → 230400（原值，256000 × 0.9）；未知模型兜底 200000 × 0.9。
 *   SDK 接受 1e5 ~ 1e6 区间。切回 kimi 只需改 env 重启，默认值自动跟随。
 *   旧项目 settings.json 里遗留的 230400 视为 stale default 强制迁移
 *  （mergeSettingsDefaults 内特判），用户手改过的其他值不动。
 */
const MAIN_MODEL = process.env.NODESIGN_MODEL || 'claude-sonnet-5[1m]';   // 08-21 深夜：kimi 行删了，兜底改订阅默认行（同 session-model.js）
const LEGACY_DEFAULT_WINDOWS = new Set([230400]);

function defaultAutoCompactWindow() {
  const realWindow = resolveModelContextWindow(MAIN_MODEL) ?? 200_000;
  return Math.min(Math.round(realWindow * 0.9), 1_000_000);
}

const DEFAULT_NODESIGN_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  autoCompactEnabled: true,
  autoCompactWindow: defaultAutoCompactWindow(),
};

/**
 * Merge NoDesign defaults 到现存 settings.json（existing 字段优先）。
 * 文件不存在时直接落 defaults。
 *
 * @returns {Promise<boolean>} 是否有改动（true = 写入了，false = 完全相同跳过）
 */
async function mergeSettingsDefaults(settingsPath) {
  let existing = {};
  if (await fileExists(settingsPath)) {
    try {
      existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch (err) {
      // 损坏的 JSON：保留备份后用 defaults 覆盖
      const backup = settingsPath + `.broken-${Date.now()}`;
      await fs.rename(settingsPath, backup).catch(() => {});
      console.warn(`[workspace] settings.json parse failed, backed up to ${backup}`);
      existing = {};
    }
  }
  const merged = { ...DEFAULT_NODESIGN_SETTINGS, ...existing };
  // stale default 迁移：旧代码把 230400 写进过所有项目的 settings.json，
  // existing 优先的 merge 规则会让新默认值永远进不去 —— 命中旧默认值时视为
  // "非用户自定义"，跟随当前默认。用户改成其他数字则尊重不动。
  if (
    LEGACY_DEFAULT_WINDOWS.has(existing.autoCompactWindow) &&
    existing.autoCompactWindow !== DEFAULT_NODESIGN_SETTINGS.autoCompactWindow
  ) {
    merged.autoCompactWindow = DEFAULT_NODESIGN_SETTINGS.autoCompactWindow;
  }
  // 旧 _comment 字段不再写默认（曾经的 placeholder），用户自定义保留
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return false;
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return true;
}

// ── 路径 helpers ──

/** 项目数据目录（容器：里面装 shared/ 和迁移前遗留的 sessions/） */
export function getProjectWorkspace(projectId) {
  validateProjectId(projectId);
  return path.join(PROJECTS_DATA_ROOT, projectId);
}

/**
 * **项目工作区根** —— agent 的 cwd，产物的家，画布上看到的一切的真相。
 *
 * 这是扁平化之后唯一有意义的"工作目录"概念。旧名 `getSharedDir` 继续可用
 * （40+ 处调用，含义没变）。
 */
export function getWorkspaceRoot(projectId) {
  return path.join(getProjectWorkspace(projectId), 'shared');
}

/** 旧名，等价于 getWorkspaceRoot */
export const getSharedDir = getWorkspaceRoot;

/**
 * 会话工作目录 = 项目工作区。**sessionId 只用来校验，不参与路径**。
 *
 * 保留这个名字是因为它是 SDK 侧 `cwd` 的取值口（转录目录 encodeCwdForSDK(cwd)
 * 从它算），28 处调用全都是"给这个会话一个 cwd"的意思 —— 现在这个答案对每个
 * 会话都一样，那正是"产物与 session 脱钩"。
 */
export function getSessionWorkspace(projectId, sessionId) {
  validateSessionId(sessionId);
  return getWorkspaceRoot(projectId);
}

/**
 * 会话私档目录（`<工作区>/.nd/<sid>/`）：spec.json（压缩摘要）、design-plan.md。
 *
 * 这些属于**对话**不属于产物，所以既不上画布也不进 git，但必须留在 cwd 内 ——
 * 放 cwd 外就得靠 additionalDirectories + 绝对路径，而 agent 看不见仓库路径。
 */
export function getSessionMetaDir(projectId, sessionId) {
  validateSessionId(sessionId);
  return path.join(getWorkspaceRoot(projectId), '.nd', sessionId);
}

// ── ensure ──

/**
 * 创建项目工作区（幂等）。完成后保证：
 *   - .claude/{CLAUDE.md, settings.json} 模板写入（仅不存在时）
 *   - .claude/{skills, agents, agent-memory} 目录存在
 *   - assets/ 存在、.gitignore 写入
 *   - 旧的三层结构（tasks/ + per-session 沙盒）已扁平化
 *   - .git 存在（项目级历史；扁平化前是 per-session 的）
 *
 * 扁平化跟着 ensure 走而不是单独一次性脚本：跟 removeRootLegacyArtifacts 同一个
 * 范式 —— 幂等、按项目惰性触发、跑过一次之后是 no-op。这样线上不需要停机窗口，
 * 也不存在"迁移脚本漏了哪个项目"。
 */
export async function ensureProjectWorkspace(projectId) {
  await removeRootLegacyArtifacts(projectId);

  const root = getWorkspaceRoot(projectId);
  await fs.mkdir(path.join(root, '.claude', 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude', 'agent-memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });

  // .gitignore 每次比对而不是"不存在才写"：扁平化新增了 .claude/projects/ 和
  // .nd/ 两条，老项目的文件里没有，不补的话 SDK 转录会被 commit 进项目历史。
  await ensureGitignore(path.join(root, '.gitignore'));
  // 记忆体系改版迁移（2026-08-24，幂等：源不在了就什么都不做）——
  // CLAUDE.md 从 .claude/ 挪到工作区根（画布可见，SDK 两处都读、根优先级同级），
  // 老的偏好/风格档案并进去，SDK auto-memory 的存量从 .claude/agent-memory/auto
  // 搬到画布可见的 记忆/。三步全是"搬走后源删除"，跑几遍结果一样。
  await migrateMemoryLayout(root, { fileExists });
  if (!(await fileExists(path.join(root, 'CLAUDE.md')))) {
    // rp 项目的档案按"戏"设栏（这份文件每个角色子代理也强制吃，见 templates 注释）。
    // 只管新项目：已有 CLAUDE.md 的一字不动 —— 用户内容优先于模板换代。
    const isRp = (getProject(projectId)?.mode || 'design') === 'rp';
    await fs.writeFile(path.join(root, 'CLAUDE.md'), isRp ? DEFAULT_CLAUDE_MD_RP : DEFAULT_CLAUDE_MD, 'utf8');
  }
  // settings.json：每次 merge defaults 让代码层 default 升级时现存 project 自动跟上
  // （用户字段优先，缺失的 NoDesign default 字段补进去）
  await mergeSettingsDefaults(path.join(root, '.claude', 'settings.json'));

  await flattenWorkspace(projectId);

  // 返回**工作区根**（…/shared），跟 ensureSessionWorkspace 一致（2026-08-13）。
  // 以前返回的是项目目录（shared 的上一层）——两个 ensure 返回值差一层目录，
  // 而 api 层的 rootOf 模式（pending-changes.js 首创）把两者当同一个 sessionRoot
  // 用：sid 走 ensureSessionWorkspace、项目级走这里。不统一的话项目级路由会把
  // pending-changes.json 之类写到 shared 外面，agent（读工作区根）永远看不见。
  // 改这里而不是改每个调用方：全仓只有 rootOf 消费这个返回值，其余 10 处都是
  // 纯 await 副作用。
  return getWorkspaceRoot(projectId);
}

/**
 * .gitignore：保证 DEFAULT_GITIGNORE 里每一条都在，用户自己加的行原样保留。
 * 按行合并而不是整文件覆盖 —— 有人会往里加自己的规则。
 */
async function ensureGitignore(file) {
  let existing = '';
  try { existing = await fs.readFile(file, 'utf8'); } catch { /* 还没有 */ }
  const have = new Set(existing.split('\n').map(l => l.trim()));
  const missing = DEFAULT_GITIGNORE.split('\n').filter(l => l.trim() && !have.has(l.trim()));
  if (!missing.length && existing) return;
  const merged = existing
    ? `${existing.replace(/\n*$/, '\n')}${missing.join('\n')}\n`
    : DEFAULT_GITIGNORE;
  await fs.writeFile(file, merged, 'utf8');
}

/**
 * 备好一个会话能开跑的一切（幂等）。返回**项目工作区根** = 这个会话的 cwd。
 *
 * 扁平化之后这里几乎没事干了，值得记一笔它以前干什么：建 `sessions/<sid>/`
 * 沙盒、拉五条绝对软链（.claude/CLAUDE.md、settings.json、skills、agents、
 * agent-memory、assets、tasks）、init 一个 per-session git。那一整套的存在
 * 理由只有一个 —— **cwd 不是工作区**，所以工作区里的东西得一条条链进来。
 *
 * cwd 就是工作区之后：软链零条（连带 bwrap 目录型软链冲突、Glob 不跟软链两个
 * 老坑一起消失），git 变成项目级一个仓（在 ensureProjectWorkspace 里 init）。
 *
 * @returns {Promise<string>} 项目工作区绝对路径（agent 的 cwd）
 */
export async function ensureSessionWorkspace(projectId, sessionId) {
  await ensureProjectWorkspace(projectId);
  const root = getWorkspaceRoot(projectId);
  // SDK 转录落点。它在 cwd/.claude/projects/<encoded-cwd>/<sid>.jsonl，
  // cwd 收敛成项目工作区之后，一个项目的所有会话转录并排住在同一个目录里
  // （这正是 Claude Code 自己的形状）。
  await fs.mkdir(path.join(root, '.claude', 'projects'), { recursive: true });
  await fs.mkdir(getSessionMetaDir(projectId, sessionId), { recursive: true });
  return root;
}

/**
 * 项目级 git（幂等）。扁平化前这是 per-session 的，
 * 现在一个项目一个仓 —— 产物归项目，历史当然也归项目。
 */
async function ensureProjectGit(root) {
  if (await fileExists(path.join(root, '.git'))) {
    // board.json 2026-08-08 才进 gitignore，而 gitignore 对**已经被跟踪**的
    // 文件不起作用 —— 得显式从索引里摘一次。幂等：没被跟踪时 rm 会失败，吞掉。
    await runGit(root, ['rm', '--cached', '-q', '--ignore-unmatch', 'board.json']).catch(() => {});
    return;
  }
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['add', '-A']);
  await runGit(root, [
    '-c', 'user.email=nodesign@local',
    '-c', 'user.name=NoDesign',
    'commit', '-q', '--allow-empty', '-m', 'init',
  ]);
}

// ── 扁平化迁移（2026-08-07）────────────────────────────────────────────

/** 迁移后旧结构改叫这个名字。留着不删 = 出事能退回去，而且给幂等一个干净的信号 */
const PRE_FLATTEN_DIR = 'sessions.pre-flatten';

/**
 * 真正属于**一次对话**的文件，扁平化后住 `.nd/<sid>/`。
 *
 * 这张表是踩出来的，不是想出来的：第一版只列了 spec.json 和 design-plan.md，
 * 拿真数据跑迁移时逐文件对账才发现另外两个 —— `session-config.json`（这条
 * 会话选的模型）和 `pending-changes.json`（画布上还没交给 agent 的改动）。
 * 这两个要是跟着别的东西一起摊平到工作区根，**两条会话会共用一份**：
 * 一边换模型另一边跟着变，一边的待处理改动被另一边 clear 掉。
 */
const SESSION_PRIVATE_FILES = [
  'spec.json',
  'design-plan.md',
  'session-config.json',
  'pending-changes.json',
];

/**
 * SDK 把 cwd 编码成 `<config>/projects/<encoded>/` —— 非字母数字一律换 '-'。
 * （算法 grep 自 sdk.mjs。）扁平化要搬转录，sessions.js 要按它找 jsonl，
 * 两边必须是同一个函数，所以放在这里当唯一真相。
 */
export function encodeCwdForSDK(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 三层（项目 → 任务 → 产物）扁平成两层（项目 → 产物）。**幂等**。
 *
 * 跑过之后 `sessions/` 改名成 `sessions.pre-flatten/`，下次进来一次 stat 就返回。
 *
 * 搬七样东西：
 *   1. `tasks/<任务>/*` → 工作区根。**只有一个任务时摊平**（线上 13 个有任务的
 *      项目全是这种），多个任务时各自变成一个顶层文件夹 —— 那样绝不撞名，
 *      html 里的相对引用也原封不动。
 *   2. 任务自己的 `.git`（旧形态留下的）→ 工作区的 `.git`，历史不丢。
 *   3. `.nd-task.json` 删掉：它记的是"这个任务属于哪个会话"，正是要废的那条绑定。
 *   4. `sessions/<sid>/{spec.json, design-plan.md}` → `.nd/<sid>/`。
 *   5. `sessions/<sid>/canvas.html`（旧式单 deck 会话）→ 工作区根。
 *   6. **SDK 转录**：cwd 变了，encoded 目录跟着变，不搬的话每条会话的历史全部
 *      失联。这是整个迁移里唯一不可逆的损失点，所以搬之前先确认目标不存在。
 *   7. `board.json` 的物件 id / 关系线端点重写，zones 整个丢掉。
 *
 * @returns {Promise<boolean>} 这次是否真的迁了（false = 早就迁过了）
 */
export async function flattenWorkspace(projectId) {
  const root = getWorkspaceRoot(projectId);
  const container = getProjectWorkspace(projectId);
  const sessionsDir = path.join(container, 'sessions');
  const tasksDir = path.join(root, 'tasks');

  const hasTasks = await pathExists(tasksDir);
  const hasSessions = await pathExists(sessionsDir);
  if (!hasTasks && !hasSessions) {
    await ensureProjectGit(root);
    return false;
  }

  return mutex(`flatten:${root}`, async () => {
    // 拿到锁再查一遍 —— 等锁那会儿别人可能已经迁完了
    if (!(await pathExists(tasksDir)) && !(await pathExists(sessionsDir))) return false;

    const log = [];
    const renames = new Map();   // 老物件 id → 新物件 id（board.json 用）

    // ① 任务目录上移一层：`tasks/<名>/` → `<名>/`
    //
    // **文件夹一律保留**，哪怕项目里只有一个。2026-08-07 那版在只有一个任务时
    // 会把内容摊平到工作区根（线上 13 个有产物的项目正好都是这种），当时的理由
    // 是「三个名字指同一样东西」。那个判断被推翻了：文件夹要升级成能嵌套、能
    // 自由摆放的一等公民，摊平等于把用户仅有的那个收纳容器也拆了。
    // 去掉的只有 `tasks/` 这一层中间目录，不是文件夹本身。
    if (await pathExists(tasksDir)) {
      const entries = await fs.readdir(tasksDir, { withFileTypes: true });
      const taskNames = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
      for (const name of taskNames) {
        const src = path.join(tasksDir, name);
        const dest = path.join(root, name);
        // 根上已经有同名东西才需要逐条合并；正常情况一次 rename 搞定，
        // 既快又不碰文件内容（撞名走 mergeDir，它会逐字节比对再决定）
        if (await pathExists(dest)) await mergeDir(src, dest, log);
        else await fs.rename(src, dest);
        await retireTaskMarker(dest, log);
        await fixEscapingRelativePaths(dest, log);
        renames.set(`tasks/${name}/`, `${name}/`);
        renames.set(`task/${name}`, name);
      }
      await fs.rm(tasksDir, { recursive: true, force: true });
      log.push(`tasks/ 这一层去掉（${taskNames.length} 个文件夹上移到工作区根）`);
    }
    await retireTaskMarker(root, log);

    // ④ ⑤ ⑥ 会话目录
    if (await pathExists(sessionsDir)) {
      const sids = (await fs.readdir(sessionsDir, { withFileTypes: true }))
        .filter(e => e.isDirectory() && SESSION_ID_RE.test(e.name)).map(e => e.name);
      for (const sid of sids) {
        const sRoot = path.join(sessionsDir, sid);
        const meta = path.join(root, '.nd', sid);
        await fs.mkdir(meta, { recursive: true });
        for (const f of SESSION_PRIVATE_FILES) {
          await moveFile(path.join(sRoot, f), path.join(meta, f), log);
        }
        // 旧式单 deck 会话的产物、以及 skill 拷进 cwd 的起手模板：都归工作区
        for (const f of ['canvas.html', 'canvas.template.html', 'site.template.html', 'style.template.css']) {
          await moveFile(path.join(sRoot, f), path.join(root, f), log);
        }
        // export_handoff 的落点：产物性质，归项目
        if (await pathExists(path.join(sRoot, 'exports'))) {
          await fs.mkdir(path.join(root, 'exports'), { recursive: true });
          await mergeDir(path.join(sRoot, 'exports'), path.join(root, 'exports'), log);
        }
        await moveTranscripts(sRoot, root, sid, log);
      }
      await fs.rename(sessionsDir, path.join(container, PRE_FLATTEN_DIR)).catch(async (err) => {
        if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
        // 已经有一份存档（迁移跑到一半重来过）→ 旧的那份留着，这次的丢进去
        await fs.rm(sessionsDir, { recursive: true, force: true });
      });
      log.push(`${sids.length} 个会话的私档与转录已归位`);
    }

    // ⑦ board.json
    await rewriteBoardIds(path.join(root, 'board.json'), renames, log);

    await ensureProjectGit(root);
    console.log(`[flatten] ${projectId}\n  ${log.join('\n  ')}`);
    return true;
  });
}

/**
 * 递归合并 src 的内容进 dest。
 *
 * 撞名策略：**字节相同就丢掉来的那份**（线上唯一一处撞名是 agent 把生成图从
 * assets/ 拷了一份进任务目录，7 个文件逐字节相同）。真不一样才两份都留，
 * 来的那份加后缀 —— 并且**大声报出来**，因为改名会让 html 里的引用指空。
 */
async function mergeDir(src, dest, log) {
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      if (await pathExists(to)) {
        await fs.mkdir(to, { recursive: true });
        await mergeDir(from, to, log);
        await fs.rm(from, { recursive: true, force: true });
      } else {
        await fs.rename(from, to);
      }
      continue;
    }
    if (!(await pathExists(to))) { await fs.rename(from, to); continue; }
    if (await sameFile(from, to)) { await fs.rm(from, { force: true }); continue; }
    const ext = path.extname(e.name);
    const alt = path.join(dest, `${path.basename(e.name, ext)}-任务版${ext}`);
    await fs.rename(from, alt);
    log.push(`⚠️ 撞名且内容不同：${e.name} → ${path.basename(alt)}（引用它的地方要改）`);
  }
}

/**
 * 旧任务标记 `.nd-task.json` → 新产物标记 `.nd-project.json`。
 *
 * 旧标记里有三样：`sessionId` / `boundAt`（"这个任务属于哪次对话" —— 正是这次
 * 要废掉的绑定，不带走）和 `kind`（形态兜底，还有用）。`root`（构建型站点显式
 * 声明产物根）线上数据里一个都没有，但真出现了也一并带走，它比 kind 更要紧。
 *
 * 不能只删不转：形态判定是「文件即真相，marker 兜底」，兜底那一支塌了的话，
 * 刚建好还没写入口文件的空文件夹会认不出形态。
 */
async function retireTaskMarker(dir, log) {
  const old = path.join(dir, '.nd-task.json');
  let parsed = null;
  try { parsed = JSON.parse(await fs.readFile(old, 'utf8')); } catch { return; }
  const keep = {};
  if (typeof parsed?.kind === 'string') keep.kind = parsed.kind;
  if (typeof parsed?.root === 'string') keep.root = parsed.root;
  const next = path.join(dir, '.nd-project.json');
  if (Object.keys(keep).length && !(await pathExists(next))) {
    await fs.writeFile(next, JSON.stringify(keep, null, 2), 'utf8');
    log.push(`${path.basename(dir)}/.nd-task.json → .nd-project.json（留下 ${Object.keys(keep).join('+')}，去掉会话归属）`);
  }
  await fs.rm(old, { force: true });
}

/**
 * 文件夹上移一层之后，修 HTML/CSS 里**爬出文件夹**的相对路径。
 *
 * 这是这次迁移唯一会**静默损坏内容**的地方，实测抓到的：
 *   `tasks/Space-Colony/_drafts/proto.html` 里写着 `../../../assets/generated/x.webp`
 *   —— 老位置深三层，爬三下正好到 `shared/assets/`。上移之后只剩两层，
 *   同样爬三下就爬到工作区外面，图全部 404，而页面照常渲染，没有任何报错。
 *
 * 判据是「这条引用有没有爬出它自己那个文件夹」：
 *   文件在文件夹内的深度 d（`<T>/f.html` → 0，`<T>/_drafts/f.html` → 1）
 *   引用的 `../` 个数 k
 *   k > d  = 爬出去了 → 少爬一层（文件夹整体上移了一层，外面的东西近了一层）
 *   k ≤ d  = 还在文件夹里面 → 一个字节都不动（文件和目标一起搬的，相对关系没变）
 */
async function fixEscapingRelativePaths(dir, log, depth = 0) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  let fixed = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      fixed += await fixEscapingRelativePaths(p, log, depth + 1);
      continue;
    }
    if (!/\.(html?|css|js)$/i.test(e.name)) continue;
    let src;
    try { src = await fs.readFile(p, 'utf8'); } catch { continue; }
    // 只认跟在引号 / url( / 空白后面的那种，避免动到正文里偶然出现的 "../"
    const next = src.replace(/(["'(\s=])((?:\.\.\/)+)/g, (m, lead, dots) => {
      const k = dots.length / 3;
      if (k <= depth) return m;                       // 没爬出这个文件夹
      return lead + '../'.repeat(k - 1);
    });
    if (next === src) continue;
    try { await fs.writeFile(p, next, 'utf8'); fixed += 1; } catch { /* 只读文件，跳过 */ }
  }
  if (fixed && depth === 0) log.push(`${path.basename(dir)}/ 里 ${fixed} 个文件的相对路径少爬了一层`);
  return fixed;
}

async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch { return false; }
}

async function moveFile(from, to, log) {
  if (!(await pathExists(from)) || await pathExists(to)) return;
  await fs.rename(from, to);
  log.push(`${path.basename(from)} → ${path.relative(path.dirname(path.dirname(to)), to)}`);
}

/**
 * SDK 转录搬家：`<config>/projects/<encode(老 cwd)>/*.jsonl`
 *                → `<config>/projects/<encode(新 cwd)>/`
 *
 * 不搬 = 每条会话打开是空白。已存在同名就跳过（不覆盖，宁可留在老目录里）。
 */
async function moveTranscripts(oldCwd, newCwd, sid, log) {
  const base = path.join(claudeConfigDir(), 'projects');
  const from = path.join(base, encodeCwdForSDK(oldCwd));
  const to = path.join(base, encodeCwdForSDK(newCwd));
  if (!(await pathExists(from))) return;
  await fs.mkdir(to, { recursive: true });
  let moved = 0;
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const dst = path.join(to, e.name);
    if (await pathExists(dst)) continue;
    await fs.rename(path.join(from, e.name), dst);
    moved += 1;
  }
  if (moved) log.push(`转录 ${moved} 份 → ${sid.slice(0, 8)}`);
}

/** 延迟取（platform.js 读 env，import 时机比这里早不了多少，但别在模块顶层固化） */
function claudeConfigDir() {
  return process.env.NODESIGN_CONFIG_DIR
    || path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
}

/**
 * board.json 的物件 id 重写 + zones 丢弃。
 *
 * id 里的任务段直接消失：
 *   `tasks/<t>/notes/a.md` → `notes/a.md`      （文件型物件 = 相对路径）
 *   `deck:task/<t>`        → `deck:canvas.html`
 *   `deck:task/<t>/x.html` → `deck:x.html`
 *   `site:task/<t>`        → `site:.`          （`.` = 产物根就是工作区根）
 *   `site:task/<t>/v2`     → `site:v2`
 *   `deck:<会话uuid>`       → 丢弃（会话 deck 这个概念随绑定一起废）
 *
 * 关系线的两个端点用同一张表改，改完两端还在才留 —— 否则线会挂在空气上。
 */
async function rewriteBoardIds(file, renames, log) {
  let board;
  try { board = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
  if (!board || typeof board !== 'object') return;

  const mapId = (id) => {
    if (typeof id !== 'string') return null;
    if (SESSION_DECK_RE.test(id)) return null;                 // 会话 deck 退役
    const m = id.match(/^(deck|site):task\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const [, type, task, rest] = m;
      const seat = renames.get(`task/${task}`);
      // 磁盘上没有这个任务了（board.json 里的陈年孤儿，指向的文件早就不在）。
      // 迁移前它就已经是死的，顺手清掉而不是搬到根上假装还活着。
      if (!seat) return null;
      const under = (p) => `${seat}/${p}`;
      if (type === 'deck') return `deck:${under(rest || 'canvas.html')}`;
      return `site:${rest ? under(rest) : seat}`;
    }
    for (const [oldPrefix, newPrefix] of renames) {
      if (oldPrefix.endsWith('/') && id.startsWith(oldPrefix)) {
        return newPrefix + id.slice(oldPrefix.length);
      }
    }
    // 还带着 `tasks/` 前缀却没匹配上任何一条改名 = 指向一个磁盘上早就没有的
    // 任务（board.json 里的陈年孤儿，实测 3wgl 有两条指向删掉的 shelter/）。
    // 迁移前它就不渲染，留着只会变成一条永远对不上号的路径。
    if (id.startsWith('tasks/')) return null;
    return id;
  };

  /**
   * 分区 → 文件夹。**不丢弃**（2026-08-08 改）。
   *
   * 上一版这里是 `delete next.zones` —— 那时的方向是分区整个体系退役。方向变了：
   * 分区降级成文件夹，是能嵌套、能自由摆放的一等公民，它在画布上的矩形、标题、
   * 收起状态都还要用。id 从 `task/<名>` 变成文件夹的工作区相对路径 `<名>`。
   *
   * 会话分区（id 是 sessionId 的那些，任务模型之前的遗产）没有对应的文件夹，
   * 照旧丢 —— 它们背后没有任何磁盘目录，留着就是永远删不掉的僵尸卡。
   */
  const mapZoneId = (id) => {
    if (typeof id !== 'string') return null;
    if (!id.startsWith('task/')) return null;
    return renames.get(id) ?? null;
  };

  const objects = {};
  for (const [id, o] of Object.entries(board.objects || {})) {
    const next = mapId(id);
    if (next && !objects[next]) objects[next] = o;
  }
  const zones = {};
  for (const [id, z] of Object.entries(board.zones || {})) {
    const next = mapZoneId(id);
    if (next && !zones[next]) zones[next] = z;
  }
  // 关系线的端点可以是物件，也可以是文件夹 —— 两种都要跟着改名。
  // **先判形状再解**：`task/<名>` 落进 mapId 会走到末尾那句 `return id` 被
  // 原样放行（既不匹配 `deck:` 那条正则，也不匹配任何以 '/' 结尾的前缀），
  // 于是永远轮不到 mapZoneId，文件夹端点就留在旧 id 上成了断头线。
  const mapEnd = (id) => (typeof id === 'string' && id.startsWith('task/') ? mapZoneId(id) : mapId(id));
  const bindings = {};
  for (const [id, b] of Object.entries(board.bindings || {})) {
    const from = mapEnd(b?.from);
    const to = mapEnd(b?.to);
    if (from && to && from !== to) bindings[id] = { ...b, from, to };
  }
  await fs.writeFile(file, JSON.stringify({ ...board, objects, zones, bindings }), 'utf8');
  log.push(`board.json：物件 ${Object.keys(board.objects || {}).length} → ${Object.keys(objects).length}`
    + `，文件夹 ${Object.keys(board.zones || {}).length} → ${Object.keys(zones).length}`
    + `，关系 ${Object.keys(board.bindings || {}).length} → ${Object.keys(bindings).length}`);
}

const SESSION_DECK_RE = /^deck:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── workspace 主动提醒（C8 SKILL/prelude 改造）──
//
// 给 turn.js composeUserMessage 用 —— 检测 sessionRoot 下 assets/ 软链指向的
// shared/assets/ 是否有内容，有就让 agent 看见 "<system>workspace 里有 N 个文
// 件……" 提示。空目录就不注入，agent 不必每个 turn 都硬 Glob 一遍。
//
// 之前的设计：prelude 强制 agent 首跑前 Glob assets/**/* —— 浪费一次 turn 即便
// 目录是空的。改成 workspace 主动 prepend 提示，把"是否需要看 assets" 这个
// 决策从"agent 必须先做"翻译成"agent 看到提示自己判断"。

// Office / PDF：二进制或 OOXML zip 包，Read 直接看是字节流，需 python 解


// ── 老结构清理（用户决策"删了"）──

/**
 * 检测 project workspace 根有 canvas.html / spec.json / .git / .claude 这些
 * S1 时代的老 artifacts，且 shared/ 不存在 → 这是老结构 → 全删。
 *
 * 运行一次性，每个 project 第一次进入新代码时清理。idempotent。
 */
export async function removeRootLegacyArtifacts(projectId) {
  const root = getProjectWorkspace(projectId);
  if (!(await fileExists(root))) return;
  if (await fileExists(path.join(root, 'shared'))) return;

  // 只有当老 artifacts 至少一个存在时，认定是老 project
  const legacyTargets = ['canvas.html', 'spec.json', '.git', '.gitignore', '.claude', 'assets'];
  let hadLegacy = false;
  for (const name of legacyTargets) {
    if (await fileExists(path.join(root, name))) { hadLegacy = true; break; }
  }
  if (!hadLegacy) return;

  for (const name of legacyTargets) {
    const p = path.join(root, name);
    if (await fileExists(p)) {
      await fs.rm(p, { recursive: true, force: true });
    }
  }
  console.log(`[workspace] removed legacy root artifacts for ${projectId}`);
}

// ── 删除 ──

export async function removeProjectWorkspace(projectId) {
  const root = getProjectWorkspace(projectId);
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * 删一个会话留下的东西 —— **只有它的私档**（`.nd/<sid>/`）。
 *
 * ⚠️ 扁平化之前这里是 `rm -rf sessions/<sid>/`，那时候产物住在会话目录里，
 * 所以"删会话"顺带删掉产物是对的。现在产物归项目，删对话不能动产物 ——
 * 这个函数要是照抄旧实现（删 getSessionWorkspace 返回的目录），删的就是
 * **整个项目工作区**。
 */
export async function removeSessionWorkspace(projectId, sessionId) {
  await fs.rm(getSessionMetaDir(projectId, sessionId), { recursive: true, force: true });
}

// ── git ops（per-session）──

/**
 * commit 项目工作区。无改动 silent skip。
 *
 * sessionId 现在只是**记在 commit 信息里的出处**（哪次对话干的），不再决定
 * 提交到哪个仓 —— 一个项目一个仓。两个会话同时收尾也不会打架：mutex 的 key
 * 是工作区路径，本来就串行。
 */
export async function commitWorkspace(projectId, sessionId, message, { author = 'system' } = {}) {
  const sessionRoot = getWorkspaceRoot(projectId);
  if (!(await fileExists(sessionRoot))) return null;
  // git race guard：用户 PUT canvas（DirectEdit 上行）+ agent Edit canvas.html
  // 同时触发会撞 .git/index.lock，最坏 lock 残留导致后续 commit 全卡死。per-sessionRoot
  // mutex 串行所有 git 写操作（commit / revert）。同 sid 共享 key=`git:${sessionRoot}`。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', `user.email=${author}@nodesign`,
      '-c', `user.name=${author}`,
      'commit', '-q', '-m', message,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

/**
 * 从某个 commit 到 HEAD 之间，git 认出来的**改名**。
 *
 * 画布物件的 id 就是工作区相对路径，所以 agent 在画布背后 `mv` 一个文件，
 * 画布上那张卡的身份就断了：坐标丢、关系线指向虚空、挂在它上面的批注成孤儿。
 * 而且**清理不掉** —— board.objects 是故意稀疏的（没被摆过的产物压根没有条目），
 * 所以"在 board 里但磁盘上没有"跟"agent 正在写、这一瞬读不到"没法区分，
 * 死 id 只能一直攒着。
 *
 * 靠 git 来认这件事，是因为它已经是这个工作区的历史，而且**自带内容相似度
 * 匹配** —— 一个文件被 mv 的同时改了几行，`-M` 照样认得出来，这是任何
 * 自建的路径比对做不到的。前提是每轮 turn 之后真的落了 commit
 * （2026-08-08 之前只有"用户直接编辑 HTML"那一条路会提交）。
 *
 * @returns {Promise<{ head: string|null, renames: Array<[string,string]> }>}
 */
export async function gitRenamesSince(projectId, fromCommit) {
  const root = getWorkspaceRoot(projectId);
  if (!(await fileExists(path.join(root, '.git')))) return { head: null, renames: [] };
  return mutex(`git:${root}`, async () => {
    let head = null;
    try {
      const { stdout } = await runGit(root, ['rev-parse', 'HEAD'], { capture: true });
      head = stdout.trim();
    } catch { return { head: null, renames: [] }; }
    if (!head || !fromCommit || fromCommit === head) return { head, renames: [] };

    let out = '';
    try {
      // -M50% 比默认宽松些：改名的同时顺手改几行内容是常态（重命名一份 deck
      // 往往连标题一起改）。太严的话这类改名认不出来，退化成"删一个加一个"。
      const r = await runGit(root, [
        'diff', '--name-status', '--find-renames=50%', '-z', fromCommit, head,
      ], { capture: true });
      out = r.stdout;
    } catch { return { head, renames: [] }; }

    // -z 的格式：状态 \0 旧路径 \0 新路径 \0（改名/复制是三段，其余两段）。
    // 用 -z 而不是换行分隔，是因为产物名里有中文和空格，默认输出会加引号转义。
    const parts = out.split('\0');
    const renames = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      if (st[0] === 'R') { renames.push([parts[i + 1], parts[i + 2]]); i += 2; }
      else i += 1;                       // 其余状态只跟一个路径
    }
    const files = renames.filter(([a, b]) => a && b);
    return { head, renames: [...await deriveFolderRenames(root, files), ...files] };
  });
}

/**
 * 从文件级改名推出**目录改名**。
 *
 * git 只认文件：`mv 稿件 定稿` 报出来是一串
 * `稿件/a.md → 定稿/a.md`、`稿件/b.md → 定稿/b.md`。而画布上的文件夹条目
 * （位置、标题、收起状态）的 id 是 `稿件` —— 没有任何一条文件配对匹配得上它，
 * 于是**机制二能改物件，永远改不了文件夹**。
 *
 * 推法：一对路径去掉最长公共后缀，剩下的头就是目录改名的候选
 * （`稿件/初稿/a.md → 定稿/初稿/a.md` 去掉 `/初稿/a.md` 得 `稿件 → 定稿`，
 * 天然拿到最高一层，正好是 mapId 前缀匹配要的粒度）。
 *
 * 然后**拿磁盘验一遍**才算数：老的确实没了、新的确实在。只有一个文件从
 * A/ 挪进 B/ 也会产生候选，但那时 A/ 还在，验不过。
 *
 * 目录排在文件前面返回：mapId 顺着 renames 的顺序找第一个命中，先按目录前缀
 * 改能一次盖住整棵子树，省得每个文件各改一遍还可能改出中间态。
 */
async function deriveFolderRenames(root, filePairs) {
  const cand = new Map();
  for (const [from, to] of filePairs) {
    const a = from.split('/');
    const b = to.split('/');
    let i = a.length - 1; let j = b.length - 1;
    while (i >= 0 && j >= 0 && a[i] === b[j]) { i -= 1; j -= 1; }
    if (i < 0 || j < 0) continue;                 // 一方是另一方的子路径，不是改名
    const dirA = a.slice(0, i + 1).join('/');
    const dirB = b.slice(0, j + 1).join('/');
    if (dirA && dirB && dirA !== dirB) cand.set(dirA, dirB);
  }
  const out = [];
  for (const [dirA, dirB] of cand) {
    if (await pathExists(path.join(root, dirA))) continue;   // 老的还在 = 没搬走
    if (!(await pathExists(path.join(root, dirB)))) continue; // 新的不在 = 别的事
    out.push([dirA, dirB]);
  }
  // 长的排前面：`稿件/初稿` 要先于 `稿件` 匹配，否则外层一改，内层那条就对不上了
  out.sort((x, y) => y[0].length - x[0].length);
  return out;
}

/**
 * 任务目录自己的 git。
 *
 * 为什么不复用 per-session git：**它根本盖不到任务文件。** git 仓在
 * `sessions/<sid>/.git`，而任务物理上在 `shared/tasks/`，会话里的 `tasks/` 只是
 * 一条软链。git 不跟随软链，`git add -A` 把 `tasks` 存成一个 mode 120000 的软链
 * 对象，任务文件内容从来没进过任何历史。线上实测过：随便挑个会话仓 cat-file，
 * tasks 就是个 120000 blob，且仓里只有一条 init commit。
 *
 * 就算能盖到也不该复用：session 仓的 checkout 会把 spec.json、notes 这些**会话
 * 状态**一起回退，而任务级的回退要的是「这份产物回到几步之前」，粒度不同。
 *
 * 懒初始化：第一次提交时才 init，没人调用就永远不会有 .git。
 *
 * ⚠️ 目前没有调用方（唯一的消费者随 world 形态一起拆了，2026-08-14）。留着是
 * 因为它跟形态无关 —— 下一个需要"按产物回退"的形态直接用，别再造一遍。
 *
 * @returns {Promise<string|null>} commit hash；没有改动返回 null
 */
export async function commitTaskWorkspace(taskDir, message, { author = 'agent' } = {}) {
  if (!(await fileExists(taskDir))) return null;
  return mutex(`git:${taskDir}`, async () => {
    if (!(await fileExists(path.join(taskDir, '.git')))) {
      await runGit(taskDir, ['init', '-q', '-b', 'main']);
    }
    await runGit(taskDir, ['add', '-A']);
    const { stdout } = await runGit(taskDir, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(taskDir, [
      '-c', `user.email=${author}@nodesign`,
      '-c', `user.name=${author}`,
      'commit', '-q', '-m', message,
    ]);
    const { stdout: hash } = await runGit(taskDir, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

export async function listHistory(projectId, sessionId, { limit = 50 } = {}) {
  // 同 commitWorkspace：git 仓是项目级一个，sessionId 不参与路径。这里直接取
  // 工作区根而不是走 getSessionWorkspace —— 后者会校验 sid 形状，而项目级路由
  // （2026-08-13 会话收敛）根本不带 sid，undefined 会被它一票否决。
  // sid 存在与否的校验责任在路由层 guard，不在这。
  const sessionRoot = getWorkspaceRoot(projectId);
  if (!(await fileExists(sessionRoot))) return [];
  const { stdout, code } = await runGit(
    sessionRoot,
    ['log', `--max-count=${limit}`, '--pretty=format:%H%x09%cI%x09%an%x09%s'],
    { capture: true },
  );
  if (code !== 0) return [];
  return stdout
    .trim().split('\n').filter(Boolean)
    .map((line) => {
      const [hash, isoDate, gitAuthor, ...msgParts] = line.split('\t');
      return { hash, date: isoDate, author: gitAuthor, message: msgParts.join('\t') };
    });
}

export async function revertWorkspace(projectId, sessionId, commitHash) {
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw Object.assign(new Error(`invalid commit hash: ${commitHash}`), { code: 'INVALID_COMMIT' });
  }
  // 同 listHistory：项目级一个仓，sessionId 不参与路径也不在这校验
  const sessionRoot = getWorkspaceRoot(projectId);
  // git race guard: 同 commitWorkspace —— checkout + 后续 commit 全 wrap mutex
  // 串行。注意：内层调 commitWorkspace 也会进 mutex，async-mutex-lite 对同 key 同
  // 调用栈会按 prev Promise chain，**不会死锁**（mutex 拿到后释放 prev、await prev
  // 已是 resolved 立即继续）—— 但为简洁还是把 checkout + commit 做成原子段，避免
  // checkout 完别的 commit 抢进来覆盖待 commit 的 staged 状态。
  return mutex(`git:${sessionRoot}`, async () => {
    await runGit(sessionRoot, ['checkout', commitHash, '--', '.']);
    await runGit(sessionRoot, ['add', '-A']);
    const { stdout } = await runGit(sessionRoot, ['status', '--porcelain'], { capture: true });
    if (!stdout.trim()) return null;
    await runGit(sessionRoot, [
      '-c', 'user.email=user@nodesign',
      '-c', 'user.name=user',
      'commit', '-q', '-m', `revert to ${commitHash.slice(0, 7)}`,
    ]);
    const { stdout: hash } = await runGit(sessionRoot, ['rev-parse', 'HEAD'], { capture: true });
    return hash.trim();
  });
}

// ── fork ──

/**
 * Fork 一条对话。**不再复制任何文件。**
 *
 * 以前 fork 要 `cp -r sessions/<src> → sessions/<new>`（连 .git 一起，语义是
 * "从这里继续"）。产物归项目之后这件事没有对应物了：两条分叉的对话面对的是
 * 同一个工作区，复制一份产物出来反而会造出两套互不相干的文件。
 *
 * 所以 fork 现在只发生在 SDK 那一侧（复制 jsonl 到新 sid），这里只把新会话的
 * 私档目录备好。
 */
export async function forkSessionWorkspace(projectId, srcSessionId, newSessionId) {
  validateSessionId(srcSessionId);
  validateSessionId(newSessionId);
  const root = getWorkspaceRoot(projectId);
  if (!(await fileExists(root))) {
    throw Object.assign(new Error(`fork source project not found: ${projectId}`), { code: 'SRC_NOT_FOUND' });
  }
  await fs.mkdir(getSessionMetaDir(projectId, newSessionId), { recursive: true });
  return root;
}

// ── helpers ──

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p) {
  // 区分 fileExists 用于"包括软链 dangling"的检查（lstat 不 follow）
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (capture) resolve({ code, stdout, stderr });
      else if (code === 0) resolve({ code });
      else reject(new Error(`git ${args.join(' ')} failed (code=${code})`));
    });
  });
}
