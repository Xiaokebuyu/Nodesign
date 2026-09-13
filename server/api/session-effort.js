/**
 * server/api/session-effort.js —— 会话思考等级的「校验 + 落盘 + 让跑着的会话认账」（2026-09-13）
 *
 * PUT /sessions/:sid/model 与 POST /turn（新会话带偏好）共用。跟 applySessionModel 同一个道理：写配置和
 * 让进程认账必须绑在一起，不然配置说 high、跑着的 CLI 还是 medium。
 *
 * 认账不用重启：Query.applyFlagSettings({ effortLevel }) 在 streaming input 下当场改，下一发请求就带新档
 * （09-13 探针：spoof 名下请求体 output_config.effort 从 low 变 high）。API 行的上游档位由 ingress 按请求体换算。
 */
import { writeSessionEffort } from '../engine/agent/session-model.js';
import { effortForModel } from '../engine/agent/model-context.js';
import { isEffortLevel } from '../engine/agent/model-effort.js';
import { getQuerySession } from '../engine/runs/active-runs.js';

/**
 * @param {{ sid: string, metaDir: string, model: string, effort: string|null }} args  model = 这个会话此刻（或刚切到）的模型
 * @param {{ getQuerySession?: Function, write?: Function }} [deps]  测试注入
 * @returns {Promise<{ ok: true, effort: string|null, applied: boolean } | { ok: false, status: number, body: object }>}
 */
export async function applySessionEffort({ sid, metaDir, model, effort }, deps = {}) {
  const lookup = deps.getQuerySession || getQuerySession;
  const write = deps.write || writeSessionEffort;
  if (effort !== null && !isEffortLevel(effort)) {
    return { ok: false, status: 400, body: { error: 'effort must be one of low|medium|high|xhigh|max or null', code: 'BAD_EFFORT' } };
  }
  const { choices } = effortForModel(model, null);
  if (effort !== null && !choices?.includes(effort)) {
    return { ok: false, status: 400, body: { error: `model ${model} does not offer effort ${effort}`, code: 'EFFORT_UNSUPPORTED', choices: choices || [] } };
  }
  await write(metaDir, effort);
  let applied = false;
  const qs = lookup(sid);
  if (qs?.query && typeof qs.query.applyFlagSettings === 'function' && !qs.abortController?.signal?.aborted) {
    try {
      await qs.query.applyFlagSettings({ effortLevel: effortForModel(model, effort).sdk });
      applied = true;
    } catch (err) {
      // 认账失败不回滚配置：下一次起会话照配置走；这里只记一笔
      console.warn(`[session-effort] sid=${String(sid).slice(0, 8)} applyFlagSettings 失败，下次起会话生效：${err?.message}`);
    }
  }
  return { ok: true, effort, applied };
}
