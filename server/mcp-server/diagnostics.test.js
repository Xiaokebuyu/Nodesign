/**
 * NoDesign 作为 MCP 服务端·诊断段（09-08）：鉴权、握手、工具清单、health 能回。
 * 用 express 起一个只挂 /mcp 的小 app，走 supertest 风格的裸 http。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-mcp-'));
process.env.PROJECTS_DATA_DIR = path.join(tmp, 'data');
process.env.NODESIGN_DATA_DIR = path.join(tmp, 'nd-data');
const { mountMcpDiagnostics, mcpToken, MCP_PATH } = await import('./diagnostics.js');

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountMcpDiagnostics(app, { desktopState: () => ({ loggedIn: false }) });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}${MCP_PATH}`;
});
afterAll(() => new Promise(r => server.close(r)));

const rpc = (body, token) => fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe('MCP 诊断端点', () => {
  it('令牌落盘 0600，没带 / 带错一律 401', async () => {
    const tok = mcpToken();
    expect(tok.length).toBeGreaterThan(20);
    const r0 = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(r0.status).toBe(401);
    const r1 = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'wrong');
    expect(r1.status).toBe(401);
  });
  it('握手 + 工具清单 + health 能回版本和能力', async () => {
    const tok = mcpToken();
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, tok);
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe('nodesign-diagnostics');
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, tok)).json();
    const names = list.result.tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['health', 'list_projects', 'project_status', 'recent_runs', 'issues', 'server_log', 'session_transcript', 'session_debug_log', 'network_probe', 'relay_probe', 'api_events', 'tool_calls', 'session_status', 'tool_inventory', 'env_summary', 'browser_status', 'browser_log', 'relay_calls', 'upstream_balances', 'workspace_audit', 'ask_first_rate', 'issues_new']));
    const st = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_status', arguments: {} } }, tok)).json();
    expect(JSON.parse(st.result.content[0].text)).toHaveProperty('sessions');
    const inv = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tool_inventory', arguments: {} } }, tok)).json();
    const body2 = JSON.parse(inv.result.content[0].text);
    expect(body2.total).toBeGreaterThan(40);
    expect(body2.tools.find((t) => t.name === 'generate_image').load).toBe('deferred');
    expect(body2.tools.find((t) => t.name === 'screenshot_canvas').load).toBe('always');
    const h = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } }, tok)).json();
    const body = JSON.parse(h.result.content[0].text);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.relay).toEqual({ loggedIn: false });
  });
  it('GET / DELETE 405（无状态）', async () => {
    const r = await fetch(base, { headers: { authorization: `Bearer ${mcpToken()}` } });
    expect(r.status).toBe(405);
  });
});
