/**
 * mcp/tools/generate-image.js — generate_image MCP tool
 *
 * 出图走 image-produce.js（09-07 拆出去）：本机有 codex 就 codex + gpt-image-2，
 * 桌面版没钥匙就交给站主 relay（relay-tools.js）。Gemini gateway 那条线（NoDesk
 * passthrough → DMXAPI）只剩 image-produce 里的 'gateway' 路由和这里五个静默忽略的
 * 参数；那套旧文件头 09-07 删了，要看去 git 历史。
 *
 * 落地：<workspaceRoot>/assets/generated/<name>.png + .webp 兄弟（页面引 webp）。
 * 返回 text caption + image content block（缩略图 base64，原图走 HTTP 按需拉）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { Events } from '../../agent/events.js';
import { z } from 'zod';
import sharp from 'sharp';
import {
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY, writeWebpSibling,   // 预热由 writeWebpSibling 顺带做
} from '../../../lib/image-variant.js';
import { buildVariationPrompt, PRESERVE_KEYS } from './helpers/codex-imagegen.js';
import { produceImage, extForMime } from './image-produce.js';
import { imageRoute, relayGenerateImage } from './relay-tools.js';

// Thumbnail 配置（env 可调）。**原图不动**——保留 Gemini 输出的全分辨率（通常
// 1080×1920+ PNG，6-8MB）让用户最终交付不损失质量。仅生成低清 thumbnail 给
// chat 缩略图 + WS 推送用，避免单条 message 8MB+ 让浏览器 parse 卡。
// 长边 512 + JPEG q80 → ~50KB，chat / WS 流畅。原图通过 HTTP /api/.../assets/...
// 按需加载（iframe 引用原图，用户点查看大图也加载原图）。
/**
 * 用 sharp 生成低清 thumbnail（不动原图）。
 * 长边 ≤ THUMBNAIL_MAX_DIM；统一 webp 输出。
 *
 * 2026-07-31 从 JPEG 换成 webp：同观感小三成，而且 webp 有 alpha，抠图产物
 * 不用再平铺白底 —— 原来那圈白底在预览里是真能看见的。
 * 规格常量从 lib/image-variant.js 来：资源路由给老图现补缩略图时用的是同一份，
 * 两边各写各的数字只会表现为某些图偶尔糊一点，查不出来。
 *
 * fail-soft：sharp 抛错返 null 让调用方降级。
 *
 * @param {Buffer} rawBuf
 * @returns {Promise<{ buf: Buffer, mimeType: string }|null>}
 */
async function makeThumbnail(rawBuf) {
  try {
    const meta = await sharp(rawBuf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    let pipeline = sharp(rawBuf);
    const longEdge = Math.max(w, h);
    if (longEdge > THUMBNAIL_MAX_DIM) {
      pipeline = pipeline.resize({
        width: w >= h ? THUMBNAIL_MAX_DIM : null,
        height: h > w ? THUMBNAIL_MAX_DIM : null,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const buf = await pipeline.webp({ quality: THUMBNAIL_QUALITY }).toBuffer();
    return { buf, mimeType: 'image/webp' };
  } catch (err) {
    console.warn(`[generate-image] thumbnail failed (${err.message}), chat will use raw or skip`);
    return null;
  }
}

// Model 路由：默认 flash (NB2)；anchor 类关键图（cover / character bible
// identity sheet / brand mockup hero）可升 pro 拿 commercial-grade 质量。
// Pro 比 Flash 慢 + 贵 ~2-3×，但质量提升对"会被复用为 referenceImages 种子"
// 的图值得——种子错了下游全漂、整个 deck 返工成本更高。
// spike 实测 NoDesk + DMXAPI 两个 model id 都通。
export const MODELS = {
  flash: 'gemini-3.1-flash-image-preview',
  pro: 'gemini-3-pro-image-preview',
};
export const DEFAULT_MODEL = 'flash';

// 14 种官方比例（Gemini 3.1 Flash Image Preview 文档）
const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4',
  '21:9', '4:1', '1:4', '8:1', '1:8', '3:4', '4:3',
];

const IMAGE_SIZES = ['512', '1K', '2K', '4K'];

const ASSET_ROLES = [
  'hero', 'cover', 'bg', 'frame', 'icon', 'decoration',
  'portrait', 'illustration', 'quote-backdrop', 'section-divider', 'pattern',
];

const RESPONSE_MODALITIES = ['IMAGE', 'TEXT'];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // PDF：NB2 支持文档输入（generateContent inline_data application/pdf）。
  // spike 实测 NoDesk + DMXAPI 透传通，且 NB2 真读 PDF 文本生成准确数据
  // 可视化（Q3 sales report PDF → 4 stat card 信息图，数字一一对上）。
  // 当前 codex 后端不吃 PDF；这一行是 gateway 时代的旧口径，留着等 Gemini 回来。
  '.pdf': 'application/pdf',
};


/**
 * 把 referenceImages 路径解析到 sharedRoot/workspaceRoot 之一。防止 traversal。
 *
 * @param {string} relPath
 * @param {string} workspaceRoot
 * @param {string|null} sharedRoot
 * @returns {Promise<{ abs: string, mimeType: string }>}
 * @throws {Error} 路径越界 / 文件不存在 / 不支持的 mime
 */
async function resolveReferenceImage(relPath, workspaceRoot, sharedRoot) {
  if (path.isAbsolute(relPath)) {
    throw new Error(
      `referenceImages must be relative paths inside the workspace; got absolute: ${relPath}`,
    );
  }

  const candidates = [workspaceRoot];
  if (sharedRoot) candidates.push(sharedRoot);

  let absResolved = null;
  let baseUsed = null;
  for (const base of candidates) {
    const candidate = path.resolve(base, relPath);
    // 防 traversal：resolved path 必须在 base 之内（含 base 本身）
    if (candidate === base || candidate.startsWith(base + path.sep)) {
      absResolved = candidate;
      baseUsed = base;
      break;
    }
  }
  if (!absResolved) {
    throw new Error(
      `referenceImages path escapes workspace/shared roots: ${relPath}`,
    );
  }

  // 真实存在 + 可读
  await fs.access(absResolved);

  const ext = path.extname(absResolved).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported reference format ${ext} (allowed: png/jpg/jpeg/webp/gif/pdf): ${relPath}`,
    );
  }
  return { abs: absResolved, mimeType, baseUsed };
}


function safeBaseName(s) {
  return String(s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildOutputName(outputName, assetRole) {
  if (outputName) {
    const safe = safeBaseName(outputName);
    if (safe) return safe;
  }
  const ts = Date.now();
  const role = safeBaseName(assetRole || 'image');
  return `gen-${ts}-${role}`;
}

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot       agent cwd（sessions/<sid>/ 模式或老 runId 模式）
 * @param {string|null} [deps.sharedRoot]   project shared/，存在时优先落档于此
 * @param {import('../../agent/context.js').AgentContext} [deps.ctx]
 */
export function makeGenerateImageTool({ workspaceRoot, sharedRoot = null, ctx } = {}) {
  return tool(
    'generate_image',
    `Generate a high-quality image.
Use this to add hero / cover / background / frame / icon / decoration / portrait
/ illustration / quote-backdrop / section-divider / pattern visuals to a deck,
a site page or a document.

BACKEND: codex-imagegen (subscription) -> gpt-image-2. What actually works is
prompt + aspectRatio + referenceImages (+ assetRole / outputName for naming).
imageSize / thinkingLevel / responseModalities / model / useGrounding are
Gemini-gateway-only and SILENTLY IGNORED — do not spend effort on them.
PDF referenceImages are NOT supported (images only). 'prompt' produces exactly
ONE image; there is no "3 variations in one prompt". For a SET, pass 'prompts'
(2-8): they are generated concurrently in one call (4 at a time) and each lands
on the canvas as it finishes — do not chain single calls one after another.
Expect ~45-60s per image — prefer one good anchor shot over many speculative variants.

BEFORE YOU CALL — is the subject a real, specific thing? A named IP / character
/ real person / product model / niche brand / recently released product: run
web_search { include_images: true } FIRST and pass 1-2 of the downloaded
local_path values in referenceImages. Without a reference the model draws its
guess of that thing. A style you are working in (a movement, a print tradition,
an era) is also worth one search to see real examples before writing the
prompt. Famous entities the model already knows and abstract / decorative
subjects need no search.

Saves the image to assets/generated/<name>.png at the WORKSPACE ROOT (plus a
.webp sibling to use in pages; the PNG is the master). A deck at the root
references it as assets/generated/<name>.webp. A site lives in its own folder,
so copy the webp into <site>/assets/ and reference assets/<name>.webp from the
page (or reference ../assets/generated/<name>.webp; the exporter rewrites it).
Returns the image as an inline content block so you can vision-check it
immediately.

PROMPT WRITING:
  - Picture the finished frame first, then describe what you see, in order.
    Positive description beats piling up negations.
  - Describe the scene narratively, don't list keywords.
  - If the user's prompt is already detailed, normalize it — do not expand it
    with creative additions they did not ask for.
  - For photorealism use camera language: 85mm lens, wide-angle, macro,
    golden-hour lighting, three-point softbox, etc.
  - For icons / stickers: explicitly say "white background" (transparent is
    not supported; use remove_background afterwards if you need alpha).
  - For text-in-image: quote the exact text and state the font style
    ("clean sans-serif", "bold serif headline").
  - Do NOT write size or ratio into the prompt body ("in 4K", "16:9
    widescreen") — that only makes the backend resize once for nothing.
    Ratio goes in aspectRatio.

ASPECT RATIO defaults by use:
  - cover/hero/landscape: 16:9 or 21:9
  - portrait/avatar:      4:5 or 2:3
  - icon/sticker/pattern: 1:1
  - vertical banner:      9:16
  HARD LIMIT: gpt-image-2 cannot exceed a 3:1 long-to-short ratio. 4:1, 1:4,
  8:1 and 1:8 are accepted by the schema but CANNOT be produced natively — for
  a thin banner, render 16:9 and crop it with CSS object-fit instead.

REFERENCES:
  Pass workspace-relative paths (e.g., 'assets/photo.jpg' or
  'assets/generated/prev.png'). Image formats: png/jpg/jpeg/webp/gif.
  HTTP urls are rejected. Pass the 1-2 most on-point images — feeding many
  dilutes the anchor. Label each image's role in the prompt text
  ("Image 1: edit target, Image 2: style reference").
  Use cases:
  - Style transfer: pass an image, describe the new style
  - Character consistency: pass 1-2 portraits across multi-page deck
  - Composition / mockup: pass logo + model image, describe how they combine
  - Inpainting: pass the canvas screenshot, describe what to change
  NOTE: the backend is stateless — it does not remember earlier images or this
  conversation. To iterate on a previous image, pass it back in referenceImages
  and restate the invariants every round.

VARIATION MODE (series consistency — outfit swaps, one-detail edits):
  Instead of hand-writing "change only X, keep Y" prompts, pass
  variationOf (path of the base image) + change (the ONE thing to alter)
  + optional preserve (which aspects must stay identical; default all).
  The tool expands these into a battle-tested skeleton incl. standard
  prohibitions (no invented straps/ornaments, absences preserved). Build
  series as a tree: one anchor, then vary one axis per call. In this mode
  prompt is optional (used as extra notes).

WHEN TO USE:
  - You're building a deck / landing / report and want real imagery
  - You need a backdrop that pure CSS gradient can't achieve
  - You want a sample image to align style with the user before batch-generating
  - You have user-uploaded reference and need to extend / restyle / combine

WHEN NOT TO USE:
  - Pure UI controls (buttons, form fields) — use Tailwind + shadcn instead
  - Data charts — use Recharts/ECharts/Mermaid via React mount
  - Simple inline icons (≤5 per page) — use lucide-react inline SVG

After a generation that settles style direction, record the settled anchor as a
memory (记忆/, type: project) so later sessions inherit it.`,
    {
      prompt: z
        .string()
        .min(4)
        .max(3500)
        .optional()
        .describe('Natural-language scene description. Describe, don\'t list keywords. Required unless variationOf is set (then it is appended as extra notes).'),
      prompts: z
        .array(z.string().min(4).max(3500))
        .min(2)
        .max(8)
        .optional()
        .describe('BATCH: 2-8 prompts generated concurrently in ONE call (same aspectRatio / referenceImages / assetRole for all; outputName gets -1..-N). Use it whenever you need a set (a series of illustrations, several candidates) instead of calling generate_image several times in a row. Not with variationOf.'),
      variationOf: z
        .string()
        .optional()
        .describe('VARIATION MODE: workspace-relative path of the base image to reproduce with ONE change. Becomes the first reference image (edit target).'),
      change: z
        .string()
        .min(4)
        .max(500)
        .optional()
        .describe('VARIATION MODE: the single thing to alter, e.g. "裙子换成薄荷绿短裙，长度到膝盖以上". Required with variationOf.'),
      preserve: z
        .array(z.enum(PRESERVE_KEYS))
        .optional()
        .describe('VARIATION MODE: aspects that must stay identical. Omit = all of them (safest).'),
      aspectRatio: z
        .enum(ASPECT_RATIOS)
        .optional()
        .describe('Output aspect ratio; default 16:9. See doc for use-case mapping.'),
      // ── 下面五个是 Gemini gateway（Nano Banana）时代的旋钮，当前 codex 后端静默忽略。
      //    参数留在 schema 里等网关回来；给模型看的描述只留一句"现在没用"，
      //    原来那套用法收在这段注释里（09-07 站主：死参数留着，机械用法先注释掉）：
      //    imageSize        分辨率档 512/1K/2K/4K；默认 1K，只有印刷级细节才上 4K
      //    thinkingLevel    Gemini 思考预算；minimal 低延迟，high 给复杂构图
      //    responseModalities 默认 ["IMAGE"]；加 "TEXT" 让模型顺带给一句评注
      //    model            flash（默认，gemini-3.1-flash-image-preview）/ pro（gemini-3-pro-image-preview，
      //                     慢且贵 2-3×，只给会当 referenceImages 种子的锚图：封面 hero / 角色设定图 / 品牌样机）
      //    useGrounding     Google 图搜 grounding，给真实地标/产品/品牌；多 60-90s；人物类会被 Google 自动跳过；
      //                     来源存 <name>.grounding.json sidecar
      imageSize: z
        .enum(IMAGE_SIZES)
        .optional()
        .describe('Gemini-gateway-only; ignored on the current backend.'),
      referenceImages: z
        .array(z.string().min(1))
        .max(14)
        .optional()
        .describe('Workspace-relative paths to reference images (png/jpg/jpeg/webp/gif). Pass the 1-2 most on-point ones and label each one\'s role in the prompt. Use for subject anchoring / style transfer / character consistency / iterating on a previous output.'),
      assetRole: z
        .enum(ASSET_ROLES)
        .optional()
        .describe('Semantic role; affects default output name + UI badge. One of hero/cover/bg/frame/icon/decoration/portrait/illustration/quote-backdrop/section-divider/pattern.'),
      outputName: z
        .string()
        .max(64)
        .optional()
        .describe('Output filename without extension. Auto-generated if omitted (gen-<timestamp>-<role>).'),
      thinkingLevel: z
        .enum(['minimal', 'high'])
        .optional()
        .describe('Gemini-gateway-only; ignored on the current backend.'),
      responseModalities: z
        .array(z.enum(RESPONSE_MODALITIES))
        .min(1)
        .max(2)
        .optional()
        .describe('Gemini-gateway-only; ignored on the current backend.'),
      model: z
        .enum(['flash', 'pro'])
        .optional()
        .describe('Gemini-gateway-only; ignored on the current backend.'),
      useGrounding: z
        .boolean()
        .optional()
        .describe('Gemini-gateway-only; ignored on the current backend.'),
    },
    async (args, extra) => fanOutImages(args, extra, generateOne),
  );

  /** 出一张图（原来的 handler 本体）。批量时被 fanOutImages 并发调用 N 次 */
  async function generateOne({
      prompt,
      variationOf,
      change,
      preserve,
      aspectRatio = '16:9',
      imageSize = '1K',
      referenceImages,
      assetRole,
      outputName,
      thinkingLevel = 'minimal',
      responseModalities = ['IMAGE'],
      model = DEFAULT_MODEL,
      useGrounding = false,
    }) {
      const modelId = MODELS[model];
      if (!modelId) {
        return {
          content: [{
            type: 'text',
            text: `generate_image failed: unknown model '${model}'. Use 'flash' or 'pro'.`,
          }],
          isError: true,
        };
      }
      // 变体模式归一化：variationOf 只是 referenceImages[0] 的语义化别名，
      // prompt 换成固定骨架 —— 下游（ref 解析 / -i 附件 / gateway inline）零改动。
      const isVariation = Boolean(variationOf);
      if (isVariation && !change) {
        return { content: [{ type: 'text', text: 'generate_image failed: variationOf requires `change` (the ONE thing to alter).' }], isError: true };
      }
      if (!isVariation && !prompt) {
        return { content: [{ type: 'text', text: 'generate_image failed: `prompt` is required (or use variationOf + change).' }], isError: true };
      }
      if (isVariation) {
        prompt = buildVariationPrompt({ change, preserve, extra: prompt });
        referenceImages = [variationOf, ...(referenceImages || [])];
      }
      // 1. 选路：本机 codex / gateway，都没有但登录了站点（桌面版）就让网关替它出图（按账号记 $0.20/张）
      const route = imageRoute();
      if (!route) {
        return { content: [{ type: 'text', text: 'generate_image failed: no image provider configured（codex CLI / NODESIGN_IMAGE_PROVIDER=gateway，或桌面版登录站点）.' }], isError: true };
      }

      // 输出命名 + 目录提前定：codex 分支需要先有确定的目标路径让 codex 落盘
      const finalName = buildOutputName(outputName, assetRole);
      const useShared = !!sharedRoot;
      const outDir = path.join(
        useShared ? sharedRoot : workspaceRoot,
        'assets',
        'generated',
      );
      await fs.mkdir(outDir, { recursive: true });

      // 2. 解析 referenceImages（fail-fast；codex 用 abs 路径走 -i 附件，gateway 读文件转 base64，relay 上传 base64）
      const resolvedRefs = [];
      if (referenceImages && referenceImages.length > 0) {
        for (const rel of referenceImages) {
          try {
            resolvedRefs.push(await resolveReferenceImage(rel, workspaceRoot, sharedRoot));
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `generate_image failed resolving referenceImages[${rel}]: ${err.message}`,
              }],
              isError: true,
            };
          }
        }
      }

      // 3. 出图（image-produce.js；relay 那边跑的是同一个 produceImage）
      let produced;
      let provider = route;   // 元数据 / 说明里报真正出图的那家；relay 回报它那边用的是 codex 还是 gateway
      if (route === 'relay') {
        const refs = [];
        for (const r of resolvedRefs) refs.push({ mimeType: r.mimeType, base64: (await fs.readFile(r.abs)).toString('base64') });
        const r = await relayGenerateImage({ prompt, aspectRatio, imageSize, thinkingLevel, responseModalities, useGrounding, model, isVariation, refs });
        if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
        provider = r.provider || 'relay';
        produced = {
          imgBuf: Buffer.from(r.base64 || '', 'base64'), outMime: r.mimeType || 'image/png', accompanyText: r.accompanyText || null,
          response: r.grounding ? { candidates: [{ groundingMetadata: r.grounding }] } : null,
        };
      } else {
        try {
          produced = await produceImage({
            route, prompt, aspectRatio, imageSize, thinkingLevel, responseModalities, useGrounding, modelId, refs: resolvedRefs,
            isVariation, codexOutAbs: path.join(outDir, `${finalName}.png`), signal: ctx?.abortController?.signal,
          });
        } catch (err) {
          return { content: [{ type: 'text', text: `generate_image ${err.stage === 'extract' ? 'failed' : `${err.stage || route} error`}: ${err.message}` }], isError: true };
        }
      }
      const { imgBuf, outMime, accompanyText, response } = produced;   // response：gateway 分支才有（grounding metadata 从这取）
      const fileName = `${finalName}${extForMime(outMime)}`;
      const absOut = path.join(outDir, fileName);
      // 原图不压缩——保留全分辨率给最终交付（导出 / iframe 引用）。codex 已自己落在这个路径上
      if (route !== 'codex') await fs.writeFile(absOut, imgBuf);

      // 额外生成 thumbnail（仅给 chat 缩略图 / WS 推送用，原图保留）
      // 落到 .thumbnails/ 子目录，agent 通常不引用（隐藏目录命名暗示），但能被
      // /api/.../assets/.thumbnails/foo.thumb.webp 路径访问（assets endpoint 不限子树）
      const thumbDir = path.join(outDir, '.thumbnails');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = `${finalName}.thumb.webp`;
      const absThumb = path.join(thumbDir, thumbName);
      const thumb = await makeThumbnail(imgBuf);
      if (thumb) {
        await fs.writeFile(absThumb, thumb.buf);
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B + thumb ${thumb.buf.length}B`);
      } else {
        console.log(`[generate-image] saved ${fileName} ${imgBuf.length}B (thumb skipped)`);
      }
      const thumbAgentRelPath = thumb ? path.posix.join('assets', 'generated', '.thumbnails', thumbName) : null;

      // 兄弟 webp（2026-08-18）：页面里引它，PNG 是母版留给用户下载和再编辑。
      // 实现在 image-variant.js（跟派生层同一个 q82），它**顺带预热派生档**。
      const webp = await writeWebpSibling(absOut, imgBuf, 'assets/generated');

      // 语义 sidecar（2026-07-27 工作台）：.meta/<name>.json 记录物件来历，
      // /api/.../artifacts 清单合并给产物墙显示（prompt / 角色 / 来源 run）。
      // fail-soft：写不进不影响生图主流程。
      try {
        const metaDir = path.join(outDir, '.meta');
        await fs.mkdir(metaDir, { recursive: true });
        await fs.writeFile(path.join(metaDir, `${finalName}.json`), JSON.stringify({
          prompt,
          assetRole: assetRole || null,
          aspectRatio,
          provider,
          model: provider === 'codex' ? 'codex' : model,
          referenceImageCount: resolvedRefs.length,
          variationOf: variationOf || null,   // 变体血缘：产物墙 / 引用层能顺出系列树
          sessionId: ctx?.sessionId || null,
          runId: ctx?.runId || null,
          ts: new Date().toISOString(),
        }, null, 2));
      } catch (err) {
        console.warn(`[generate-image] meta sidecar write failed: ${err.message}`);
      }

      // Path the agent sees relative to its cwd (sessions/<sid>/) — when
      // sharedRoot is in play, sessions/<sid>/assets is a softlink to
      // shared/assets, so relative path is the same either way.
      const agentRelPath = path.posix.join('assets', 'generated', fileName);

      // 6.5 提 grounding metadata（仅 useGrounding=true 且 model 真触发了搜索时存在）
      // 落 sidecar `<name>.grounding.json` 给前端 attribution UI / spec.json 审计用。
      // 模型对人物 query 自动跳过 grounding，那时这块为空——不落 sidecar，行为同普通生图。
      const candidate = response?.candidates?.[0] || {};
      const groundingMetadata = candidate.groundingMetadata || candidate.grounding_metadata;
      let groundingPath = null;
      let groundingSourceCount = 0;
      let groundingQueries = [];
      let groundingTopSources = [];
      if (groundingMetadata) {
        const sidecarName = `${finalName}.grounding.json`;
        const absSidecar = path.join(outDir, sidecarName);
        try {
          await fs.writeFile(absSidecar, JSON.stringify(groundingMetadata, null, 2));
          groundingPath = path.posix.join('assets', 'generated', sidecarName);
        } catch (err) {
          console.warn(`[generate-image] grounding sidecar write failed: ${err.message}`);
        }
        const chunks = groundingMetadata.groundingChunks || [];
        groundingSourceCount = chunks.length;
        groundingQueries = (groundingMetadata.webSearchQueries || []).slice(0, 5);
        groundingTopSources = chunks.slice(0, 5).map((c) => ({
          title: c.web?.title || null,
          uri: c.web?.uri || null,
        }));
      }

      // 7a. emit file_changed —— 让图**当场**上墙。
      //
      // MCP 工具写盘不走 PostToolUse(Write|Edit) 那条 file_changed 直发（matcher
      // 匹配不到 mcp__nodesign__* 工具名），所以生成的图在这一发之前对前端是不存在的：
      // 产物墙只在 listVersion / boardVersion 变化时才重拉 /artifacts，而这两个都要等
      // run.done 的兜底刷新。结果就是"图生完了，要等这一轮跑完才出现在任务文件夹里"。
      // record-decision.js 早补过同样一发。⚠️发相对路径不发 absOut：绝对路径会在前端孵出「home」影子文件夹（stage.js 拒收注释详述）
      try {
        ctx?.emit?.(Events.fileChanged(agentRelPath, 'add'));
      } catch { /* fail-safe */ }

      // 7b. emit run.image_generated（前端可显 thumbnail / 加 timeline 节点）
      try {
        ctx?.emit?.({
          type: 'run.image_generated',
          path: agentRelPath,             // 原图路径（agent 引用 + 前端"查看大图"链接）
          thumbnailPath: thumbAgentRelPath,  // null 时表示 thumbnail 生成失败
          absPath: absOut,
          sizeBytes: imgBuf.length,
          thumbnailSizeBytes: thumb?.buf.length || null,
          prompt,
          assetRole: assetRole || null,
          aspectRatio,
          imageSize,
          model: provider === 'codex' ? 'codex' : model,   // 前端 badge 显示 + spec.json 审计
          referenceImageCount: resolvedRefs.length,
          accompanyText,
          groundingUsed: groundingPath !== null,           // model 真触发了搜索
          groundingSourceCount,
          groundingPath,                                    // sidecar 相对路径，前端读 attribution HTML
        });
      } catch { /* fail-safe */ }

      // 8. 返回 CallToolResult — text caption + image content block
      const captionParts = [
        `Generated ${fileName}`,
        `at ${agentRelPath}`,
        `(${aspectRatio}, ${provider === 'codex' ? 'codex-imagegen' : provider}, ${(imgBuf.length / 1024).toFixed(1)} KB)`,
      ];
      if (webp) {
        captionParts.push(`— 页面里引 ${webp.rel}（${(webp.bytes / 1024).toFixed(0)} KB，`
          + `比 PNG 母版小 ${Math.max(1, Math.round(imgBuf.length / Math.max(webp.bytes, 1)))}×）；`
          + 'PNG 是母版，别往页面里引。');
      }
      if (assetRole) captionParts.push(`role=${assetRole}`);
      if (resolvedRefs.length > 0) {
        captionParts.push(`with ${resolvedRefs.length} reference image${resolvedRefs.length > 1 ? 's' : ''}`);
      }
      if (groundingPath) {
        captionParts.push(`grounded with ${groundingSourceCount} source${groundingSourceCount > 1 ? 's' : ''}`);
      } else if (useGrounding) {
        captionParts.push('(grounding requested but model didn\'t fire — likely person/character query)');
      }
      // 下一步写在返回文里：cookbook 只在首张注入一次，第 N 张时模型手里只有这段 caption
      captionParts.push(
        '\nNext: look at the inline image for technical defects only (duplicated figures, broken limbs, '
        + 'stray text or watermark, all-black / all-white, mush) and regenerate silently if you see one; '
        + 'taste and direction stay with the user. Then reference the file from the page and screenshot to check '
        + 'it in place. If this image will seed other pages via referenceImages, let the user confirm it first.',
      );
      const caption = captionParts.join(' ');

      const content = [{ type: 'text', text: caption }];
      if (accompanyText) {
        content.push({ type: 'text', text: `Model commentary: ${accompanyText}` });
      }
      if (groundingPath) {
        // 给 agent 看到本次 grounding 用的搜索 + top sources，方便它在回话里
        // 简短报给用户（"grounded with 5 sources from <queries>"）；完整 attribution
        // HTML 在 sidecar 里供前端 chip UI 读。
        const sourceLines = groundingTopSources
          .filter((s) => s.title || s.uri)
          .map((s, i) => `  [${i + 1}] ${s.title || ''} ${s.uri || ''}`.trim())
          .join('\n');
        content.push({
          type: 'text',
          text:
            `Image Search Grounding active.\n`
            + `Queries: ${groundingQueries.join(' | ') || '(none)'}\n`
            + `Top sources (${groundingSourceCount} total):\n${sourceLines || '  (none)'}\n`
            + `Full attribution metadata: ${groundingPath}`,
        });
      }
      // image content block 用 thumbnail base64（原图通过 HTTP 按需加载，不走 WS）：
      // 原图 base64 化后单条 WS message 8MB+ 让浏览器 parse 卡 / nginx upstream 也痛苦。
      // thumbnail ~50KB 推 chat 缩略图够清晰，用户看大图点开走 HTTP /api/.../assets/...
      // agent 仍能通过 caption 里的 agentRelPath 引用原图（`<img src="assets/generated/foo.png">`）。
      // thumbnail 失败时降级回原 base64（保险，agent 至少能看到图）。
      const imageBlockData = thumb ? thumb.buf.toString('base64') : imgBuf.toString('base64');
      const imageBlockMime = thumb ? thumb.mimeType : outMime;
      content.push({
        type: 'image',
        data: imageBlockData,
        mimeType: imageBlockMime,
      });
      return { content };
  }
}

/** 一次 generate_image 里并发出几张：上游是网络调用，4 张同时飞不比 1 张慢多少 */
export const IMAGE_CONCURRENCY = 4;

/**
 * 批量扇出（2026-09-12 站主：「agent 能够连续并发生图，而不是阻拦」）。
 * 一个 prompt 一张图的老路照旧；给 prompts[] 就在**一次调用里**并发出 N 张 —— 不依赖 CLI 对
 * 多个 tool_use 块的调度（MCP 写工具在 CLI 里是串行跑的），每张各自过档位/额度闸、各自
 * 当场上墙（file_changed），最后把 N 张的说明和缩略图合在一个返回里。一张失败不拖累其余。
 */
export async function fanOutImages(args, extra, one) {
  const prompts = Array.isArray(args?.prompts) ? args.prompts.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!prompts.length) return one(args, extra);
  if (args.variationOf) {
    return { content: [{ type: 'text', text: 'generate_image failed: `prompts` (batch) cannot be combined with variationOf — one variation per call.' }], isError: true };
  }
  const { prompts: _p, outputName, ...rest } = args;
  const results = new Array(prompts.length);
  let next = 0;
  const worker = async () => {
    while (next < prompts.length) {
      const i = next++;
      const one_args = { ...rest, prompt: prompts[i], ...(outputName ? { outputName: `${outputName}-${i + 1}` } : {}) };
      try { results[i] = await one(one_args, extra); } catch (err) {
        results[i] = { content: [{ type: 'text', text: `generate_image[${i + 1}] error: ${err.message}` }], isError: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, prompts.length) }, worker));
  const failed = results.filter((r) => r?.isError).length;
  const content = [{
    type: 'text',
    text: `Batch: ${prompts.length} prompts, generated ${IMAGE_CONCURRENCY} at a time; ${prompts.length - failed} succeeded`
      + `${failed ? `, ${failed} failed` : ''}. Each finished image is already on the canvas.`,
  }];
  results.forEach((r, i) => {
    content.push({ type: 'text', text: `— [${i + 1}/${prompts.length}] ${prompts[i].slice(0, 80)}` });
    content.push(...(r?.content || []));
  });
  return { content, ...(failed === prompts.length ? { isError: true } : {}) };
}
