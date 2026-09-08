import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grepLog, toolInventory, sessionStatus, envSummary } from './runtime-readers.js';
import { registerIngressSession, unregisterIngressSession, switchSessionToStandby } from '../lib/ingress/session-routes.js';
import { registerQuerySession, unregisterQuerySession } from '../engine/runs/active-runs.js';
import { onDiagEvent, _resetDiagEvents } from '../lib/diag-events.js';

describe('grepLog', () => {
  it('pattern 子串不分大小写、/正则/ 也行；since 按行首时间戳；tail 截尾；没时间戳的行不被 since 过滤', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-grep-')), 'server.log');
    fs.writeFileSync(f, ['2026-09-08 11:00:00: [ws] a', '2026-09-08 11:25:50: [model-ingress] sid=abd0 客户端断开', 'no-timestamp line ECONNRESET', '2026-09-08 12:01:09: [model-ingress] sid=ed91 400 model=zai', ''].join('\n'));
    expect(grepLog(f, { pattern: 'MODEL-INGRESS' }).matched).toBe(2);
    expect(grepLog(f, { pattern: '/sid=\\w+ 400/' }).matched).toBe(1);
    const s = grepLog(f, { since: '2026-09-08T11:20:00' });
    expect(s.matched).toBe(4);   // 11:25、no-timestamp、12:01、空行
    expect(grepLog(f, { since: '2026-09-08 11:20', pattern: 'ingress', tail: 1 })).toMatchObject({ matched: 2, shown: 1 });
    expect(grepLog('/nope/x.log').error).toBeTruthy();
  });
});

describe('toolInventory', () => {
  it('常驻 / 延迟按名单分；rp 隐藏；能力闸没探过时 available=null', () => {
    const out = toolInventory(['screenshot_canvas', 'generate_image', 'publish_site', 'start_process'], new Set(['screenshot_canvas']), { mode: 'rp' });
    expect(out).toMatchObject({ total: 4, always: 1, deferred: 3, mode: 'rp' });
    const byName = Object.fromEntries(out.tools.map((t) => [t.name, t]));
    expect(byName.screenshot_canvas.load).toBe('always');
    expect(byName.publish_site.hiddenInMode).toBe('rp');
    expect(byName.generate_image.capability).toMatchObject({ needs: 'imageGen', mode: 'block' });
    expect(byName.start_process.capability.mode).toBe('unregister');
  });
});

describe('sessionStatus', () => {
  it('query 会话 + ingress 登记 + 环形账统计合成一行；换线后 switchedToStandby=true；只在 ingress 表里的也列出来', () => {
    _resetDiagEvents();
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001'; const lone = 'bbbbbbbb-0000-0000-0000-000000000002';
    registerIngressSession(sid, 'glm-5.3-flash-merge'); registerIngressSession(lone, 'glm-5.3-flash-merge');
    registerQuerySession(sid, { abortController: new AbortController(), inputQueue: {}, initialPermissionMode: 'default' });
    onDiagEvent({ type: 'run.context_usage', sessionId: sid, totalTokens: 10, maxTokens: 100, percentage: 10 });
    try {
      let st = sessionStatus();
      const row = st.sessions.find((s) => s.sessionId === sid);
      expect(row).toMatchObject({ model: 'glm-5.3-flash-merge', switchedToStandby: false, permissionMode: 'default', hasQuery: false, contextUsage: { percentage: 10 } });
      expect(st.sessions.find((s) => s.sessionId === lone).note).toContain('没有 query');
      switchSessionToStandby(sid);
      st = sessionStatus();
      expect(st.sessions.find((s) => s.sessionId === sid)).toMatchObject({ model: 'deepseek-v4-flash-vision', origModel: 'glm-5.3-flash-merge', switchedToStandby: true });
    } finally { unregisterQuerySession(sid); unregisterIngressSession(sid); unregisterIngressSession(lone); }
  });
});

describe('envSummary', () => {
  it('只报键名与掩码，不报值', () => {
    const saved = process.env.NODESIGN_RELAY_TOKEN; process.env.NODESIGN_RELAY_TOKEN = 'nd_secret_token_value_123456';
    try {
      const out = envSummary();
      const k = out.envKeys.find((x) => x.key === 'NODESIGN_RELAY_TOKEN');
      expect(k.set).toBe(true);
      expect(JSON.stringify(out)).not.toContain('secret_token_value');
      expect(typeof out.node).toBe('string');
    } finally { if (saved === undefined) delete process.env.NODESIGN_RELAY_TOKEN; else process.env.NODESIGN_RELAY_TOKEN = saved; }
  });
});
