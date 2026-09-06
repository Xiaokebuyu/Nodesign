/**
 * services/rembg-launcher.js — Node 侧管 rembg-service.py 子进程生命周期
 *
 * server/index.js 启动时调 startRembgService()，shutdown 时调 stopRembgService()。
 * service 自己常驻一个 python 进程把 onnxruntime session 缓存在内存里——
 * 比 per-call cold subprocess spawn 省 ~20-40s/call。
 *
 * Service 死了不影响主流程（fallback 到老的 spawn-bridge 路径，详见 helpers/rembg.js）。
 *
 * ── RSS 看门狗（2026-07-31 事故后加）──────────────────────────────
 * onnxruntime + pymatting 的内存高水位**不会自己降**：抠 8 张 1.5-2MP 的图能让
 * 这个进程从 345MB 涨到 1.2GB 并停在那儿。这台机器 3.9G 内存 + 2G swap，塞着
 * Cursor server（约 970MB）、SillyTavern、Claude SDK 子进程之后余量本来就薄，
 * 高水位不降就一路把系统推进内存抖动：内核忙于回收/换页，单核 CPU 被钉死 99%，
 * 机器活着但 SSH 和 HTTP 全都握不上手，只能人工关机。2026-07-31 04:24 就是这么死的。
 *
 * 所以：定期看 RSS，超阈值且**在途请求为 0** 时把 service 回收重开。它是无状态的，
 * 代价只是下次调用重新 load 一次模型（~20-40s，且预热是异步的不挡请求）。
 * service 侧还会在每次抠图后 gc + malloc_trim 主动还内存，看门狗是兜底不是主力。
 *
 * Env override：
 *   NODESIGN_REMBG_PYTHON     venv python 解释器路径
 *   NODESIGN_REMBG_SERVICE    service 脚本路径
 *   NODESIGN_REMBG_SOCKET     Unix socket 路径
 *   NODESIGN_REMBG_PRELOAD    逗号分隔预加载模型列表（默认 isnet-general-use）
 *   NODESIGN_REMBG_MAX_RSS_MB RSS 回收阈值（默认 900；0 = 关掉看门狗）
 *   NODESIGN_REMBG_WATCH_MS   看门狗巡检间隔（默认 60000）
 */

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import { REMBG_VENV_PYTHON, REMBG_SETUP_HINT, resolveRembgSocket, rembgTransport } from '../engine/mcp/tools/helpers/rembg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// services/ 在 server/services/，server root 上溯 1 层
const SERVER_ROOT = path.resolve(__dirname, '..');

const DEFAULT_PYTHON = REMBG_VENV_PYTHON;
const DEFAULT_SERVICE = path.join(__dirname, 'rembg-service.py');
// 默认只预热 isnet-general-use（fast 档）。birefnet-general-lite (balanced) /
// birefnet-general (best) 都带 alpha matting，pymatting 单线程 CPU 重，预热占
// 200-400MB 内存但实际很少用——按需 lazy load 即可。
// 改回多模型预热：env NODESIGN_REMBG_PRELOAD=isnet-general-use,birefnet-general-lite
const DEFAULT_PRELOAD = 'isnet-general-use';

// 按端口派生的实例私有 socket（真相源在 helpers/rembg.js 的 resolveRembgSocket；
// 08-24 案：prod/exp 共用一个默认路径时，killStaleServices 按 socket 判"自己人"
// 形同虚设，exp 一启动就把生产的抠图服务当 stale 杀掉再自己占坑）
const DEFAULT_SOCKET = resolveRembgSocket();
const MAX_RSS_MB = Number(process.env.NODESIGN_REMBG_MAX_RSS_MB ?? 900);
const WATCH_MS = Number(process.env.NODESIGN_REMBG_WATCH_MS ?? 60_000);

let serviceProc = null;
let started = false;
let watchTimer = null;
/** 看门狗主动回收时置位：让 exit handler 知道该重开，而不是当成异常退出 */
let recycling = false;

/** 问 service 的 /health（走 Unix socket）。拿不到就返 null，看门狗这轮跳过 */
function probeHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ ...rembgTransport(), path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * 一轮巡检。超阈值且在途为 0 → 回收。
 *
 * 在途不为 0 时**不回收**：宁可这一轮继续超着，也不能把用户正在等的抠图打断。
 * 下一轮还会再看，抠图是秒级的，不会一直忙。
 */
async function watchdogTick() {
  if (!serviceProc || recycling) return;
  const health = await probeHealth();
  if (!health || typeof health.rss_mb !== 'number') return;
  if (health.rss_mb < MAX_RSS_MB) return;
  if (health.inflight > 0) {
    console.log(`[rembg-service] RSS ${health.rss_mb}MB 超阈值 ${MAX_RSS_MB}MB，但有 ${health.inflight} 个在途请求，本轮不回收`);
    return;
  }
  console.log(`[rembg-service] RSS ${health.rss_mb}MB ≥ ${MAX_RSS_MB}MB 且空闲 → 回收重开（内存高水位不会自己降，见文件头注释）`);
  recycling = true;
  try {
    serviceProc.kill('SIGTERM');
  } catch { /* 已经死了，exit handler 会接手 */ }
}

/**
 * 把 service 进程钉成"内存不够时第一个该死的人"。
 *
 * 为什么需要：内存告急时，内核 OOM killer 和 earlyoom 都是按 oom_score 挑人，
 * 而这台机器上前几名的分数挤在一起（实测 rembg 712 / Cursor 708 / claude 扩展
 * 705 / nodesign 服务端 692，满分 1000）。差 4 分意味着 RSS 稍一波动排序就翻，
 * 于是本该背锅的抠图服务躲过去，反而杀掉 nodesign 或者你的 IDE 连接。
 *
 * oom_score_adj 加 500 分把它顶到榜首且拉开差距，让"谁会被杀"变成确定的事：
 * 抠图服务无状态，被杀了 helpers/rembg.js 会 fallback 到 per-call cold spawn，
 * 用户最多觉得慢一次；杀 nodesign 会丢掉正在跑的 agent 回合。
 *
 * 非 root 只能调高不能调低，加分这个方向一定能成功。
 */
function pinOomScore(pid) {
  const adj = Number(process.env.NODESIGN_REMBG_OOM_ADJ ?? 500);
  if (!Number.isFinite(adj) || adj === 0) return;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, String(adj));
    console.log(`[rembg-service] oom_score_adj=${adj}（内存告急时优先被杀，它是无状态的）`);
  } catch (err) {
    // 非 Linux / 权限不足：不是致命问题，earlyoom 的 --prefer 仍在兜着
    console.warn(`[rembg-service] oom_score_adj 设置失败（不影响功能）: ${err.message}`);
  }
}

function startWatchdog() {
  if (watchTimer || !(MAX_RSS_MB > 0) || !(WATCH_MS > 0)) return;
  watchTimer = setInterval(() => { watchdogTick().catch(() => {}); }, WATCH_MS);
  watchTimer.unref();   // 不因为它拖着不让进程退出
}

/**
 * 杀掉所有 stale rembg-service.py 进程（不属于本 launcher 的）。
 * 防止 node --watch reload / pm2 restart / 上次 SIGKILL 没清干净时
 * 多个 service 实例累积——每个加载一份模型 = 重复 200-400MB 内存浪费 +
 * 同一个 socket 文件 bind 冲突。
 *
 * 用 pgrep -f 找匹配 rembg-service.py 的进程，全 kill。同步执行——
 * 启动时一次性清干净，spawn 新 service 之前。
 */
function killStaleServices() {
  const mySocket = process.env.NODESIGN_REMBG_SOCKET || DEFAULT_SOCKET;
  try {
    // pgrep -f 匹配完整 cmdline，-d ' ' 用空格分隔多 PID。
    // pattern "python.*rembg-service\\.py" 收紧只匹配 python 解释器执行
    // rembg-service.py 的进程（避免误杀含字符串的 node test / 编辑器等）。
    const out = execSync('pgrep -ifd " " "python.*rembg-service\\.py"', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!out) return;
    // 排除自己当前进程（防自杀的边角）
    const myPid = process.pid;
    let pids = out.split(/\s+/).filter(Boolean).filter((p) => Number(p) !== myPid);
    // 只杀**绑同一个 socket** 的实例。socket 路径在 env 里不在 argv 里，所以
    // 读 /proc/<pid>/environ 判断。
    //
    // 为什么必须过滤：不加这层，任何第二个 nodesign 实例（隔离 e2e、本地
    // 另开一份、看门狗自测）一启动就会把生产实例的抠图服务杀掉，而生产侧
    // 对"意外退出"是不自动重启的，于是抠图静默降级成 per-call cold spawn，
    // 没人会发现。2026-07-31 我自己踩了一次。
    // 读不到 environ 的（权限/进程刚没）当作不是自己的，宁可漏杀不可错杀。
    pids = pids.filter((p) => {
      try {
        const env = readFileSync(`/proc/${p}/environ`, 'utf8');
        return env.split('\0').includes(`NODESIGN_REMBG_SOCKET=${mySocket}`)
          // 老进程可能没显式设这个 env（走的是 service 侧默认值）
          || (mySocket === DEFAULT_SOCKET && !env.includes('NODESIGN_REMBG_SOCKET='));
      } catch { return false; }
    });
    if (pids.length === 0) return;
    console.log(`[rembg-service] killing ${pids.length} stale service process(es): ${pids.join(', ')}`);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already dead */ }
    }
    // 给 1s 让 SIGTERM 走 atexit 清 socket；之后 SIGKILL 兜底
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        execSync('pgrep -if "python.*rembg-service\\.py"', { stdio: 'ignore' });
        // 还活着，继续 wait
      } catch {
        // pgrep exit 1 = 没找到 = 全死了
        return;
      }
    }
    // SIGTERM 1s 还没死 → SIGKILL
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ignore */ }
    }
  } catch (err) {
    // pgrep exit 1 = 没匹配进程，正常路径，不报错
    if (err.status !== 1) {
      console.warn(`[rembg-service] killStaleServices error: ${err.message}`);
    }
  }
}

/**
 * 启动 rembg-service。幂等：重复调用 noop。
 * 返回 boolean —— 是否启动成功（venv 不存在 / spawn 错时返 false，server 继续）。
 */
export async function startRembgService() {
  if (started) return Boolean(serviceProc);
  started = true;

  const py = process.env.NODESIGN_REMBG_PYTHON || DEFAULT_PYTHON;
  const script = process.env.NODESIGN_REMBG_SERVICE || DEFAULT_SERVICE;
  const preload = process.env.NODESIGN_REMBG_PRELOAD || DEFAULT_PRELOAD;

  // 先杀掉所有 stale rembg-service 进程（node --watch reload / SIGKILL 没清等
  // 路径会让多个 service 累积，每个吃 200-400MB 内存）
  killStaleServices();

  // venv 不存在直接 noop（首次部署 / dev 没装 rembg 的环境）
  try {
    await fs.access(py);
    await fs.access(script);
  } catch (err) {
    console.warn(
      `[rembg-service] not started: ${err.code === 'ENOENT' ? 'venv or script missing' : err.message}.`
      + ` Setup: ${REMBG_SETUP_HINT}.`
      + ' remove_background tool will fall back to per-call spawn (slower).',
    );
    return false;
  }

  const ok = spawnService(py, script, preload);
  if (ok) startWatchdog();
  return ok;
}

/**
 * 真正 spawn 一次。startRembgService 首次调，看门狗回收后也调。
 *
 * 退出处理分两种：
 *   看门狗主动回收（recycling=true）→ 立刻重开，这是预期行为
 *   意外退出（崩了 / 被 earlyoom 或 OOM killer 杀了）→ **不自动重启**，
 *     保持原有约定：单方面重启子进程会掩盖问题。抠图会 fallback 到 per-call
 *     cold spawn（慢但能用），日志里那行 exited 就是要让人看见的信号。
 */
function spawnService(py, script, preload) {
  try {
    serviceProc = spawn(py, [script], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        NODESIGN_REMBG_PRELOAD: preload,
        // 显式写进子进程 env：killStaleServices 靠读 /proc/<pid>/environ
        // 判断某个 service 是不是"自己这一份"，不写的话认不出来
        NODESIGN_REMBG_SOCKET: process.env.NODESIGN_REMBG_SOCKET || DEFAULT_SOCKET,
        // Windows 走 TCP（rembg-service.py 看到 NODESIGN_REMBG_PORT 就 bind 端口而不是 socket 文件）
        ...(rembgTransport().port ? { NODESIGN_REMBG_PORT: String(rembgTransport().port) } : {}),
      },
      // detached:false → child 跟父 share 进程组，父收 SIGINT 时 shell 也会
      // 转给 child（双保险）；显式 SIGTERM 仍走 stopRembgService()
      detached: false,
    });
  } catch (err) {
    console.warn(`[rembg-service] spawn failed: ${err.message}`);
    serviceProc = null;
    return false;
  }

  console.log(`[rembg-service] spawned PID ${serviceProc.pid}, preload=[${preload}]`);
  pinOomScore(serviceProc.pid);

  serviceProc.on('exit', (code, signal) => {
    console.log(`[rembg-service] exited code=${code} signal=${signal}`);
    serviceProc = null;
    if (recycling) {
      recycling = false;
      // 隔一拍再起：给 atexit 清 socket 的时间，否则新进程 bind 会撞上旧 socket 文件
      setTimeout(() => {
        if (started) {
          console.log('[rembg-service] 回收后重开');
          spawnService(py, script, preload);
        }
      }, 500).unref();
    }
  });

  serviceProc.on('error', (err) => {
    console.warn(`[rembg-service] process error: ${err.message}`);
  });

  return true;
}

/**
 * 优雅关闭 rembg-service。SIGTERM 让 service 走 atexit 清 socket。
 */
export function stopRembgService() {
  started = false;              // 让 exit handler 里的重开分支不再触发
  recycling = false;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  if (!serviceProc) return;
  console.log(`[rembg-service] stopping PID ${serviceProc.pid}`);
  try {
    serviceProc.kill('SIGTERM');
  } catch { /* ignore — already dead */ }
  // 兜底 3s 后 SIGKILL
  const killer = setTimeout(() => {
    if (serviceProc) {
      try { serviceProc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 3000);
  killer.unref();
  serviceProc = null;
}

/**
 * 给外部探活用（helpers/rembg.js 不强依赖；自己也会 isAvailable check service health）
 */
export function isRembgServiceRunning() {
  return serviceProc !== null && !serviceProc.killed;
}
