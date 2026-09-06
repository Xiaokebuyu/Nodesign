/**
 * server/hosted/relay/tools.js —— relay 的工具中继（09-07，站主：把网页端能提供的服务都给桌面端）。
 *
 * 桌面版没有站主的搜索 key / 生图通道。这里用站主的钥匙替它跑**供应商那一步**，其余（落盘、缩略图、上墙）
 * 仍在用户本机。闸和账跟网页端同一套尺子：
 *   - 档位     auth/tier.js 的 can(user, cap)（tier-gate.tierDenialForOwner，连 basic 档搜索日上限一起）
 *   - 日额度   lib/quota.checkQuota（生图前判，跟网页端 withTierGate 一样）
 *   - 记账     usage.recordRelayUsage（生图 $0.20/张进 relay_usage，quota 的用量源已并进去）
 *
 * 端点（都在 deviceAuth 之后）：
 *   POST /tools/web_search      { query, provider, count, includeImages } → { providerId, providerNote, hits, images }
 *   POST /tools/generate_image  { prompt, aspectRatio, imageSize, thinkingLevel, responseModalities, useGrounding,
 *                                 model, isVariation, refs: [{ mimeType, base64 }] }
 *                               → { provider, base64, mimeType, accompanyText, grounding }
 * 拒绝走 sendError（Anthropic 错误形状 + code），客户端把 message 原样给 agent。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tierDenialForOwner } from '../../engine/mcp/tools/tier-gate.js';
import { runWebSearch, ProviderError, PROVIDERS } from '../../engine/mcp/tools/web-search-providers.js';
import { produceImage, localImageRoute } from '../../engine/mcp/tools/image-produce.js';
import { MODELS, DEFAULT_MODEL } from '../../engine/mcp/tools/generate-image.js';
import { checkQuota, imageChargeUsd } from '../../lib/quota.js';
import { DENIAL, can } from '../../auth/tier.js';
import { capabilityState } from '../../runtime/capabilities.js';
import { recordRelayUsage } from './usage.js';

const REF_MAX = 8;
/** 心跳间隔；测试用 env 调短 */
const heartbeatMs = () => Number(process.env.NODESIGN_RELAY_HEARTBEAT_MS) || 15_000;
const REF_BYTES_MAX = 12 * 1024 * 1024;
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

/** /whoami 里报给客户端的"网关替你跑的工具"：站点这边有能力 且 这个账号的档位开放 */
export function relayToolsFor(user) {
  const has = (id) => { const c = capabilityState(id); return !c || !!c.available; };
  return {
    web_search: has('webSearch') && can(user, 'webSearch'),
    generate_image: has('imageGen') && can(user, 'imageGen'),
  };
}

/** 拒绝结果（tier-gate 的 { content:[{text}], isError }）→ 只要那句话 */
const denialText = (d) => d?.content?.[0]?.text || '不允许';

export function mountRelayTools(router, { sendError, readRawBody, produce = produceImage, search = runWebSearch, imageRouteOf = localImageRoute }) {
  const readJson = async (req, max) => {
    try { return JSON.parse((await readRawBody(req, max)).toString('utf8') || '{}'); }
    catch (err) { throw Object.assign(new Error(err.status === 413 ? '请求体太大' : '请求体不是 JSON'), { status: err.status === 413 ? 413 : 400, code: err.status === 413 ? 'BODY_TOO_LARGE' : 'BAD_JSON' }); }
  };

  router.post('/tools/web_search', async (req, res) => {
    let body;
    try { body = await readJson(req, 64 * 1024); } catch (err) { return sendError(res, err.status, err.code, err.message); }
    const user = req.relayUser;
    const denied = tierDenialForOwner(user, 'webSearch', 'web_search');
    if (denied) return sendError(res, 403, 'TIER_DENIED', denialText(denied));
    const { query, provider = 'auto', count = 5, includeImages = false } = body || {};
    if (typeof query !== 'string' || query.trim().length < 2) return sendError(res, 400, 'BAD_QUERY', 'query 至少两个字');
    if (provider !== 'auto' && !PROVIDERS[provider]) return sendError(res, 400, 'BAD_PROVIDER', `provider 只能是 ${Object.keys(PROVIDERS).join(' / ')} / auto`);
    try {
      const r = await search({ query, provider, count: Math.max(1, Math.min(10, Number(count) || 5)), includeImages: !!includeImages });
      if (r.error) return sendError(res, 503, 'SEARCH_UNAVAILABLE', r.error);
      res.json(r);
    } catch (err) {
      const msg = err instanceof ProviderError
        ? err.message + (err.code === 401 || err.code === 403 ? '（站点这边的搜索钥匙失效，请告诉站主）' : err.code === 429 ? '（搜索额度用完，换一家或稍后再试）' : '')
        : `web_search error: ${err?.message || String(err)}`;
      sendError(res, 502, 'SEARCH_FAILED', msg);
    }
  });

  router.post('/tools/generate_image', async (req, res) => {
    let body;
    try { body = await readJson(req, 64 * 1024 * 1024); } catch (err) { return sendError(res, err.status, err.code, err.message); }
    const user = req.relayUser;
    const denied = tierDenialForOwner(user, 'imageGen', 'generate_image');
    if (denied) return sendError(res, 403, 'TIER_DENIED', denialText(denied));
    const q = checkQuota(user);
    if (!q.ok) return sendError(res, 429, 'QUOTA_EXCEEDED', `generate_image denied: ${DENIAL.imageQuota}`, { quota: { kind: q.kind, used: q.used, limit: q.limit } });
    const route = imageRouteOf();
    if (!route) return sendError(res, 503, 'IMAGE_UNAVAILABLE', '站点这边现在没有生图通道，请告诉站主。');
    const {
      prompt, aspectRatio = '16:9', imageSize = '1K', thinkingLevel = 'minimal', responseModalities = ['IMAGE'],
      useGrounding = false, model = DEFAULT_MODEL, isVariation = false, refs = [],
    } = body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) return sendError(res, 400, 'BAD_PROMPT', 'prompt 不能为空');
    const modelId = MODELS[model];
    if (!modelId) return sendError(res, 400, 'BAD_MODEL', `unknown model '${model}'. Use 'flash' or 'pro'.`);
    if (!Array.isArray(refs) || refs.length > REF_MAX) return sendError(res, 400, 'BAD_REFS', `refs 最多 ${REF_MAX} 张`);

    // 参考图落成临时文件（produceImage 两条分支都按路径读；codex 还要 -i 附件）
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-img-'));
    let out = null;
    // ⚠️ 出图要一两分钟，Cloudflare 免费版 100 秒没字节就 524。参数都验过之后先把 200 头发出去，每 15 秒一个空格
    // （JSON.parse 认前导空白），结果最后整段发；这之后的失败也只能是 200 + 错误形状，客户端按 type:'error' 认。
    let heartbeat = null;
    const startStreaming = () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      heartbeat = setInterval(() => { try { res.write(' '); } catch { /* 客户端走了 */ } }, heartbeatMs());
      heartbeat.unref?.();
    };
    const finish = (obj) => { clearInterval(heartbeat); res.end(JSON.stringify(obj)); };
    const failStreaming = (status, code, message) => finish({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message }, code });
    try {
      const files = [];
      for (let i = 0; i < refs.length; i++) {
        const r = refs[i] || {};
        const ext = EXT[String(r.mimeType || '').toLowerCase()];
        if (!ext) return sendError(res, 400, 'BAD_REFS', `refs[${i}] 的 mimeType 不支持：${r.mimeType}`);
        const buf = Buffer.from(String(r.base64 || ''), 'base64');
        if (!buf.length || buf.length > REF_BYTES_MAX) return sendError(res, 400, 'BAD_REFS', `refs[${i}] 为空或超过 ${REF_BYTES_MAX / 1048576}MB`);
        const abs = path.join(tmp, `ref-${i}${ext}`);
        await fs.writeFile(abs, buf);
        files.push({ abs, mimeType: r.mimeType });
      }
      let produced;
      startStreaming();
      try {
        produced = await produce({
          route, prompt, aspectRatio, imageSize, thinkingLevel, responseModalities, useGrounding: !!useGrounding, modelId,
          refs: files, isVariation: !!isVariation, codexOutAbs: path.join(tmp, 'out.png'), signal: AbortSignal.timeout(4 * 60_000),
        });
      } catch (err) {
        return failStreaming(502, 'IMAGE_FAILED', `generate_image ${err.stage === 'extract' ? 'failed' : `${err.stage || route} error`}: ${err.message}`);
      }
      // 出了图才记账（跟网页端 chargeForImage 同一条纪律）
      const cost = recordRelayUsage({ userId: user.id, deviceId: req.relayDevice?.id || null, model: 'generate_image', costUsd: imageChargeUsd() });
      const candidate = produced.response?.candidates?.[0] || {};
      out = {
        provider: route, base64: produced.imgBuf.toString('base64'), mimeType: produced.outMime,
        accompanyText: produced.accompanyText || null,
        grounding: candidate.groundingMetadata || candidate.grounding_metadata || null,
        costUsd: cost,
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});   // 临时目录先清干净再答（成功和失败都走这里）
    }
    if (out) finish(out);
  });
}
