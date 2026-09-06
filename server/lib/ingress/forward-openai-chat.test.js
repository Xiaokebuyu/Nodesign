// 发往 openai-chat 上游的请求头（09-06 OpenCode 来信要 x-opencode-session 时补的）
import { describe, it, expect } from 'vitest';
import { upstreamHeaders } from './forward-openai-chat.js';
import { UPSTREAMS } from '../../engine/agent/model-context.js';

const target = new URL('https://opencode.ai/zen/go/v1');
const base = { key: 'k', wantStream: true, target, bodyLength: 12 };
const wireOn = (upstreamId) => ({ upstreamId, upstream: UPSTREAMS[upstreamId] });

describe('upstreamHeaders：x-opencode-session', () => {
  it('⭐ OpenCode 两个入口（zen / zenGo）都带 x-opencode-session = 会话 id（主行和 helper 同一场对话同一个值）', () => {
    for (const id of ['zen', 'zenGo']) {
      const h = upstreamHeaders({ ...base, wire: wireOn(id), sessionTag: 'sess-abc' });
      expect(h['x-opencode-session'], id).toBe('sess-abc');
      expect(h['user-agent']).toBe('NoDesign-ingress/1 (+https://nodesign.xiaobuyu.trade)');   // 信里点名的就是这个 UA
      expect(h.authorization).toBe('Bearer k');
    }
  });

  it('没带会话前缀（探针 / 体检）也有值，且同一进程内稳定 —— 每发都换等于没给', () => {
    const a = upstreamHeaders({ ...base, wire: wireOn('zenGo'), sessionTag: null });
    const b = upstreamHeaders({ ...base, wire: wireOn('zenGo') });
    expect(a['x-opencode-session']).toMatch(/^nd-untagged-[0-9a-f-]{36}$/);
    expect(b['x-opencode-session']).toBe(a['x-opencode-session']);
  });

  it('⛔ 不是 OpenCode 的 openai-chat 上游（NVIDIA）不发这个头 —— 按服务商挂不按协议挂', () => {
    expect(UPSTREAMS.nvidia.protocol).toBe('openai-chat');   // 对照组先验：它确实走同一条转换层
    const h = upstreamHeaders({ ...base, wire: wireOn('nvidia'), sessionTag: 'sess-abc' });
    expect(Object.keys(h).some((k) => /session/i.test(k))).toBe(false);
  });

  it('判据先验：表里挂 sessionHeader 的恰好就是 OpenCode 那两家', () => {
    expect(Object.entries(UPSTREAMS).filter(([, u]) => u.sessionHeader).map(([id]) => id).sort()).toEqual(['zen', 'zenGo']);
  });
});
