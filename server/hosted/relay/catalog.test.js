/**
 * relay 目录（09-11 带整行）。最要紧的是第二组：**桌面照目录建出来的行，发出去的名字站点认得**。
 *
 * 站点的会话路由只认登记那一行的 id / sdkAlias 和它 helper 行的名字，别的一律改道 helper
 * （lib/ingress/session-routes.resolveSessionWire）。所以目录里给的别名要是不对，桌面那边一切正常、
 * 选择器也亮着，主回合却会被**静默**改道成 helper 模型。这里拿站点真的那套路由逐行对一遍。
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

const db = (await import('../../engine/runs/store.js')).default;
const { relayCatalogFor } = await import('./catalog.js');
const { RELAY_SUBSCRIPTION_CLOSED_REASON } = await import('./gates.js');
const { mergeRelayRows, withDefaultAlias } = await import('../../engine/agent/model-rows.js');
const { MODELS_BUILTIN, UPSTREAMS_BUILTIN } = await import('../../engine/agent/model-table.js');
const { RENAMED_MODELS } = await import('../../engine/agent/model-renames.js');
const { registerIngressSession, unregisterIngressSession, resolveSessionWire } = await import('../../lib/ingress/session-routes.js');

function makeUser({ role = 'user', plan = 'basic' } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, plan, disabled) VALUES (?, ?, ?, ?, ?, 0)').run(id, id, 'x', role, plan);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const admin = makeUser({ role: 'admin' });
const basic = makeUser({ plan: 'basic' });
const pro = makeUser({ plan: 'pro' });
const apiEntries = (c) => c.models.filter((e) => e.mode === 'api' && !e.helper);

describe('目录的形状', () => {
  it('老桌面认的三个字段还在；API 行带齐桌面建行要用的字段；helper 行跟着下发、不进选择器', () => {
    const c = relayCatalogFor(admin);
    expect(c.renames).toEqual(RENAMED_MODELS);
    expect(apiEntries(c).length).toBeGreaterThan(0);
    for (const e of apiEntries(c)) {
      expect(typeof e.locked).toBe('boolean');
      expect(e).toMatchObject({ id: expect.any(String), label: expect.any(String), window: expect.any(Number), sdkAlias: expect.any(String), fastModel: expect.any(String) });
      expect(['anthropic', 'openai-chat']).toContain(e.protocol);
      const helper = c.models.find((h) => h.id === e.fastModel);
      expect(helper, `${e.id} 的 helper ${e.fastModel} 没下发`).toBeTruthy();
      expect(helper.mode).toBe('api');
    }
    const helperOnly = c.models.find((m) => m.helper);
    expect(helperOnly?.label).toBeUndefined();
    // 上游地址 / 钥匙 / wireModel 不出这台机器
    expect(JSON.stringify(c)).not.toMatch(/baseUrl|keyEnv|wireModel/);
  });

  it('订阅行：pro 是订阅腿关着（lockKind=subscription、原因"暂不提供"），basic 是档位不够（tier）；localGen 行 basic 压根看不见', () => {
    expect(relayCatalogFor(pro).models.find((m) => m.id === 'claude-sonnet-5[1m]'))
      .toMatchObject({ locked: true, lockReason: RELAY_SUBSCRIPTION_CLOSED_REASON, lockKind: 'subscription', mode: 'subscription' });
    const c = relayCatalogFor(basic);
    expect(c.models.find((m) => m.id === 'claude-sonnet-5[1m]')).toMatchObject({ locked: true, lockKind: 'tier', mode: 'subscription' });
    const gated = MODELS_BUILTIN.filter((r) => r.select?.gate === 'localGen').map((r) => r.id);
    expect(c.models.some((m) => gated.includes(m.id))).toBe(false);
  });

  it('按钟点关门的行：关门时段里 locked + lockKind=closed，并且带着实际生效的时段（桌面据它现算）', () => {
    const row = MODELS_BUILTIN.find((r) => r.unavailable && r.select);
    expect(row, '表里得有一条按钟点关门的行').toBeTruthy();
    const [start] = row.unavailable.windows[0].split('-');
    const inside = new Date(`2026-09-11T${start}:30Z`);
    const e = relayCatalogFor(admin, { now: inside }).models.find((m) => m.id === row.id);
    expect(e).toMatchObject({ locked: true, lockKind: 'closed', unavailable: row.unavailable });
  });
});

describe('⭐ 桌面照目录建的行，站点的会话路由认得', () => {
  const c = relayCatalogFor(admin);
  const built = mergeRelayRows(MODELS_BUILTIN.map(withDefaultAlias), UPSTREAMS_BUILTIN, { ok: true, ...c }, { keyPresent: () => false });

  it('每一条都建出来了（没有因为别名不认识被丢掉）', () => {
    expect(built.errors).toEqual([]);
    for (const e of apiEntries(c)) expect(built.models.find((r) => r.id === e.id)?.relay, e.id).toBe(true);
  });

  it('桌面 CLI 发的主名（别名，含 SDK 剥掉 [1m] 的形态）→ 站点判 main 且落在这一行；helper 名 → 站点判 helper', () => {
    for (const e of apiEntries(c)) {
      const row = built.models.find((r) => r.id === e.id);
      const sid = `relay-contract-${e.id}`;
      registerIngressSession(sid, e.id);
      try {
        for (const name of [row.api.sdkAlias, row.api.sdkAlias.replace(/\[1m\]$/i, ''), row.id]) {
          const r = resolveSessionWire(name, sid);
          expect(r.role, `${e.id} 用 ${name} 发，站点判成了 ${r.role}`).toBe('main');
          expect(r.wire.appModel).toBe(e.id);
        }
        if (row.api.fastModel === row.id) continue;   // helper 就是自己的行（站点表里 gemini 那条这么写）：站点本来就认成 main
        const h = resolveSessionWire(row.api.fastModel, sid);
        expect(h.role).toBe('helper');
        expect(h.reason, `${e.id} 的 helper 名 ${row.api.fastModel} 站点没按表认`).toBe('table');
      } finally { unregisterIngressSession(sid); }
    }
  });
});
