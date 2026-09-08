/**
 * mcp-server/runtime-readers.js —— 诊断端点的只读读取器（2026-09-08「多埋几个点」那批）：
 *   sessionStatus   会话登记表（ingress 主行 / 换没换线 + query 会话 + 上下文用量 / 压缩次数 / 在飞回合）
 *   toolInventory   60 个工具各自：常驻还是延迟、当前模式下有没有筛掉、能力闸怎么判、ToolSearch 开没开
 *   envSummary      .env 白名单键配没配（只报键名与掩码预览，不报值）、权限模式、沙盒、数据目录磁盘余量
 *   browserStatus   常驻浏览器：每项目 URL / 忙闲 / 空闲时长 + 页面日志的最后一次错误
 *   grepLog         server_log 的 pattern / since 版本
 */
import fs from 'node:fs';
import path from 'node:path';
import { platform } from '../runtime/platform.js';
import { envView } from '../runtime/local-env.js';
import { listQuerySessions, listActiveRuns } from '../engine/runs/active-runs.js';
import { listIngressSessions } from '../lib/ingress/session-routes.js';
import { sessionDiagStats } from '../lib/diag-events.js';
import { status as browserResidents } from '../engine/browse/registry.js';
import { readPageLog } from '../engine/browse/page-log.js';
import { desktopViews } from '../engine/browse/desktop-host.js';
import { TOOL_CAPABILITIES } from '../engine/mcp/capability-gate.js';
import { RP_HIDDEN_TOOLS } from '../engine/mcp/mode-profile.js';
import { capabilityState } from '../runtime/capabilities.js';

export function sessionStatus() {
  const ingress = new Map(listIngressSessions().map((r) => [r.sessionId, r]));
  const activeRuns = listActiveRuns();   // runId 列表；归属按 currentRunId 对
  const rows = listQuerySessions().map((q) => {
    const ing = ingress.get(q.sessionId) || null; ingress.delete(q.sessionId);
    const st = sessionDiagStats(q.sessionId);
    return { ...q, model: ing ? ing.appModel : '(订阅行或未登记)', origModel: ing?.origModel ?? null, switchedToStandby: !!ing?.switched, contextUsage: st?.contextUsage ?? null, compactions: st?.compactions ?? 0, rounds: st?.rounds ?? 0, lastEventAt: st?.lastEventAt ?? null, activeRuns: activeRuns.filter((id) => id === q.currentRunId) };
  });
  // 只在 ingress 表里、query 已经没了的（漏清或已收工）
  for (const r of ingress.values()) rows.push({ sessionId: r.sessionId, hasQuery: false, model: r.appModel, origModel: r.origModel, switchedToStandby: r.switched, note: 'ingress 有登记但没有 query 会话' });
  return { count: rows.length, sessions: rows };
}

/** @param {string[]} allNames design 模式全量注册名（调用方从 MCP 实例列出来） @param {Set<string>} alwaysLoad */
export function toolInventory(allNames, alwaysLoad, { mode = 'design', toolSearch = true } = {}) {
  const tools = allNames.map((name) => {
    const cap = TOOL_CAPABILITIES[name] || null;
    const capState = cap ? capabilityState(cap.cap) : null;
    return {
      name, load: alwaysLoad.has(name) ? 'always' : 'deferred',
      hiddenInMode: mode === 'rp' && RP_HIDDEN_TOOLS.has(name) ? 'rp' : null,
      capability: cap ? { needs: cap.cap, mode: cap.mode, available: capState ? !!capState.available : null } : null,
    };
  });
  return { mode, toolSearch, total: tools.length, always: tools.filter((t) => t.load === 'always').length, deferred: tools.filter((t) => t.load === 'deferred').length, unavailable: tools.filter((t) => t.capability && t.capability.available === false).map((t) => t.name), tools };
}

function diskFree(dir) {
  try { const s = fs.statfsSync(dir); return { freeMB: Math.round((s.bavail * s.bsize) / 1048576), totalMB: Math.round((s.blocks * s.bsize) / 1048576) }; } catch { return null; }
}
export function envSummary() {
  const keys = envView().map((k) => ({ key: k.key, group: k.group, set: k.set, preview: k.secret ? (k.set ? k.preview : '') : k.preview }));
  return {
    profile: platform.profile, dataRoot: platform.dataRoot, repoRoot: platform.repoRoot, claudeConfigDir: platform.claudeConfigDir,
    permissionMode: platform.permissionModeDefault ?? null, sandboxEnabled: !!platform.sandboxEnabled, node: process.version, uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576), disk: platform.dataRoot ? diskFree(platform.dataRoot) : null,
    envKeys: keys, setCount: keys.filter((k) => k.set).length,
  };
}

export async function browserStatus() {
  const residents = browserResidents().map((r) => ({ ...r, log: (() => { const l = readPageLog(r.projectId, { limit: 1 }); return { total: l.total ?? 0, lastError: l.lastError ?? null }; })() }));
  const shell = await desktopViews();   // 桌面版：壳里的视图表（placed / rect / bounds / zoom / blocked）
  return { resident: residents.length, residents, ...(shell !== null ? { shellViews: shell } : {}) };
}

/** 日志尾巴 + 过滤：pattern（大小写不敏感的子串或 /regex/）、since（ISO 或 "2026-09-08 11:2"，按行首时间戳字符串比较） */
export function grepLog(file, { tail = 200, pattern = null, since = null, maxBytes = 2 * 1024 * 1024 } = {}) {
  let text;
  try {
    const st = fs.statSync(file); const size = Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, st.size - size); text = buf.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch (err) { return { file, error: `读不到：${err.message}` }; }
  let lines = text.split('\n');
  if (since) { const s = String(since).replace('T', ' ').slice(0, 19); lines = lines.filter((l) => { const m = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(l); return !m || m[1].replace('T', ' ') >= s; }); }
  if (pattern) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
    let re; try { re = m ? new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') : null; } catch { re = null; }
    const needle = pattern.toLowerCase();
    lines = lines.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(needle)));
  }
  return { file, matched: lines.length, shown: Math.min(tail, lines.length), text: lines.slice(-tail).join('\n') };
}
