import { guardProject, guardRunInProject, modelUserFor } from './_guard.js';
import { getQuery, getRun, getSessionIdByRunId } from '../engine/runs/active-runs.js';
import { ensureSessionWorkspace, getSessionMetaDir } from '../projects/workspace.js';
import { applySessionModel, resolveSessionModel, defaultModel } from '../engine/agent/session-model.js';
import { registerIngressSession } from '../lib/model-ingress.js';
import { allowedModelsFor, isModelLockedFor, resolveSdkSpoofModel, modelSwitchRejection, resolveModelRoute } from '../engine/agent/model-context.js';
import { msg } from '../shared/messages.js';

/**
 * server/api/turn-model-switch.js — 运行中热切模型（08-25 从 turn.js 拆出，那边顶在 600 行棘轮上）。
 *
 * 只有这一个端点，但它自己就是一件完整的事：**turn 跑到一半换模型**，而 env（网关地址、钥匙）
 * 在起 query 那一刻就定死了、SDK 的 setModel 改不动 —— 所以这里的闸比"选模型"那两条路多两道，
 * 见 model-context.js 的 crossLaneSwitchReason（协议）与 hotSwitchLaneReason（通路）。
 */
/**
 * POST /api/projects/:pid/runs/:runId/model
 *
 * 运行中切 model（SDK query.setModel，当场对下一次 LLM 调用生效）。
 *
 * **目前只有 API 能到这里**：前端 picker 在 turn 运行中是禁用的，它走
 * PUT /sessions/:sid/model（那条等空闲才重启 query）。这条留着是因为"turn 跑到
 * 一半换模型"是它独有的能力，PUT 那条按设计做不到。前端那个没人调的 Turn.setModel
 * 绑定已删（doc 里还写着 kimi 时代的 model 名，留着只会误导下一个人）。
 *
 * 2026-07-30：切完**必须同时落 session-config**。原来这条只改运行时不写文件，
 * 于是"当前这轮是 Opus、下次 resume 变回 Sonnet"，而且界面无从得知；跟另外两条
 * 写模型的路加起来，同一个事实有三个互不知情的写者。现在统一走 applySessionModel，
 * 它自己会判断要不要重启空闲 query（这里 query 正在跑，不会重启）。
 *
 * Body: { model: string | null }  - null = 清掉覆盖回到全局默认
 */
export async function hotSwitchModelHandler(req, res, next) {
  try {
    const project = guardProject(req, res);
    if (!project) return;
    if (!guardRunInProject(req, res)) return;

    const { runId } = req.params;
    const { model } = req.body || {};
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ error: 'model must be string or null' });
    }

    // ⭐ 清覆盖（model=null）也要按"切到全局默认那一行"来判、来切。以前这条直接 setModel(undefined)：
    // API 会话里等于让 SDK 用它自己的默认 Claude 名发请求，入口反查不到就兜底到本会话的 **helper 行** ——
    // 表现是"点了『默认』，这一轮偷偷降级成 helper 模型"，而落盘写的是全局默认，运行时和文件对不上。
    const wanted = typeof model === 'string' ? model.trim() : '';
    const target = wanted || defaultModel();

    // 08-21：热切路以前不过白名单（任意字符串直达 SDK）。与 PUT /sessions/:sid/model 同口径
    if (wanted) {
      const modelUser = modelUserFor(req, project);   // 资格按项目 owner 算（_guard.js）
      if (isModelLockedFor(modelUser, wanted)) {
        return res.status(403).json({ error: msg(req, '这个模型仅限 Pro 档，暂未对外开放'), code: 'MODEL_LOCKED', model: wanted });
      }
      if (!allowedModelsFor(modelUser).some((m) => m.id === wanted)) {
        return res.status(400).json({ error: `unknown model: ${model}`, code: 'UNKNOWN_MODEL' });
      }
    }
    const sidForLane = getSessionIdByRunId(runId);
    if (sidForLane) {
      const cur = await resolveSessionModel(getSessionMetaDir(project.id, sidForLane));
      // running:true = 除了协议闸还要过通路闸（env 在起 query 那一刻定死，跨通路热切会拿订阅额度去跑 API 模型）。
      // 这里的会话必然跑过（getQuery 拿得到活的 run），hasHistory 用默认的 true
      const why = modelSwitchRejection({ from: cur.model, to: target, running: true });
      if (why) return res.status(409).json({ error: why, code: 'LANE_SWITCH' });
    }

    const query = getQuery(runId);
    if (!query) {
      return res.status(404).json({
        error: 'run not active',
        code: 'RUN_NOT_ACTIVE',
      });
    }
    if (typeof query.setModel !== 'function') {
      return res.status(501).json({
        error: 'SDK query handle missing setModel method',
        code: 'METHOD_NOT_AVAILABLE',
      });
    }

    const sid = getSessionIdByRunId(runId);
    // API 行喂 SDK 的是 spoof 名（session-loop 同款），appModel 本身 binary 不认识
    await query.setModel(resolveSdkSpoofModel(target));
    // 运行时切完再落盘：setModel 失败就不该留下"配置说切了"的假象
    let persisted = null;
    if (sid) {
      await ensureSessionWorkspace(project.id, sid);
      persisted = await applySessionModel(sid, getSessionMetaDir(project.id, sid), model ?? null, 'runtime');
      // ⭐ 入口的会话路由是**起 query 时**按当时的模型注册的（session-loop.js 的 registerIngressSession），
      // 热切必须跟着改注册，否则切过去的请求按旧注册判：独占别名算 collision、共用别名算 fallback，
      // 两种都改道回旧会话的 fast 行 —— 表现是"切了但这一轮没生效"，而且 fallback 每个名字只记一次日志，
      // 事后连线索都不容易翻到。上面的闸保证了这里两边同通路，所以只可能 api→api。
      const route = resolveModelRoute(persisted?.model || target);
      if (route.mode === 'api') {
        registerIngressSession(sid, route.appModel);
        // 记账那一侧也得跟着改：AgentContext.appModel 是起 query 时定死的，而 repriceUsageDeltas 按它
        // 做「会话优先」归属（共用别名根本不在全表反查里，纠不回来）—— 不更新的话热切之后主行那笔账
        // 会一直记在**切之前**那一行头上。⚠️ 只精确到下一次 absorb：本次差分窗口里切换前后的 usage
        // 混在一起，会整体归到新行；这比"整轮全记错行"好，但不是零误差。
        const run = getRun(runId);
        if (run?.ctx) run.ctx.appModel = route.appModel;
      }
    }
    res.json({ ok: true, model: persisted?.model ?? model, override: persisted?.override ?? null });
  } catch (err) { next(err); }
}
