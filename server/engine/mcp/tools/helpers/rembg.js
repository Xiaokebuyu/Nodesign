/**
 * helpers/rembg.js — Node 侧抠图调用包装。两条路径：
 *
 *   1. **优先 Unix socket service**（warm，~5-15s/张）—— server 启动时
 *      services/rembg-launcher.js 已 spawn rembg-service.py 常驻进程，
 *      onnxruntime session 在内存。每次请求走 HTTP-over-Unix-socket。
 *
 *   2. **降级到 spawn-bridge**（cold，~30-180s/张）—— service down / 不可用时
 *      fallback 到 per-call spawn .venv-rembg/bin/python3 跑 rembg-bridge.py。
 *      首次部署 / dev 没装 service 时这条路径仍能跑通。
 *
 * Fail-soft：两条路径都失败时 return null，调用方降级（不抛）。
 *
 * Env override：
 *   NODESIGN_REMBG_SOCKET   Unix socket 路径（默认 /tmp/nodesign-rembg.sock）
 *   NODESIGN_REMBG_PYTHON   venv python 路径（默认 server/.venv-rembg/bin/python3）
 *   NODESIGN_REMBG_HELPER   spawn-bridge 脚本路径
 *   NODESIGN_REMBG_TIMEOUT  fallback 路径 subprocess 超时 ms
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers/ 在 server/engine/mcp/tools/helpers/，server root 上溯 4 层
const SERVER_ROOT = path.resolve(__dirname, '../../../../');

// venv 里 python 的位置按平台走（Windows 是 Scripts\python.exe，不是 bin/python3）；
// 安装提示同源，launcher / capabilities / remove_background 三处都引这里，别各写一遍
const IS_WIN = process.platform === 'win32';
export const REMBG_VENV_PYTHON = IS_WIN
  ? path.join(SERVER_ROOT, '.venv-rembg', 'Scripts', 'python.exe')
  : path.join(SERVER_ROOT, '.venv-rembg', 'bin', 'python3');
const SELF_BUILT_HINT = IS_WIN
  ? 'cd server && python -m venv .venv-rembg && .venv-rembg\\Scripts\\python.exe -m pip install rembg onnxruntime'
  : 'cd server && python3 -m venv .venv-rembg && .venv-rembg/bin/python3 -m pip install rembg onnxruntime';
/**
 * 装法提示 —— **是函数不是常量**：桌面版的抠图环境是下载来的组件包（NODESIGN_REMBG_PYTHON
 * 指到 <components>/rembg/python.exe），对那些用户说"cd server && python -m venv"没有任何意义。
 * 而组件的 env 是启动时才挂上的（runtime/components.js applyComponentEnv），模块加载那一刻还看不到，
 * 所以只能到用的时候现算。
 */
export function rembgSetupHint() {
  if (resolvePython() !== REMBG_VENV_PYTHON) {
    return '设置 → 组件 里把「rembg 抠图环境」卸了重装一次；'
      + '要是报的是 DLL 初始化例程失败，装一次 Microsoft Visual C++ 2015-2022 x64 运行库'
      + '（https://aka.ms/vs/17/release/vc_redist.x64.exe）再重启应用';
  }
  return SELF_BUILT_HINT;
}
const DEFAULT_PYTHON = REMBG_VENV_PYTHON;
const DEFAULT_HELPER = path.join(__dirname, 'rembg-bridge.py');
// fallback spawn 的 timeout——首次冷启 + 模型 load 留余量
const DEFAULT_FALLBACK_TIMEOUT_MS = 60_000;

function resolvePython() { return process.env.NODESIGN_REMBG_PYTHON || DEFAULT_PYTHON; }
function resolveHelper() { return process.env.NODESIGN_REMBG_HELPER || DEFAULT_HELPER; }
// socket 默认按**端口**派生（08-24 案：prod/exp 共用一个默认路径，exp 启动把生产的
// 抠图服务当 stale 杀掉再自己占坑）。端口一实例一个，是现成的实例身份。
// 这里是全仓唯一一份真相源，rembg-launcher.js import 它。
export function resolveRembgSocket() {
  return process.env.NODESIGN_REMBG_SOCKET || `/tmp/nodesign-rembg-${process.env.PORT || '4001'}.sock`;
}
/**
 * Windows 没有 Unix socket（Python 的 socket 模块在 Windows 上没有 AF_UNIX），走 127.0.0.1 上的一个端口。
 * 端口同样按实例端口派生；NODESIGN_REMBG_PORT 可覆盖。Linux/mac 仍走 socket 文件（不动生产的既定形状）。
 * 这是 http.request 的连接参数：{ socketPath } 或 { host, port }，四处请求都从这里拿。
 */
export function rembgTransport() {
  const port = Number(process.env.NODESIGN_REMBG_PORT);
  if (IS_WIN || Number.isFinite(port) && port > 0) {
    return { host: '127.0.0.1', port: Number.isFinite(port) && port > 0 ? port : 47000 + ((Number(process.env.PORT) || 4001) % 1000) };
  }
  return { socketPath: resolveRembgSocket() };
}
function resolveSocket() { return resolveRembgSocket(); }

// service health check 缓存（避免每次 request 都探一遍 /health）
let serviceHealthCache = { ok: false, checkedAt: 0 };
const HEALTH_CACHE_MS = 5_000;

/**
 * 探活 service：HTTP GET /health on Unix socket。带 5s cache 避免高频探测。
 */
async function isServiceHealthy() {
  const now = Date.now();
  if (now - serviceHealthCache.checkedAt < HEALTH_CACHE_MS) {
    return serviceHealthCache.ok;
  }
  const transport = rembgTransport();
  // socket 文件的路：先 stat 文件存在再 connect，省一次 ECONNREFUSED 的 noise（TCP 没这一步）
  if (transport.socketPath) {
    try {
      await fs.access(transport.socketPath);
    } catch {
      serviceHealthCache = { ok: false, checkedAt: now };
      return false;
    }
  }
  const ok = await new Promise((resolve) => {
    const req = http.request({
      ...transport,
      path: '/health',
      method: 'GET',
      timeout: 2000,
    }, (res) => {
      res.resume(); // drain
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
  serviceHealthCache = { ok, checkedAt: now };
  return ok;
}

/**
 * 通过 service Unix socket 调 /remove。
 * @returns {Promise<Buffer | null>}
 */
async function removeViaService(inputBuf, opts) {
  const transport = rembgTransport();
  const model = opts.model || 'birefnet-general-lite';
  const alphaMatting = opts.alphaMatting !== false;
  const timeoutMs = opts.timeoutMs || 180_000;

  return new Promise((resolve) => {
    const req = http.request({
      ...transport,
      path: '/remove',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': inputBuf.length,
        'x-model': model,
        'x-alpha-matting': alphaMatting ? '1' : '0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(Buffer.concat(chunks));
        } else {
          const text = Buffer.concat(chunks).toString().slice(0, 300);
          console.warn(`[rembg] service status ${res.statusCode}: ${text}`);
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', (err) => {
      console.warn(`[rembg] service request error: ${err.message}`);
      // 任何 socket 错都让 cache 立刻失效，下次会重新探活
      serviceHealthCache = { ok: false, checkedAt: 0 };
      resolve(null);
    });
    req.on('timeout', () => {
      console.warn(`[rembg] service timeout after ${timeoutMs}ms`);
      req.destroy();
      resolve(null);
    });
    req.write(inputBuf);
    req.end();
  });
}

/**
 * Fallback：spawn rembg-bridge.py per-call（cold path）。
 * @returns {Promise<Buffer | null>}
 */
async function removeViaSpawn(inputBuf, opts) {
  const py = resolvePython();
  const helper = resolveHelper();
  const model = opts.model || 'birefnet-general-lite';
  const alphaMatting = opts.alphaMatting !== false;
  const timeoutMs = opts.timeoutMs
    || Number(process.env.NODESIGN_REMBG_TIMEOUT)
    || DEFAULT_FALLBACK_TIMEOUT_MS;

  const args = [helper, '--model', model];
  if (alphaMatting) args.push('--alpha-matting');

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(py, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[rembg] spawn failed:', err.message);
      resolve(null);
      return;
    }

    const stdoutChunks = [];
    let stderrText = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      console.warn(`[rembg] spawn timeout after ${timeoutMs}ms`);
      finish(null);
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => { stderrText += chunk.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[rembg] spawn process error:', err.message);
      finish(null);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(
          `[rembg] spawn exit ${code} (model=${model}, alphaMatting=${alphaMatting}): ${stderrText.slice(0, 300).trim() || '(no stderr)'}`,
        );
        finish(null);
        return;
      }
      const out = Buffer.concat(stdoutChunks);
      if (out.length === 0) {
        console.warn(`[rembg] spawn empty stdout despite exit 0 (model=${model})`);
        finish(null);
        return;
      }
      finish(out);
    });

    try {
      proc.stdin.write(inputBuf);
      proc.stdin.end();
    } catch (err) {
      console.warn('[rembg] spawn stdin write failed:', err.message);
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * 这个 python 能不能真的 `import onnxruntime`（2026-09-10）。
 *
 * ⭐⭐ 为什么非得跑一次子进程：09-10 站主机器上，组件包装得好好的、文件全在，能力表因此一路
 * 报"可用"，而 service 每次起来都当场死在 `ImportError: DLL load failed ... 初始化例程失败`
 * （包里不带 MSVCP140*，跟系统那份老运行库配不上）。**探针问的问题要跟用户要做的事是同一个问题**：
 * 抠图要的是"import 得动"，不是"python.exe 在不在"。
 *
 * 缓存的方向是**只记成功**：成功写在 python 旁边（按大小+mtime 认人，换组件自动作废），以后免费；
 * 失败只在内存里留 60 秒 —— 用户装完运行库重探一下就该翻身，把失败钉在盘上等于给他一个出不去的门。
 */
const IMPORT_OK_FILE = '.nd-import-ok.json';
const IMPORT_FAIL_TTL_MS = 60_000;
const IMPORT_TIMEOUT_MS = 30_000;
let importFail = null;   // { at, reason, py }

async function pythonStamp(py) {
  const st = await fs.stat(py);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/** 成功的记号作废（service 意外退出时叫一下：环境可能是后来才坏的） */
export async function forgetImportCheck() {
  importFail = null;
  const py = resolvePython();
  try { await fs.unlink(path.join(path.dirname(py), IMPORT_OK_FILE)); } catch { /* 没有就算了 */ }
}

export async function checkImport() {
  const py = resolvePython();
  let stamp;
  try { stamp = await pythonStamp(py); } catch { return { ok: false, reason: `python not found: ${py}` }; }

  const okFile = path.join(path.dirname(py), IMPORT_OK_FILE);
  try {
    const rec = JSON.parse(await fs.readFile(okFile, 'utf8'));
    if (rec.stamp === stamp) return { ok: true, cached: true };
  } catch { /* 没记号 / 记号对不上 → 老老实实跑一次 */ }

  if (importFail && importFail.py === py && Date.now() - importFail.at < IMPORT_FAIL_TTL_MS) {
    return { ok: false, reason: importFail.reason, cached: true };
  }

  const reason = await new Promise((resolve) => {
    let proc;
    try {
      // PYTHONIOENCODING：中文 Windows 上 traceback 里的系统报错默认按 GBK 写出来，
      // 落进日志和界面就是一片乱码（server.log 里那几行就是），钉成 utf-8 才读得懂
      proc = spawn(py, ['-c', 'import onnxruntime'], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (err) { resolve(`spawn 失败：${err.message}`); return; }
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } resolve(`import 超时（${IMPORT_TIMEOUT_MS / 1000}s）`); }, IMPORT_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); resolve(`spawn 失败：${e.message}`); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve(null); return; }
      // traceback 的最后一行才是病因（前面全是调用栈）
      const last = err.trim().split(/\r?\n/).filter(Boolean).pop() || `退出码 ${code}`;
      resolve(last.slice(0, 300));
    });
  });

  if (reason) {
    importFail = { at: Date.now(), reason, py };
    return { ok: false, reason };
  }
  importFail = null;
  try { await fs.writeFile(okFile, JSON.stringify({ stamp, at: new Date().toISOString() })); } catch { /* 写不进去只是下次再跑一遍 */ }
  return { ok: true };
}

/**
 * 检查 rembg 整体可用——service 在线（那就是活证据）OR 文件齐 **且 import 得动**。
 * 不实际推理。
 *
 * @returns {Promise<{ available: boolean, mode?: 'service'|'spawn', reason?: string }>}
 */
export async function isAvailable() {
  if (await isServiceHealthy()) {
    return { available: true, mode: 'service' };
  }
  const py = resolvePython();
  const helper = resolveHelper();
  try {
    await fs.access(py);
  } catch {
    return { available: false, reason: `service down + python not found: ${py}` };
  }
  try {
    await fs.access(helper);
  } catch {
    return { available: false, reason: `service down + bridge script not found: ${helper}` };
  }
  const imp = await checkImport();
  if (!imp.ok) return { available: false, reason: `python 起得来但 import onnxruntime 不行：${imp.reason}` };
  return { available: true, mode: 'spawn' };
}

/**
 * 抠掉背景 → 返 transparent RGBA PNG Buffer。
 *
 * 路径选择：先试 service（warm，~5-15s）→ 失败降级 spawn（cold，30-180s）。
 *
 * @param {Buffer} inputBuf
 * @param {object} [opts]
 * @param {string} [opts.model='birefnet-general-lite']
 * @param {boolean} [opts.alphaMatting=true]
 * @param {number} [opts.timeoutMs] - service 路径默认 180s，spawn 路径默认 60s
 * @returns {Promise<Buffer | null>}
 */
export async function removeBackground(inputBuf, opts = {}) {
  if (!Buffer.isBuffer(inputBuf) || inputBuf.length === 0) {
    console.warn('[rembg] empty input buffer');
    return null;
  }

  // 路径 1：service warm
  if (await isServiceHealthy()) {
    const out = await removeViaService(inputBuf, opts);
    if (out) return out;
    console.warn('[rembg] service path failed, falling back to spawn');
    // service request 失败 → 降级到 spawn 不要直接返 null
  }

  // 路径 2：spawn cold fallback
  return removeViaSpawn(inputBuf, opts);
}
