/**
 * mcp/tools/image-produce.js —— generate_image 的"出一张图"：codex 桥 / gateway（Gemini 透传）两条供应商分支。
 *
 * 09-07 从 generate-image.js 拆出来，因为这一段要被**两处**调用：
 *   - 工具本体（本机有 codex 或 gateway key 时直接出图）
 *   - hosted relay 的 POST /api/relay/tools/generate_image（桌面版两样都没有，网关替它出图，按账号记 $0.20/张）
 * 工具本体只剩"选路（本机 / relay）→ 落盘 → 缩略图 → 事件 → 上墙"，那些都是本机的事。
 *
 * codex 桥的 prompt 组装 + 子进程执行在 helpers/codex-imagegen.js（2026-08-24 迁出）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCodexBridgePrompt, runCodexImageGen } from './helpers/codex-imagegen.js';
import { whichBinary } from '../../../runtime/which.js';

const DEFAULT_NODESK_URL = 'https://llm-gateway-api.nodesk.tech';
const DEFAULT_DMXAPI_BASE = 'https://www.dmxapi.cn';
const DEFAULT_CHANNEL = 'DMX';


const PASSTHROUGH_PATH = '/default/passthrough';
// model id 在 callGateway 时动态拼，因为支持 flash / pro 路由
const generateContentPathFor = (modelId) => `/v1beta/models/${modelId}:generateContent`;

/**
 * 调网关返回 Gemini 响应 body（已 parse）。
 *
 * @returns {Promise<object>} parsed JSON
 * @throws {Error} 401/HTTP 错误 / 网络错误
 */
async function callGateway(payload, { gatewayUrl, gatewayKey, channel, channelBase, modelId, signal }) {
  const passthroughUrl = gatewayUrl.replace(/\/$/, '') + PASSTHROUGH_PATH;
  const channelUrl = channelBase.replace(/\/$/, '') + generateContentPathFor(modelId);

  const wrapped = {
    channel,
    channel_url: channelUrl,
    ...payload,
  };

  const res = await fetch(passthroughUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(wrapped),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const snippet = text.slice(0, 400);
    const hint =
      res.status === 401 || res.status === 403
        ? ' (auth failed — check NODESIGN_GATEWAY_KEY)'
        : res.status === 429
          ? ' (rate limit / quota — try again later)'
          : '';
    throw new Error(`gateway HTTP ${res.status}${hint}: ${snippet}`);
  }
  return await res.json();
}

/**
 * 从 Gemini 响应里提第一张图（base64 PNG）。多张时只取第一。
 * 有些响应 model 会在 thought 阶段产中间图（thought:true）—— 跳掉那些，
 * 取 final（无 thought 标记的）image part。
 *
 * @returns {{ base64: string, mimeType: string, accompanyText: string }}
 * @throws {Error} 无 image part
 */
function extractFinalImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Gemini response has no parts');
  }
  let lastImage = null;
  let firstFinalImage = null;
  const accompanyTexts = [];
  for (const p of parts) {
    if (p.inlineData?.data) {
      lastImage = p.inlineData;
      if (!p.thought && !firstFinalImage) firstFinalImage = p.inlineData;
    } else if (p.inline_data?.data) {
      lastImage = p.inline_data;
      if (!p.thought && !firstFinalImage) firstFinalImage = p.inline_data;
    } else if (p.text && !p.thought) {
      accompanyTexts.push(p.text);
    }
  }
  const chosen = firstFinalImage || lastImage;
  if (!chosen) throw new Error('Gemini response has no image data');
  return {
    base64: chosen.data,
    mimeType: chosen.mimeType || chosen.mime_type || 'image/png',
    accompanyText: accompanyTexts.join('\n').trim(),
  };
}


/**
 * 本机能不能出图、走哪条：显式 NODESIGN_IMAGE_PROVIDER=gateway 看 key；否则看 codex CLI 在不在 PATH。
 * ⚠️ 以前默认 'codex' 不管它在不在（不在就等真调了才报错）；现在探不到就是 null，让能力位如实说"没有"。
 * @returns {'codex' | 'gateway' | null}
 */
export function localImageRoute() {
  const provider = (process.env.NODESIGN_IMAGE_PROVIDER || 'codex').toLowerCase();
  if (provider === 'gateway') return process.env.NODESIGN_GATEWAY_KEY ? 'gateway' : null;
  return whichBinary(process.env.NODESIGN_CODEX_BIN || 'codex') ? 'codex' : null;
}

function stageError(stage, message) {
  return Object.assign(new Error(message), { stage });
}

/**
 * 出一张图。
 * @param {object} o
 * @param {'codex'|'gateway'} o.route
 * @param {{ abs: string, mimeType: string }[]} o.refs   参考图（都在本机磁盘上；relay 那侧先落成临时文件再调）
 * @param {string} o.codexOutAbs   codex 分支要一个确定的落盘路径（codex 自己写文件）
 * @returns {Promise<{ imgBuf: Buffer, outMime: string, accompanyText: string|null, response: object|null }>}
 * @throws {Error & { stage: 'codex'|'gateway'|'extract' }}
 */
export async function produceImage({
  route, prompt, aspectRatio, imageSize, thinkingLevel, responseModalities, useGrounding, modelId, refs = [],
  isVariation = false, codexOutAbs, signal,
}) {
  if (route === 'codex') {
    if (refs.some((r) => r.mimeType === 'application/pdf')) {
      throw stageError('codex', 'codex provider 不支持 PDF reference（-i 只收图片）。先把 PDF 内容转述进 prompt，或截图后当图片 reference。');
    }
    const bridgePrompt = buildCodexBridgePrompt({ prompt, aspectRatio, absOut: codexOutAbs, refCount: refs.length, variation: isVariation });
    try {
      await runCodexImageGen({ bridgePrompt, refPaths: refs.map((r) => r.abs), cwd: path.dirname(codexOutAbs), signal, expectFile: codexOutAbs });
    } catch (err) {
      throw stageError('codex', err?.message || String(err));
    }
    return { imgBuf: await fs.readFile(codexOutAbs), outMime: 'image/png', accompanyText: null, response: null };
  }
  if (route !== 'gateway') throw stageError('gateway', `unknown image route ${route}`);
  const gatewayUrl = process.env.NODESIGN_GATEWAY_URL || DEFAULT_NODESK_URL;
  const gatewayKey = process.env.NODESIGN_GATEWAY_KEY;
  if (!gatewayKey) throw stageError('gateway', 'NODESIGN_IMAGE_PROVIDER=gateway 但 NODESIGN_GATEWAY_KEY 未设。');
  const channel = process.env.NODESIGN_GATEWAY_CHANNEL || DEFAULT_CHANNEL;
  const channelBase = process.env.NODESIGN_GATEWAY_CHANNEL_URL_BASE || DEFAULT_DMXAPI_BASE;
  const inlineImageParts = [];
  for (const r of refs) {
    const buf = await fs.readFile(r.abs);
    inlineImageParts.push({ inline_data: { mime_type: r.mimeType, data: buf.toString('base64') } });
  }
  // Gemini generateContent payload。Image Search Grounding 是 opt-in（人物 query 模型自动跳过，Google guardrail）
  const payload = {
    contents: [{ parts: [{ text: prompt }, ...inlineImageParts] }],
    generationConfig: {
      responseModalities,
      imageConfig: { aspectRatio, imageSize },
      thinkingConfig: { thinkingLevel: thinkingLevel === 'high' ? 'High' : 'Minimal', includeThoughts: false },
    },
    ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
  };
  let response;
  try {
    response = await callGateway(payload, { gatewayUrl, gatewayKey, channel, channelBase, modelId, signal });
  } catch (err) {
    throw stageError('gateway', err?.message || String(err));
  }
  let extracted;
  try {
    extracted = extractFinalImage(response);
  } catch (err) {
    throw stageError('extract', `${err.message}. Response keys: ${Object.keys(response || {}).join(', ')}. Try refining the prompt or check gateway logs.`);
  }
  return {
    imgBuf: Buffer.from(extracted.base64, 'base64'),
    outMime: extracted.mimeType || 'image/png',
    accompanyText: extracted.accompanyText || null,
    response,
  };
}

/** 扩展名跟 mimeType 走（Gemini 3.1 Flash Image 经常返 jpeg 而不是 png，硬写 .png 会让文件名和真实编码不一致） */
export function extForMime(mime) {
  switch ((mime || '').toLowerCase()) {
    case 'image/jpeg': case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.png';
  }
}


