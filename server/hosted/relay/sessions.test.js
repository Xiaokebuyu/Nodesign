import { describe, it, expect, beforeEach } from 'vitest';
import { openRelaySession, closeRelaySession, lookupRelaySession, sweepRelaySessions, _resetRelaySessions, _relaySessionCount } from './sessions.js';
import { resolveSessionWire } from '../../lib/ingress/session-routes.js';
import { SELECTABLE_MODELS, resolveModelRoute } from '../../engine/agent/model-context.js';

const apiModel = SELECTABLE_MODELS.find((m) => resolveModelRoute(m.id).mode === 'api')?.id;
const SID = 'sess-aaaa-bbbb-cccc';

beforeEach(() => _resetRelaySessions());

describe('openRelaySession', () => {
  it('API 行：登记后 ingress 的会话路由认得这个 sid（helper 默认名改道 fast 而不是 502）', () => {
    expect(apiModel).toBeTruthy();
    const r = openRelaySession({ sid: SID, appModel: apiModel, userId: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.session.mode).toBe('api');
    const routed = resolveSessionWire('claude-haiku-4-5', SID);
    expect(routed.wire).toBeTruthy();
    expect(routed.role).toBe('helper');
  });
  it('订阅行：mode=subscription，且不进 ingress 会话表', () => {
    const r = openRelaySession({ sid: SID, appModel: 'claude-sonnet-5[1m]', userId: 'u1' });
    expect(r.session.mode).toBe('subscription');
    // 没登记进 ingress 表：不带会话前缀时 resolveSessionWire 走全表反查的那条路
    expect(resolveSessionWire('zzz-not-a-model', SID).wire).toBeNull();
  });
  it('sid 形状不对 / 缺 appModel → 400', () => {
    expect(openRelaySession({ sid: 'a b', appModel: apiModel, userId: 'u1' }).status).toBe(400);
    expect(openRelaySession({ sid: SID, appModel: '', userId: 'u1' }).status).toBe(400);
  });
  it('别人登记过的 sid → 409；自己重复登记 = 幂等更新', () => {
    openRelaySession({ sid: SID, appModel: apiModel, userId: 'u1' });
    expect(openRelaySession({ sid: SID, appModel: apiModel, userId: 'u2' }).code).toBe('SID_TAKEN');
    const again = openRelaySession({ sid: SID, appModel: 'claude-sonnet-5[1m]', userId: 'u1' });
    expect(again.ok).toBe(true);
    expect(again.session.mode).toBe('subscription');
    expect(_relaySessionCount()).toBe(1);
  });
});

describe('lookup / close / sweep', () => {
  it('lookup 分三种：ok / foreign / unknown', () => {
    openRelaySession({ sid: SID, appModel: apiModel, userId: 'u1' });
    expect(lookupRelaySession(SID, 'u1').reason).toBe('ok');
    expect(lookupRelaySession(SID, 'u2').reason).toBe('foreign');
    expect(lookupRelaySession('nope-nope-nope', 'u1').reason).toBe('unknown');
  });
  it('close 只有本人能关，关掉后 ingress 表也清了', () => {
    openRelaySession({ sid: SID, appModel: apiModel, userId: 'u1' });
    expect(closeRelaySession(SID, 'u2')).toBe(false);
    expect(closeRelaySession(SID, 'u1')).toBe(true);
    expect(resolveSessionWire('claude-haiku-4-5', SID).wire).toBeNull();
  });
  it('sweep 收空闲的，不收活跃的', () => {
    openRelaySession({ sid: SID, appModel: apiModel, userId: 'u1' });
    openRelaySession({ sid: 'sess-2222-2222-2222', appModel: apiModel, userId: 'u1' });
    lookupRelaySession(SID, 'u1');   // 续命到 now
    // 第二个会话是刚登记的，lastSeen 也是 now；把它拨回三小时前
    const { session } = lookupRelaySession('sess-2222-2222-2222', 'u1');
    session.lastSeen = Date.now() - 3 * 60 * 60 * 1000;
    expect(sweepRelaySessions(Date.now())).toBe(1);
    expect(lookupRelaySession(SID, 'u1').reason).toBe('ok');
    expect(lookupRelaySession('sess-2222-2222-2222', 'u1').reason).toBe('unknown');
  });
});
