/**
 * 跨租户口径的源码级守卫（09-13）：API / WS 入口拿客户端给的 sid 查活口句柄，必须先过 querySessionBelongsElsewhere
 * （或直接用 querySessionInProject）。这张表 key 只有 sid，漏一处就是往别人会话里插消息 / 回滚别人文件的口子。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(path.join(root, f), 'utf8');

describe('会话句柄的跨租户守卫', () => {
  it('turn / sessions（含 rewind 挂载）/ ws 入口都过了守卫；task-stop 按项目取句柄', () => {
    expect(src('api/turn.js')).toMatch(/if \(querySessionBelongsElsewhere\(sid, project\.id\)\) return res\.status\(404\)/);
    expect(src('api/sessions.js')).toMatch(/router\.use\('\/:pid\/sessions\/:sid', \(req, res, next\) => \(querySessionBelongsElsewhere\(req\.params\.sid, req\.params\.pid\)/);
    expect(src('api/sessions.js')).toMatch(/mountRewindRoute\(router\)/);   // rewind 挂在同一个 router 上才吃得到上面那道
    expect(src('ws/index.js')).toMatch(/if \(sid && querySessionBelongsElsewhere\(sid, pid\)\) sid = null;/);
    expect(src('api/task-stop.js')).toMatch(/querySessionInProject\(s, p\)/);
    expect(src('engine/agent/session-loop.js')).toMatch(/projectId,\s+\/\/ API \/ WS 入口按 sid \+ pid 取句柄/);
  });
  it('⭐ sessions.js 的守卫中间件排在所有 /:pid/sessions/:sid 路由之前', () => {
    const s = src('api/sessions.js');
    const guard = s.indexOf("router.use('/:pid/sessions/:sid'");
    const firstRoute = s.search(/router\.(get|put|post|delete)\('\/:pid\/sessions\/:sid/);
    const mount = s.indexOf('mountRewindRoute(router)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstRoute);
    expect(guard).toBeLessThan(mount);
  });
});
