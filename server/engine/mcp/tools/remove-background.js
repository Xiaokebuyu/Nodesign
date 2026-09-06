/**
 * mcp/tools/remove-background.js — remove_background MCP tool
 *
 * 调用名:
 *   mcp__nodesign__remove_background
 *
 * Schema:
 *   inputPath:    string                workspace 相对路径（assets/photo.jpg 等）
 *   outputName?:  string                不带后缀；default `<inputBaseName>-nobg`
 *   overwrite?:   boolean               同名 outputName 已存在时是否覆盖（default false → 加 -<ts> 后缀）
 *
 * Returns CallToolResult:
 *   { type: 'text', text: '...' },                                // caption + path
 *   { type: 'image', source: { type:'base64', media_type, data } } // 抠完的预览
 *
 * 工作流：
 *   - 解析路径（防 traversal，候选 workspaceRoot / sharedRoot）→ 拿绝对路径
 *   - Read 源图字节
 *   - helpers/rembg.js spawn .venv-rembg python → rembg U²-Net 抠图
 *   - 落 assets/generated/<name>.png（RGBA 必须 PNG，强制 .png 扩展）
 *   - 返 caption + image content block 让 agent 立刻 vision 看到效果
 *
 * 跟 generate_image 的关系（2026-05-11 拆分）：
 *   原 generate_image 上的 removeBackground:true flag 已删，独立成本工具。
 *   理由：抠图作为 generate_image 的 flag 只能在生图当下用，但实际场景更广
 *   ——用户上传的产品照、之前生过的图、截图、任何 workspace 里的图都该能抠。
 *   独立工具复用 helpers/rembg.js 0 重复代码，agent 按需调。
 *
 * Fail-soft：rembg 不可用 / subprocess 失败时返 isError=true 让 agent 看到原因
 *   （依赖缺 / 超时 / 进程崩），决定 fallback（用原图 / 改 prompt 重生 / 先解决环境）。
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { patchBoard } from '../../../projects/board-store.js';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { removeBackground as rembgRemove, isAvailable as rembgIsAvailable, REMBG_SETUP_HINT } from './helpers/rembg.js';

const SUPPORTED_INPUT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);

// quality enum → 内部 (model, alphaMatting) 映射
//
// 2026-07-31 重排。起因是 balanced/best 长期被 env 顶到 fast，等于只有一档能用。
// service 侧给 alpha matting 加了分辨率上限（见 rembg-service.py 的
// _remove_with_am_cap）之后，"AM 太慢所以 fast 不能开 AM" 这条前提不成立了：
// AM 在 ≤1024 长边上解，代价从分钟级掉到 1-2 秒。
//
// 本机实测（1023×1537 = 1.57MP，warm session，单核 Neoverse-V2）：
//   isnet-general-use  无 AM   6.6s   峰值  892MB   ✓
//   isnet-general-use  + AM    8.4s   峰值  923MB   ✓  ← balanced 换成它
//   birefnet-lite      无 AM  18-21s  峰值 2435MB   ✗ OOM killed
// birefnet 那档撑爆内存的是模型推理本身，不是 AM（关掉 AM 照样死），ort 的
// arena 调优也没救回来。所以在加 swap 之前它就是不可用，best 仍会被 env 顶掉。
//
// 边缘质量差异（同一张图，alpha 通道统计）：
//   无 AM  半透明杂散像素 34.4%（halo 就是这些）
//   + AM   半透明杂散像素  9.9%，真过渡像素反而略增
// 观感上 AM 那档发丝更细更自然，但整体略"雾"（alpha 从 1024 插值回原尺寸）。
// 两种取向各有适用，所以是两档而不是一档取代另一档。
//
// best 从 birefnet-general(880MB) 降到 lite：880MB 那个从来没在这台机器上跑起来
// 过，连模型都没下载。换到更大的机器时把它加回来即可。
const QUALITY_MAP = {
  fast:     { model: 'isnet-general-use',     alphaMatting: false },
  balanced: { model: 'isnet-general-use',     alphaMatting: true  },
  best:     { model: 'birefnet-general-lite', alphaMatting: true  },
};

// style 轴（2026-08-02）：与 quality 正交。二次元/插画/生成立绘 → isnet-anime
// （动漫线稿专训，与 isnet-general-use 同量级 ~900MB 峰值，这台机器承载得起）。
// 只换 fast/balanced 的底模；best 是通用分割且被 QUALITY_CAP 禁着，不参与。
const ANIME_MODEL = 'isnet-anime';
function resolveModelCfg(quality, style) {
  const base = QUALITY_MAP[quality];
  if (style === 'anime' && base.model === 'isnet-general-use') {
    return { ...base, model: ANIME_MODEL };
  }
  return base;
}

// 质量上限（env NODESIGN_REMBG_QUALITY_CAP）。birefnet 系模型一次推理峰值 2.4GB+，
// 在小内存机器上会被 OOM killer 直接杀掉 —— 而且杀的是常驻 service 进程，连带
// fast 档一起死。
// 超上限**显式拒绝并说明原因**（agent 看得见、能改档重试），不做静默降档：
// 静默降档意味着 agent 以为拿到了 birefnet 的分割质量，实际是 isnet 的。
const QUALITY_ORDER = ['fast', 'balanced', 'best'];
function qualityCapError(quality) {
  const cap = process.env.NODESIGN_REMBG_QUALITY_CAP;
  if (!cap || !QUALITY_ORDER.includes(cap)) return null;
  if (QUALITY_ORDER.indexOf(quality) <= QUALITY_ORDER.indexOf(cap)) return null;
  return `quality "${quality}" 在这台机器上被禁用（上限 "${cap}"）：它用的 birefnet `
    + '模型一次推理峰值内存 2.4GB+，会触发 OOM kill 并连带杀掉常驻抠图服务。'
    + `请改用 quality: "${cap}" 重试 —— 边缘质量问题（halo / 毛边 / 发丝）"balanced" `
    + '已经能解决，"best" 只在主体形状本身被分割错时才有意义。'
    + '确实需要更强分割时告知用户：这台机器要先加 swap 或换更大内存的机器。';
}

/**
 * 解析 workspace 相对路径到绝对路径。防 traversal。
 * @returns {Promise<{ abs: string, baseName: string, ext: string }>}
 */
async function resolveInputPath(relPath, workspaceRoot, sharedRoot) {
  if (path.isAbsolute(relPath)) {
    throw new Error(`inputPath must be a workspace-relative path; got absolute: ${relPath}`);
  }
  const candidates = [workspaceRoot];
  if (sharedRoot) candidates.push(sharedRoot);

  let abs = null;
  for (const base of candidates) {
    const candidate = path.resolve(base, relPath);
    if (candidate === base || candidate.startsWith(base + path.sep)) {
      try {
        await fs.access(candidate);
        abs = candidate;
        break;
      } catch {
        // 文件不在这个 root 下，试下一个
      }
    }
  }
  if (!abs) {
    throw new Error(`inputPath not found in workspace or shared: ${relPath}`);
  }

  const ext = path.extname(abs).toLowerCase();
  if (!SUPPORTED_INPUT_EXT.has(ext)) {
    throw new Error(
      `inputPath must be one of ${[...SUPPORTED_INPUT_EXT].join('/')}; got: ${ext}`,
    );
  }
  const baseName = path.basename(abs, ext);
  return { abs, baseName, ext };
}

function safeBaseName(s) {
  return String(s || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * @param {object} deps
 * @param {string} deps.workspaceRoot
 * @param {string|null} [deps.sharedRoot]
 * @param {object} [deps.ctx]
 */
export function makeRemoveBackgroundTool({ workspaceRoot, sharedRoot = null, projectId = null, ctx } = {}) {

  return tool(
    'remove_background',
    `Remove the background from any image in the workspace, output a transparent RGBA PNG.

⚠️ FIRST DECISION IS "style", NOT "quality". Anime / illustration / character
art → pass style:"anime". Photos, product shots, screenshots → leave the default.
Getting this wrong does not soften an edge, it loses a whole limb: a pale-clothed
anime figure on a light background came back with both legs cut off under the
default model, and came back clean under style:"anime". The quality knob below is
a much smaller effect than this one — read this line first, then that section.

Use this when:
- A user-uploaded reference photo has a background that clashes with your canvas
- A previously-generated image (you didn't pass removeBackground at gen time, or it was generated by a different tool) needs to become an overlay
- A screenshot or any other workspace image needs the subject isolated

Implementation: long-running Python service (rembg / onnxruntime) accessed via
Unix socket; cold fallback per-call spawn when service down. isnet ML
segmentation + trimap alpha matting post-process (pymatting) for clean edges.

QUALITY OPTIONS (tradeoff: speed vs edge character):
- balanced: isnet-general-use + alpha matting (~8s warm). DEFAULT — cuts
            semi-transparent stray pixels (halo) from ~34% to ~10% and keeps
            finer wisps, at the cost of a slightly softer overall edge.
            Alpha matting runs capped at 1024px long edge then the alpha is
            scaled back, so cost does NOT grow with input megapixels.
- fast:     isnet-general-use, no alpha matting (~7s warm). Step DOWN to this
            for hard-edged subjects where you want a crisp decisive cut and
            softness would read as blur: product shots, icons, logos, UI
            screenshots, flat-color graphics. Also for large batches where
            the 1s/image difference adds up.
- best:     birefnet-general-lite + alpha matting. Strongest segmentation, but
            needs ~2.5GB RAM for inference — may be disabled by the machine cap
            (the tool tells you explicitly if so; it never silently downgrades).

Which to pick: stay on the default. Step down to fast for hard-edged / graphic
subjects. Only reach for best when balanced mis-segments the subject SHAPE
itself (a model problem, not an edge problem) — balanced already fixes edges.

LIMITATIONS:
- Heuristic ML segmentation — clean cuts when subject has clear visual boundaries
- **Subject and background close in lightness (pale subject on a white ground)
  can lose whole regions**, not just edge quality. The caption reports how much
  of the frame survived as foreground — a number far below what you expect means
  it cut away part of the subject; switch style / quality and run it again
- Subjects with thin transparent elements (glass / smoke / wispy hair / fine
  fabric / fur) may have soft or inaccurate edges even on "best" quality
- For pure-shape icons / logos, prefer SVG (lucide-react import) — true vector
  transparency, no ML guesswork

WHEN NOT TO USE:
- Decorative backgrounds / patterns / textures (these ARE backgrounds, don't remove)
- Full-page covers / hero images (the bg IS the design)
- Simple line icons (use lucide-react SVG instead)

Returns: text caption with output path + image content block (preview the result).`,
    {
      inputPath: z
        .string()
        .min(1)
        .describe('Workspace-relative path to the source image (e.g. "assets/generated/coffee.png", "用户内容/photo.jpg"). Supported formats: png/jpg/jpeg/webp/gif/bmp/tiff.'),
      outputName: z
        .string()
        .max(64)
        .optional()
        .describe('Output filename without extension. Default: "<inputBaseName>-nobg". Always written as .png (RGBA).'),
      overwrite: z
        .boolean()
        .optional()
        .describe('If output file already exists: false (default) → append "-<timestamp>" to avoid overwrite; true → replace existing.'),
      quality: z
        .enum(['fast', 'balanced', 'best'])
        .optional()
        .describe('Speed vs edge character. Default "balanced" (isnet + alpha matting, ~8s warm): cuts stray semi-transparent pixels (halo) ~34%→~10% and keeps finer wisps, slightly softer overall edge; alpha matting is capped at 1024px long edge so cost does NOT scale with input megapixels — never pre-resize for speed. Step DOWN to "fast" (isnet, no alpha matting, ~7s warm) for hard-edged subjects where softness reads as blur: product shots, icons, logos, UI screenshots, flat-color graphics — and for large batches. "best" (birefnet-general-lite + alpha matting): strongest segmentation but needs ~2.5GB RAM; may be disabled by the machine cap, in which case the tool says so explicitly rather than silently downgrading. Only reach for best when balanced mis-segments the subject SHAPE — balanced already fixes edges.'),
      style: z
        .enum(['general', 'anime'])
        .optional()
        .describe('Model family, orthogonal to quality. "anime" switches fast/balanced to isnet-anime — trained on anime/illustration linework. Use it for generated character art (立绘), stickers, and any 2D illustration; flat-color fills and clean line edges segment noticeably better than the photo-trained default. Keep "general" (default) for photos, product shots, screenshots. Same speed/memory class; "best" ignores style.'),
    },
    // 默认 balanced（2026-07-31）：AM 加了分辨率上限之后只比 fast 慢 1.7s、多占
    // 31MB，而 halo 从 34% 降到 10%。默认该给更好的那个，crisp 需求让 agent 显式
    // 降到 fast —— 反过来（默认 fast，需要好边缘时升档）依赖 agent 先看出有 halo，
    // 而它多数时候不会回头看抠完的图。
    async ({ inputPath, outputName, overwrite = false, quality = 'balanced', style = 'general' }) => {
      // 0a. 质量上限（小内存机器禁 birefnet，显式拒绝不静默降档）
      const capErr = qualityCapError(quality);
      if (capErr) {
        return { content: [{ type: 'text', text: `remove_background: ${capErr}` }], isError: true };
      }
      // 0. 检查 rembg 可用
      const avail = await rembgIsAvailable();
      if (!avail.available) {
        return {
          content: [{
            type: 'text',
            text: `remove_background failed: rembg unavailable (${avail.reason}). Setup once: ${REMBG_SETUP_HINT}`,
          }],
          isError: true,
        };
      }

      // 1. 解析 + 读源图
      let resolved;
      try {
        resolved = await resolveInputPath(inputPath, workspaceRoot, sharedRoot);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `remove_background failed: ${err.message}` }],
          isError: true,
        };
      }
      const inputBuf = await fs.readFile(resolved.abs);

      // 2. 决定输出名 + 文件名
      const baseName = outputName
        ? (safeBaseName(outputName) || `${resolved.baseName}-nobg`)
        : `${safeBaseName(resolved.baseName)}-nobg`;

      // 3. 落档目录（跟 generate_image 同：sharedRoot 优先，跨 session 共享）
      const useShared = !!sharedRoot;
      const outDir = path.join(
        useShared ? sharedRoot : workspaceRoot,
        'assets',
        'generated',
      );
      await fs.mkdir(outDir, { recursive: true });

      // 4. 处理 overwrite + 防同名覆盖
      let fileName = `${baseName}.png`;
      let absOut = path.join(outDir, fileName);
      if (!overwrite) {
        try {
          await fs.access(absOut);
          // 已存在 → 加 timestamp 后缀
          const ts = Date.now();
          fileName = `${baseName}-${ts}.png`;
          absOut = path.join(outDir, fileName);
        } catch {
          // 不存在，原名可用
        }
      }

      // 5. 抠图——按 quality 选 model + alphaMatting
      // service warm 走 Unix socket（本机实测 fast 6.6s / balanced 8.4s）；
      // fallback spawn cold 走 .venv-rembg per-call，每次多付 20-40s 模型 load。
      //
      // timeout 留的余量比实测大一个数量级，因为这台机器只有 1 核：同时有生图预热
      // 或导出截图在跑的时候，同一个调用能慢好几倍。宁可等也别误杀一次成功的抠图。
      // AM 加了 1024 分辨率上限之后不再随输入 MP 增长，所以 balanced 不用再留
      // 原来那种"1-2MP 容易 100s+"的巨量余量。
      const qualityCfg = resolveModelCfg(quality, style);
      const timeoutByQuality = {
        fast: 60_000,       // 1min（无 AM，cold load 也够）
        balanced: 120_000,  // 2min（warm 8.4s，留 14 倍余量给 CPU 争抢）
        best: 300_000,      // 5min（birefnet 推理本身就重，且可能触发模型下载）
      };
      const t0 = Date.now();
      const rgba = await rembgRemove(inputBuf, {
        model: qualityCfg.model,
        alphaMatting: qualityCfg.alphaMatting,
        timeoutMs: timeoutByQuality[quality],
      });
      const elapsed = Date.now() - t0;
      if (!rgba) {
        return {
          content: [{
            type: 'text',
            text: `remove_background failed: rembg subprocess returned null (timeout / spawn error / model load failure). Quality=${quality}, model=${qualityCfg.model}. See server logs.`,
          }],
          isError: true,
        };
      }

      // 6. 写盘
      await fs.writeFile(absOut, rgba);
      console.log(
        `[remove-background] ${inputPath} → ${fileName} (${rgba.length}B) in ${elapsed}ms `
        + `[quality=${quality} model=${qualityCfg.model} alphaMatting=${qualityCfg.alphaMatting}]`,
      );

      // 7. agent 看到的相对路径（相对 cwd = sessions/<sid>/）
      // 跟 generate_image 一致：sessions/<sid>/assets 是 softlink → shared/assets
      const agentRelPath = path.posix.join('assets', 'generated', fileName);

      // 7.5 自动谱系（2026-08-14 北极星路线4尾巴）：抠图产物机器可证地
      // 「改自」原图 —— 事件驱动一次性落线（用户删了不会再长出来，跟 ref
      // 对账层的治理规则刻意不同）。fail-soft：关系落不上不挡抠图。
      if (projectId) {
        try {
          const toRel = String(inputPath)
            .replace(/^(\.\/)+/, '')
            .replace(/^(\.\.\/)+shared\//, '');
          const bid = `b:auto:df:${crypto.createHash('sha1').update(`${agentRelPath}|${toRel}`).digest('hex').slice(0, 12)}`;
          await patchBoard(projectId, {
            bindings: { [bid]: { type: 'derives-from', from: agentRelPath, to: toRel, by: 'auto' } },
          });
        } catch { /* 谱系是锦上添花 */ }
      }

      // 前景占比（2026-08-18）。以前返回值里没有任何东西能让 agent 在不看图的
      // 情况下判断这次抠废了 —— 一个 agent 连着十九张图全靠肉眼才发现整条腿被
      // 当成背景切掉了，而它两次报障的共同核心诉求就是这一个数字：
      // 「如果 caption 里有『前景占 18%』，我第一时间就知道腿丢了」。
      let fgNote = '';
      try {
        const { default: sharp } = await import('sharp');
        const { data, info } = await sharp(rgba).ensureAlpha()
          .raw().toBuffer({ resolveWithObject: true });
        let solid = 0;
        const total = info.width * info.height;
        for (let i = 3; i < data.length; i += info.channels) if (data[i] > 128) solid++;
        fgNote = ` foreground=${((solid / total) * 100).toFixed(0)}% of frame`;
      } catch { /* 量不出来就不报，别因为一个诊断数字挡住抠图 */ }

      // 落盘了就发 file_changed：入座器靠它排座，前端素材抽屉靠它刷新（09-07 B1：此前是生图族里唯一不发的）
      try { ctx?.emit?.({ type: 'run.file_changed', filePath: agentRelPath, event: 'add' }); } catch { /* */ }

      // 8. 返 caption + image content block 让 agent 直接 vision 看
      const caption = [
        `Removed background from ${inputPath}`,
        `→ ${agentRelPath}`,
        `(RGBA PNG, ${(rgba.length / 1024).toFixed(1)} KB, ${elapsed}ms,`
        + ` style=${style || 'general'} quality=${quality} model=${qualityCfg.model}${fgNote})`,
      ].join(' ');

      // MCP image content block 格式：顶层 data + mimeType（不是 Anthropic API 的
      // { source: { type:'base64', media_type, data } } 形式）。SDK validator 用
      // MCP schema 校验，错误格式会让 tool call result 整个被拒。
      return {
        content: [
          { type: 'text', text: caption },
          {
            type: 'image',
            data: rgba.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      };
    },
  );
}
