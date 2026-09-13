/**
 * server/api/session-ownership.js —— 客户端带来的 sid 算不算这个项目的会话（2026-09-13）
 *
 * 活口会话表只按 sid 存。d6ca7c3d 堵住了「往别的项目正在跑的会话里推消息」，但留了一个口子
 * （09-13 fable 审查 P1-3）：受害者的会话空闲时（表里没有），攻击者在自己的项目里 POST /turn 带上这个 sid，
 * turn.js 就以 (sid, 攻击者项目) 起一个新会话并注册；此后受害者回自己的项目，turn 404、会话路由 404、
 * WS 拿不到快照，直到攻击者的会话空闲回收。sid 在前端地址里，截图和分享链接都会带出去。
 * 转录不会串：CLI 按工作目录找 jsonl，攻击者项目的工作目录里没有。
 *
 * 判据（新会话由服务端 randomUUID 铸号，不走这里；这里只管客户端给的 sid）：
 *   1. 正在本项目里跑 → 是；
 *   2. 正在别的项目里跑 → 不是（原来那道）；
 *   3. runs 表里这个 sid 的回合落在别的项目 → 不是；
 *   4. runs 表里在本项目跑过，或本项目工作目录下有它的转录（07-31 前的老会话 runs 没记 sid）→ 是；
 *   5. 哪儿都没有 → 不是。服务端从不让客户端自己起 sid，一个哪儿都没见过的 sid 只可能是编的或别处抄来的。
 * ⚠️ 不拿 `.nd/<sid>/` 私档目录当证据：sessions.js 的 PUT model / effort 会给任意 sid 建这个目录。
 */
import { querySessionInProject, querySessionBelongsElsewhere } from '../engine/runs/active-runs.js';
import { projectIdsForSession } from '../engine/runs/store.js';
import { jsonlExistsForSession } from '../projects/session-jsonl.js';
import { getSessionWorkspace } from '../projects/workspace.js';

/**
 * @param {string} projectId
 * @param {string} sid  已过 validateSessionId
 * @param {{ inProject?: Function, elsewhere?: Function, projectsOf?: Function, hasJsonl?: Function }} [deps]  测试注入
 * @returns {Promise<boolean>}
 */
export async function clientSessionBelongsToProject(projectId, sid, deps = {}) {
  const inProject = deps.inProject || querySessionInProject;
  const elsewhere = deps.elsewhere || querySessionBelongsElsewhere;
  const projectsOf = deps.projectsOf || projectIdsForSession;
  const hasJsonl = deps.hasJsonl || ((pid, s) => jsonlExistsForSession(getSessionWorkspace(pid, s), s));
  if (inProject(sid, projectId)) return true;
  if (elsewhere(sid, projectId)) return false;
  const seenIn = projectsOf(sid);
  if (seenIn.some((p) => p !== projectId)) return false;
  if (seenIn.includes(projectId)) return true;
  return hasJsonl(projectId, sid);
}
