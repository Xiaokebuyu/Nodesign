/**
 * server/mcp-server/diagnostics.js — NoDesign 作为 MCP **服务端**的第一段：运行质量检查（2026-09-08 站主定）。
 *
 * 只在本地版挂（index.js），只读、只看运行情况：健康、能力探针、项目 / 仓库 / 进程 / 回合 / 问题库 / 日志尾巴。
 * 画布工具那一族**不在这里**（那是「作为服务端」的第二段，站主说先只做功能与健康检查）。
 *
 * 传输：Streamable HTTP（`POST /mcp`），无状态 —— 每个请求起一个 McpServer + transport，用完即扔。
 * 鉴权：Bearer 令牌，住 `<dataRoot>/mcp-token`（首次启动生成，0600）。**没有令牌一律 401**，哪怕只绑 127.0.0.1：
 * 桌面版 listenHost 是 127.0.0.1，但用户会拿 ssh -R 把它隧道到别处（给站主远程看的正是这条路）。
 *
 * 连法（Claude Code / Codex / curl）：
 *   claude mcp add --transport http nodesign http://127.0.0.1:<PORT>/mcp --header "Authorization: Bearer <token>"
 *   令牌：设置页「MCP」或 GET /api/local/mcp（本地版，需已登录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { platform } from '../runtime/platform.js';
import { capabilitySnapshot, probeCapabilities } from '../runtime/capabilities.js';
import { listProjects, getProject, folderPathOf } from '../projects/store.js';
import { getWorkspaceRoot, getAgentCwd } from '../projects/workspace.js';
import { repoSummary, listTurns, repoFolderOf } from '../projects/repo.js';
import { listProcesses, readProcessLog } from '../engine/process/registry.js';
import { listRuns } from '../engine/runs/store.js';
import { listActiveRuns } from '../engine/runs/active-runs.js';
import { listIssues } from '../lib/issues-store.js';
import { findTranscript, findDebugLog, readTranscript } from './session-transcript.js';
import { claudeDebugDir } from '../engine/agent/debug-file.js';
import { networkProbe, relayProbe } from './probes.js';
import { sessionStatus, toolInventory, envSummary, browserStatus, grepLog } from './runtime-readers.js';
import { listApiEvents, listToolCalls, listRelayCalls, upstreamBalances } from '../lib/diag-events.js';
import { auditWorkspace } from '../lib/workspace-audit.js';
import { askFirstStats } from '../engine/runs/store.js';
import { readPageLog } from '../engine/browse/page-log.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const MCP_PATH = '/mcp';
const TOKEN_FILE = 'mcp-token';
const startedAt = Date.now();
let cachedToken = null;
/** 版本从仓库根 package.json 读：桌面版是 node 直起 server，没有 npm_package_version */
let cachedVersion = null;
function appVersion() {
  if (cachedVersion) return cachedVersion;
  try { cachedVersion = JSON.parse(fs.readFileSync(path.join(platform.repoRoot, 'package.json'), 'utf8')).version || null; } catch { cachedVersion = process.env.npm_package_version || null; }
  return cachedVersion;
}

/** 令牌：首次生成落盘（0600），之后读文件。dataRoot 不可写时退回进程内随机值（本轮有效） */
export function mcpToken() {
  if (cachedToken) return cachedToken;
  const file = platform.dataRoot ? path.join(platform.dataRoot, TOKEN_FILE) : null;
  if (file) {
    try { cachedToken = fs.readFileSync(file, 'utf8').trim(); if (cachedToken) return cachedToken; } catch { /* 还没有 */ }
  }
  cachedToken = crypto.randomBytes(24).toString('base64url');
  if (file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, cachedToken + '\n', { mode: 0o600 }); } catch (err) { console.warn('[mcp] token 落盘失败：', err.message); }
  }
  return cachedToken;
}

function bearerOk(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1].trim()); const b = Buffer.from(mcpToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function text(obj) { return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }; }

async function tailFile(file, lines) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      const all = buf.toString('utf8').split('\n');
      return all.slice(-lines).join('\n');
    } finally { fs.closeSync(fd); }
  } catch (err) { return `（读不到 ${file}：${err.message}）`; }
}

/** 健康一览：版本 / 平台 / 进程 / relay / 能力。给 `health` 工具和 GET /api/local/health 共用 */
export function healthReport({ desktop = null } = {}) {
  const mem = process.memoryUsage();
  return {
    ok: true,
    version: appVersion(),
    profile: platform.profile,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    platform: { os: process.platform, release: os.release(), arch: process.arch, node: process.version, electron: process.versions.electron || null },
    dataRoot: platform.dataRoot, cacheRoot: platform.cacheRoot,
    sandboxEnabled: platform.sandboxEnabled, permissionModeDefault: platform.permissionModeDefault,
    memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    activeRuns: listActiveRuns().length,
    relay: desktop,
    capabilities: capabilitySnapshot().map(c => ({ id: c.id, level: c.level, available: c.available, detail: c.detail || null, fix: c.available ? undefined : c.fix })),
  };
}

function buildServer({ desktopState }) {
  const server = new McpServer({ name: 'nodesign-diagnostics', version: appVersion() || '0.0.0' });

  server.registerTool('health', {
    description: '运行健康一览：版本、平台、内存、在飞回合数、relay 登录态、能力探针结果（哪些外部程序在 / 不在）。',
    inputSchema: {},
  }, async () => text(healthReport({ desktop: desktopState?.() || null })));

  server.registerTool('probe_capabilities', {
    description: '重新探一遍外部程序 / 服务（git、chromium、LibreOffice、ffmpeg、进程能力…），回最新结果。',
    inputSchema: {},
  }, async () => { await probeCapabilities({ force: true }); return text(capabilitySnapshot()); });

  server.registerTool('list_projects', {
    description: '本机所有项目：id、名字、模式、文件夹路径（有的话）、桌面在哪、活动会话。',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, async ({ limit }) => text(listProjects({ limit: limit ?? 100 }).map(p => ({
    id: p.id, name: p.name, mode: p.mode, folderPath: p.folderPath || null,
    desk: p.folderPath ? getWorkspaceRoot(p.id) : null, cwd: p.folderPath ? getAgentCwd(p.id) : null,
    folderTrust: p.folderTrust ?? null, activeSessionId: p.activeSessionId || null, updatedAt: p.updatedAt,
  }))));

  server.registerTool('project_status', {
    description: '一个项目的现状：仓库（分支 / 上次提交 / 未提交改动）、最近几轮改了什么、在跑的进程、最近回合的状态与报错。',
    inputSchema: { project_id: z.string().min(1) },
  }, async ({ project_id }) => {
    const p = getProject(project_id);
    if (!p) return text({ error: 'no such project' });
    const [repo, turns, processes] = await Promise.all([
      repoSummary(project_id).catch(e => ({ error: e.message })),
      listTurns(project_id, { limit: 5 }).catch(() => []),
      listProcesses(project_id).catch(() => []),
    ]);
    const runs = listRuns({ limit: 200 }).filter(r => r.projectId === project_id).slice(0, 10)
      .map(r => ({ id: r.id, status: r.status, error: r.error, models: Object.keys(r.metadata?.modelUsage || {}), createdAt: r.createdAt, finishedAt: r.finishedAt, sessionId: r.sessionId }));
    return text({
      project: { id: p.id, name: p.name, mode: p.mode, folderPath: p.folderPath || null, folderTrust: p.folderTrust ?? null, desk: getWorkspaceRoot(p.id), cwd: getAgentCwd(p.id), activeSessionId: p.activeSessionId || null },
      repo, turns, processes, runs,
    });
  });

  server.registerTool('recent_runs', {
    description: '最近的回合（跨项目）：状态、报错、模型、耗时。看「用户说没反应」时先看这个。',
    inputSchema: { limit: z.number().int().min(1).max(100).optional(), status: z.string().optional() },
  }, async ({ limit, status }) => text(listRuns({ limit: limit ?? 20, status }).map(r => ({
    id: r.id, projectId: r.projectId, sessionId: r.sessionId, status: r.status, error: r.error,
    models: Object.keys(r.metadata?.modelUsage || {}), durationMs: r.metadata?.durationMs ?? null, toolFailures: r.metadata?.toolFailures ?? null,
    createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
    tokens: { in: r.inputTokens, out: r.outputTokens, cacheRead: r.cacheReadTokens }, costUsd: r.totalCostUsd,
  }))));

  server.registerTool('list_processes', {
    description: '一个项目登记过的长驻进程（dev server / 后端）：状态、端口、命令。',
    inputSchema: { project_id: z.string().min(1) },
  }, async ({ project_id }) => text(await listProcesses(project_id)));

  server.registerTool('read_process_log', {
    description: '读一个进程的日志尾巴。',
    inputSchema: { project_id: z.string().min(1), id: z.string().min(1), tail: z.number().int().min(1).max(400).optional() },
  }, async ({ project_id, id, tail }) => text(await readProcessLog(project_id, id, { tail: tail ?? 120 })));

  server.registerTool('issues', {
    description: '问题库（agent / 前端 / 桌面端上报的 friction 与故障），新的在前。',
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), status: z.string().optional(), source: z.string().optional() },
  }, async ({ limit, status, source }) => text(listIssues({ limit: limit ?? 30, status, source })));

  server.registerTool('server_log', {
    description: '服务端 / 桌面主进程日志尾巴（<dataRoot>/logs/server.log 与 desktop.log）。pattern=子串或 /正则/（不分大小写）；since=时间下限（"2026-09-08 11:20"），按行首时间戳过滤。',
    inputSchema: { which: z.enum(['server', 'desktop']).optional(), tail: z.number().int().min(10).max(2000).optional(), pattern: z.string().max(200).optional(), since: z.string().max(40).optional() },
  }, async ({ which, tail, pattern, since }) => {
    const dir = platform.dataRoot ? path.join(platform.dataRoot, 'logs') : null;
    if (!dir) return text('没有数据目录（不是本地版？）');
    const file = path.join(dir, `${which || 'server'}.log`);
    if (!pattern && !since) return text(await tailFile(file, tail ?? 200));
    return text(grepLog(file, { tail: tail ?? 200, pattern: pattern || null, since: since || null }));
  });

  // ── 09-08「多埋几个点」那批：探针两件、环形账两本、状态四件 ──
  server.registerTool('network_probe', {
    description: '到站点的链路探针：DNS（解析到 198.18.x = 本机 fake-ip 代理在中间）、TCP、TLS 握手耗时、/api/health 往返、系统代理环境变量。「首发 API 重试中 — unknown」这类连接层问题先看它。',
    inputSchema: { url: z.string().url().optional(), timeout_ms: z.number().int().min(1000).max(30000).optional() },
  }, async ({ url, timeout_ms }) => text(await networkProbe({ url, timeoutMs: timeout_ms ?? 8000 })));

  server.registerTool('relay_probe', {
    description: '用当前设备令牌真打站点的 /whoami、/models、/notice：状态码、耗时、账号档位、模型清单与锁定原因。分清「登录态坏了」和「模型不可用」。',
    inputSchema: { timeout_ms: z.number().int().min(1000).max(30000).optional() },
  }, async ({ timeout_ms }) => text(await relayProbe({ timeoutMs: timeout_ms ?? 8000 })));

  server.registerTool('api_events', {
    description: '进程内环形账（最近 500 条）：SDK 的 API 重试（次数 / 错误种类 / 状态码）、每轮用量（输入 / 输出 / 缓存命中）与停止原因、压缩、错误。看「模型这一发怎么了」「缓存有没有命中」用它。',
    inputSchema: { session_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async ({ session_id, limit }) => text(listApiEvents({ sessionId: session_id, limit: limit ?? 100 })));

  server.registerTool('tool_calls', {
    description: '进程内环形账（最近 500 条）：每次工具调用的名字、耗时、成败、错误摘要。agent 绕圈（同一工具连调）在这里直接显形。',
    inputSchema: { session_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async ({ session_id, limit }) => text(listToolCalls({ sessionId: session_id, limit: limit ?? 100 })));

  server.registerTool('session_status', {
    description: '内存里的会话登记表：钉的模型、有没有换到备用线、权限模式、在飞回合、上下文用量、压缩次数、最后活动时间。',
    inputSchema: {},
  }, async () => text(sessionStatus()));

  server.registerTool('tool_inventory', {
    description: '业务工具清单：每件是常驻还是延迟加载（延迟的要 ToolSearch 才有 schema）、rp 模式下是否隐藏、本机能力闸怎么判（缺 chromium / LibreOffice 等）。用户说「agent 说没有这个工具」时用。',
    inputSchema: { mode: z.enum(['design', 'rp']).optional() },
  }, async ({ mode }) => {
    const { createNodesignMcpServer, ALWAYS_LOAD_TOOLS } = await import('../engine/mcp/index.js');
    const root = platform.dataRoot ? path.join(platform.dataRoot, 'tmp', 'tool-inventory') : os.tmpdir();
    fs.mkdirSync(root, { recursive: true });
    const srv = createNodesignMcpServer({ workspaceRoot: root, sharedRoot: root, projectId: 'proj_diag', sessionId: 'diag', ctx: {}, projectMode: 'design' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'diag', version: '0' });
    try {
      await srv.instance.connect(a); await client.connect(b);
      const { tools } = await client.listTools();
      return text(toolInventory(tools.map((t) => t.name), ALWAYS_LOAD_TOOLS, { mode: mode || 'design', toolSearch: true }));
    } finally { try { await client.close(); } catch { /* */ } try { await srv.instance.close(); } catch { /* */ } }
  });

  server.registerTool('env_summary', {
    description: '运行环境一览：.env 白名单键配没配（只报键名与掩码，不报值）、权限模式、沙盒开关、数据目录磁盘余量、进程内存与运行时长。',
    inputSchema: {},
  }, async () => text(envSummary()));

  server.registerTool('browser_status', {
    description: '常驻浏览器：每个项目的当前 URL、忙闲、空闲时长、页面日志里最后一次错误；桌面版另附壳里的视图表（摆没摆上桌面 / 矩形 / 真实 bounds / zoom / 遮没遮）。',
    inputSchema: {},
  }, async () => text(await browserStatus()));

  server.registerTool('browser_log', {
    description: '一个项目常驻浏览器的页面日志（console 的 warn/error、pageerror、请求失败、>=400 的响应；页关了日志还在）。',
    inputSchema: { project_id: z.string().min(1), limit: z.number().int().min(1).max(300).optional(), level: z.enum(['error', 'warn']).optional() },
  }, async ({ project_id, limit, level }) => text(readPageLog(project_id, { limit: limit ?? 100, level: level || null })));

  server.registerTool('session_transcript', {
    description: '一个会话的 Claude Code 记录（<claudeConfigDir>/projects/…/<session_id>.jsonl），每行压成一句：时间 / 角色 / 工具名与参数 / 工具结果类型。查「agent 为什么绕圈、最后一发发了什么」用这个；raw=true 回原始 jsonl 行。',
    inputSchema: { session_id: z.string().min(1), tail: z.number().int().min(1).max(500).optional(), raw: z.boolean().optional() },
  }, async ({ session_id, tail, raw }) => {
    const f = findTranscript(platform.claudeConfigDir, session_id);
    if (!f) return text(`没找到会话 ${session_id} 的记录（${platform.claudeConfigDir || '无 claudeConfigDir'}/projects/*/${session_id}.jsonl）`);
    return text(readTranscript(f, { tail: tail ?? 80, summary: !raw }));
  });

  server.registerTool('session_debug_log', {
    description: '一个会话的 Claude Code 调试日志尾巴（本地版每会话一份，<dataRoot>/logs/claude-debug/<session_id>.txt）：API 重试的底层原因（连接错误 / 状态码 / 响应体）在这里。which=stderr 读 CLI 子进程的 stderr 全量（<session_id>.stderr.log）。',
    inputSchema: { session_id: z.string().min(1), tail: z.number().int().min(10).max(2000).optional(), which: z.enum(['debug', 'stderr']).optional() },
  }, async ({ session_id, tail, which }) => {
    if (which === 'stderr') {
      const f = claudeDebugDir() && /^[0-9a-f-]{36}$/i.test(session_id) ? path.join(claudeDebugDir(), `${session_id}.stderr.log`) : null;
      if (!f || !fs.existsSync(f)) return text(`没找到会话 ${session_id} 的 stderr 文件（${claudeDebugDir() || '无数据目录'}/${session_id}.stderr.log）`);
      return text(await tailFile(f, tail ?? 200));
    }
    const f = findDebugLog(claudeDebugDir(), session_id, 'claude-debug') || findDebugLog(platform.claudeConfigDir, session_id);
    if (!f) return text(`没找到会话 ${session_id} 的调试日志（${claudeDebugDir() || '无数据目录'}/${session_id}.txt，也不在 ~/.claude/debug/）`);
    return text(await tailFile(f, tail ?? 200));
  });

  // ── 09-08 晚第二批埋点：relay 每发三时刻 / 上游余额 / 工作区对账 / 反问率 / 问题库新签名 ──
  server.registerTool('relay_calls', {
    description: '桌面到站点的 relay 调用环形账（最近 500 条）：路径、状态码、响应头耗时、总耗时、错误。跟站点的 relay_usage 对账，定位停顿在哪一段。',
    inputSchema: { limit: z.number().int().min(1).max(500).optional() },
  }, async ({ limit }) => text(listRelayCalls({ limit: limit ?? 100 })));

  server.registerTool('upstream_balances', {
    description: '各上游最近一次响应头里的余额（merge 的 x-credit-balance-usd）与时间；余额一发之间掉超过 0.5 美元会在 server.log 里 warn。',
    inputSchema: {},
  }, async () => text(upstreamBalances()));

  server.registerTool('workspace_audit', {
    description: '一个项目板↔磁盘对账：板上有座位但磁盘不存在的卡（dangling）、磁盘上有但板上没有的文件（unseated，前 50 个）。run 收尾时也自动跑一次，dangling>0 记 auto 问题。',
    inputSchema: { project_id: z.string().min(1) },
  }, async ({ project_id }) => text(await auditWorkspace(project_id)));

  server.registerTool('ask_first_rate', {
    description: '反问率：最近 N 天每个回合第一个工具是不是 AskUserQuestion，按主模型分组（run.metadata.firstTool，09-08 之前的回合记 unknown）。',
    inputSchema: { days: z.number().int().min(1).max(90).optional() },
  }, async ({ days }) => text(askFirstStats({ days: days ?? 7 })));

  server.registerTool('issues_new', {
    description: '问题库里最近 N 天**第一次出现**的签名（first_seen 在窗口内），新的在前；跟 issues 工具的区别是它只看新面孔。',
    inputSchema: { days: z.number().int().min(1).max(90).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ days, limit }) => {
    const since = Date.now() - (days ?? 7) * 86400000;
    const rows = listIssues({ limit: 500 }).filter((i) => new Date(String(i.firstSeen).replace(' ', 'T') + 'Z').getTime() >= since);
    rows.sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
    return text({ days: days ?? 7, count: rows.length, issues: rows.slice(0, limit ?? 50).map((i) => ({ id: i.id, firstSeen: i.firstSeen, count: i.count, source: i.source, toolName: i.toolName, summary: String(i.summary).slice(0, 160) })) });
  });

  server.registerTool('repo_folder', {
    description: '一个项目的仓库文件夹路径（没有仓库卡的项目回 null）。',
    inputSchema: { project_id: z.string().min(1) },
  }, async ({ project_id }) => text({ folder: repoFolderOf(project_id), folderPath: folderPathOf(project_id) }));

  return server;
}

/**
 * Express 挂载：`POST /mcp`（JSON-RPC 走这里）；GET / DELETE 在无状态模式下直接 405。
 * @param {import('express').Express} app
 * @param {{ desktopState?: () => object }} deps
 */
export function mountMcpDiagnostics(app, { desktopState = null } = {}) {
  mcpToken();   // 启动时就生成，设置页能立刻拿到
  app.post(MCP_PATH, async (req, res) => {
    if (!bearerOk(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: Bearer <mcp-token> required' }, id: null });
      return;
    }
    const server = buildServer({ desktopState });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.warn('[mcp] request failed:', err.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
    }
  });
  const reject = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless server: POST only' }, id: null });
  app.get(MCP_PATH, reject);
  app.delete(MCP_PATH, reject);
}
