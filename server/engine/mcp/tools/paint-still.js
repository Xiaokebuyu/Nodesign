/**
 * mcp/tools/paint-still.js — paint_still MCP tool（2026-08-08；批量制+FLUX.2 同晚补上）
 *
 * 站主本地 GPU 盒子生图。一次调用 = 一批（1-16 条，串行渲、出一张上墙一张）；
 * 每条还可以再开 batch（同提示词多变体，一次采样出 N 张，抽卡用，比串行快数倍）。
 *
 * 模型档（08-11 扩到五档）：
 *   noobai      NoobAI-XL V-Pred 1.0，danbooru/e621 标签，解剖与标签理解最强
 *   noobai-eps  NoobAI-XL 1.1 eps，只在 LoRA 仅有 eps 版时用（LoRA 跨预测目标会发灰）
 *   pony        Pony Diffusion V6 XL，score_9 六段串体系，clip skip 2 已在盒端配好
 *   anima       自然语言英文
 *   krea2       Krea 2 Turbo 12B 审美向，自然语言
 *
 * ⚠️ 许可：noobai/noobai-eps **禁止任何形式商业化，含生成物**（Laxhar Lab 在 FAIPL
 * 之上自加条款）；pony **禁止在任何货币化的站点/应用上跑推理**；anima 非商用。
 * 三者都只适合站主自用，不能做成对外服务。要商用走 Illustrious-XL（RAIL++-M
 * 明文允许 SaaS）或 krea2。08-11 前这里写着 noobai"商用可"，是错的。
 *
 * 配方 = 08-08/08-11 实测 + 官方模板。盒子不在线就明说，不静默降级。
 * 落盘/缩略图/事件照 generate-image.js；只回文本路径（图不进返回值），
 * 但 agent 可以自己去看那些文件挑废图（2026-08-18 解禁），审美判断仍归用户。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import sharp from 'sharp';
import { Events } from '../../agent/events.js';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { can, localGenApproved, DENIAL } from '../../../auth/tier.js';
import {
  THUMBNAIL_MAX_DIM, THUMBNAIL_QUALITY, enqueueWarm, warmSpecsFor,
} from '../../../lib/image-variant.js';
import { boxConfig, shq, runBox, sshArgs, scpArgs, localBoxEnabled, BOX_OFF_MSG } from './h3box-ssh.js';

const SSH_TIMEOUT_MS = Number(process.env.NODESIGN_H3BOX_TIMEOUT_MS) || 240_000;
// krea2 bf16 24G 全驻卡；换模型后的首张要付一次装载（~1 分钟），给足余量
const TIMEOUT_BY_MODEL = {
  noobai: SSH_TIMEOUT_MS, 'noobai-eps': SSH_TIMEOUT_MS, pony: SSH_TIMEOUT_MS,
  anima: SSH_TIMEOUT_MS, krea2: 400_000,
};
// batch 会线性拉长单次渲染，超时按张数放大（封顶 10 分钟，别让挂死的活撑满）
const timeoutFor = (still) => Math.min(
  (TIMEOUT_BY_MODEL[still.model] || SSH_TIMEOUT_MS) * Math.max(1, (still.batch || 1) * 0.6),
  600_000,
);

async function makeThumbnail(rawBuf) {
  try {
    const meta = await sharp(rawBuf).metadata();
    const w = meta.width || 0; const h = meta.height || 0;
    let pipeline = sharp(rawBuf);
    if (Math.max(w, h) > THUMBNAIL_MAX_DIM) {
      pipeline = pipeline.resize({
        width: w >= h ? THUMBNAIL_MAX_DIM : null,
        height: h > w ? THUMBNAIL_MAX_DIM : null,
        fit: 'inside', withoutEnlargement: true,
      });
    }
    const buf = await pipeline.webp({ quality: THUMBNAIL_QUALITY }).toBuffer();
    return { buf, mimeType: 'image/webp' };
  } catch (err) {
    console.warn(`[paint-still] thumbnail failed (${err.message})`);
    return null;
  }
}

/**
 * 把工作区里的参考图推到盒子，返回盒子上的绝对路径。
 * 失败返回 {err}，调用方据此中止这条 still —— 参考图丢了还照跑等于白烧。
 */
/**
 * 参考图推盒前先缩：上行实测只有 ~0.2MB/s（08-11），2MB 原图光上传就 10 秒。
 * IP-Adapter 的 CLIP 端最终只吃 224px，ref 缩到 512 零损失；init/control 参与
 * 生成分辨率，封顶 1344（SDXL 原生上限）。统一出 PNG 保透明；缩完反而更大
 * （罕见，如高压缩 JPEG 转 PNG）就推原图。缩图失败也推原图，别因优化挂正事。
 */
async function shrinkForPush(abs, slot) {
  const maxDim = slot.startsWith('ref') ? 512 : 1344;
  try {
    const meta = await sharp(abs).metadata();
    if (!meta.width || !meta.height || Math.max(meta.width, meta.height) <= maxDim) return null;
    const buf = await sharp(abs)
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
    if (buf.length >= (await fs.stat(abs)).size) return null;
    return buf;
  } catch { return null; }
}

async function pushRef({ box, root, relPath, jobId, slot, signal }) {
  const abs = path.resolve(root, relPath);
  // 越狱防护：参考图必须在工作区内
  if (!abs.startsWith(path.resolve(root))) return { err: `${slot} 路径越出工作区：${relPath}` };
  try { await fs.access(abs); } catch { return { err: `${slot} 找不到文件：${relPath}` }; }
  const shrunk = await shrinkForPush(abs, slot);
  const remote = `~/refs/${jobId}-${slot}${shrunk ? '.png' : (path.extname(abs) || '.png')}`;
  const mk = await runBox(box, 'ssh', [...sshArgs(box), 'mkdir -p ~/refs'], { timeoutMs: 30_000, signal });
  if (mk.code !== 0) return { err: `服务器建 refs 目录失败：${(mk.err || '').slice(-200)}` };
  let src = abs; let tmp = null;
  if (shrunk) {
    tmp = path.join(os.tmpdir(), `h3ref-${jobId}-${slot}.png`);
    await fs.writeFile(tmp, shrunk);
    src = tmp;
  }
  const put = await runBox(box, 'scp',
    [...scpArgs(box), src, `${box.target}:${remote}`], { timeoutMs: 120_000, signal });
  if (tmp) fs.unlink(tmp).catch(() => { /* */ });
  if (put.code !== 0) return { err: `${slot} 上传失败：${(put.err || '').slice(-200)}` };
  return { remote };
}

/** 单张落盘 + 缩略图 + sidecar + 上墙事件；返回 caption 行 */
async function landStill({ imgBuf, still, seed, outDir, ctx, sessionId, wallS, idx = 0, total = 1 }) {
  // batch>1 时同一条 still 出 N 张，文件名加序号；单张时不加，保持老路径形态
  const finalName = `still-${still.jobId}-${still.name}${total > 1 ? `-${idx + 1}` : ''}`;
  const fileName = `${finalName}.png`;
  const absOut = path.join(outDir, fileName);
  await fs.writeFile(absOut, imgBuf);

  const thumbDir = path.join(outDir, '.thumbnails');
  await fs.mkdir(thumbDir, { recursive: true });
  const thumb = await makeThumbnail(imgBuf);
  let thumbAgentRelPath = null;
  if (thumb) {
    await fs.writeFile(path.join(thumbDir, `${finalName}.thumb.webp`), thumb.buf);
    thumbAgentRelPath = path.posix.join('assets', 'generated', '.thumbnails', `${finalName}.thumb.webp`);
  }
  fs.stat(absOut)
    .then((st) => enqueueWarm(absOut, st, warmSpecsFor()))
    .catch(() => { /* 预热失败下次请求现编 */ });

  try {
    const metaDir = path.join(outDir, '.meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, `${finalName}.json`), JSON.stringify({
      prompt: still.prompt, negative: still.negative || null, provider: 'h3box',
      model: still.model, seed, size: still.size,
      sessionId: ctx?.sessionId || sessionId || null,
      runId: ctx?.runId || null,
      ts: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.warn(`[paint-still] meta sidecar failed: ${e.message}`); }

  // 发**工作区相对路径**（fileChanged 的正字法，hooks 同款）——发绝对路径的话
  // 前端寻址/版本记账全部静默失配（2026-08-14 普查改）
  try { ctx?.emit?.(Events.fileChanged(path.posix.join('assets', 'generated', finalName), 'add')); } catch { /* fail-safe */ }
  try {
    ctx?.emit?.({
      type: 'run.image_generated',
      path: path.posix.join('assets', 'generated', fileName),
      thumbnailPath: thumbAgentRelPath,
      absPath: absOut,
      sizeBytes: imgBuf.length,
      thumbnailSizeBytes: thumb?.buf.length || null,
      prompt: still.prompt, assetRole: null, aspectRatio: null, imageSize: still.size,
      model: `h3box-${still.model}`,
      referenceImageCount: (still.ref_image ? String(still.ref_image).split(',').filter((s) => s.trim()).length : 0)
        + (still.init_image ? 1 : 0) + (still.control_image ? 1 : 0),
      accompanyText: null,
    });
  } catch { /* fail-safe */ }

  const tag = total > 1 ? `${still.name} #${idx + 1}/${total}` : still.name;
  return `[${tag}] assets/generated/${fileName} — ${still.model} ${still.size} seed=${seed}${total > 1 ? `+${idx}` : ''} ${(imgBuf.length / 1024).toFixed(0)}KB ${wallS}s`;
}

/** 核心流程（从 handler 拆出，便于不起 SDK 直接实弹测试） */
export async function paintStills(
  { workspaceRoot, sharedRoot, projectId, sessionId, ctx },
  { stills },
) {
  const asText = (text, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  try {
    if (!localBoxEnabled()) {
      return asText(BOX_OFF_MSG, true);
    }
    const box = boxConfig();
    if (!box) {
      return asText('本地生图服务器未配置（未启动或未设置 NODESIGN_H3BOX_SSH）。转告用户，改用 generate_image。', true);
    }
    const project = getProject(projectId);
    if (!project) return asText('错误：项目不存在', true);
    const owner = project.ownerId ? getUserById(project.ownerId) : null;
    // 档位闸 + 逐人批准（auth/tier.js）：basic 档不开任何生图；pro 档还要被站主批过本地产线
    if (!can(owner, 'localGen')) return asText(DENIAL.localGenTier, true);
    if (!localGenApproved(owner)) return asText(`${DENIAL.localGenApproval} 改用 generate_image。`, true);

    const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
    await fs.mkdir(outDir, { recursive: true });
    const signal = ctx?.abortController?.signal;
    const batch = Date.now().toString(36);
    const lines = []; const failed = [];

    for (let i = 0; i < stills.length; i++) {
      const still = stills[i];
      still.jobId = `${batch}p${i}`;
      const seed = still.seed ?? ((Date.now() + i * 7919) % 1_000_000);
      const nBatch = Math.max(1, Math.min(8, still.batch || 1));

      // 参考图先推上盒子（h3box.py 的 LoadImage 只认盒子本地路径）
      const refRoot = sharedRoot || workspaceRoot;
      const refArgs = []; let refErr = null;
      for (const [slot, rel] of [
        ['init', still.init_image], ['control', still.control_image],
      ]) {
        if (!rel) continue;
        const r = await pushRef({ box, root: refRoot, relPath: rel, jobId: still.jobId, slot, signal });
        if (r.err) { refErr = r.err; break; }
        if (slot === 'init') {
          refArgs.push(`--init ${shq(r.remote)}`);
          if (still.denoise != null) refArgs.push(`--denoise ${still.denoise}`);
        } else {
          refArgs.push(`--control ${shq(r.remote)}`,
            `--control-type ${shq(still.control_type || 'openpose')}`,
            `--control-strength ${still.control_strength ?? 0.7}`);
        }
      }
      // ref_image 可以是多张（逗号分隔，最多 5 张）—— 同一角色的不同视角一起喂，
      // 一致性明显强于单张。每张各自推上盒子，再按同样顺序拼回去。
      if (!refErr && still.ref_image) {
        const rels = String(still.ref_image).split(',').map((s) => s.trim()).filter(Boolean);
        if (rels.length > 5) {
          refErr = `ref_image 最多 5 张，给了 ${rels.length}`;
        } else {
          const remotes = [];
          for (let k = 0; k < rels.length; k++) {
            const r = await pushRef({
              box, root: refRoot, relPath: rels[k], jobId: still.jobId, slot: `ref${k}`, signal,
            });
            if (r.err) { refErr = r.err; break; }
            remotes.push(r.remote);
          }
          if (!refErr) {
            refArgs.push(`--ref ${shq(remotes.join(','))}`,
              `--ref-weight ${shq(String(still.ref_weight ?? '0.8'))}`);
            if (still.ref_mode) refArgs.push(`--ref-mode ${shq(still.ref_mode)}`);
            if (still.ref_combine) refArgs.push(`--ref-combine ${shq(still.ref_combine)}`);
            if (still.ref_preset) refArgs.push(`--ref-preset ${shq(still.ref_preset)}`);
          }
        }
      }
      if (refErr) { failed.push(`[${still.name}] ${refErr}`); break; }

      const remoteCmd = [
        'python3 ~/h3box.py image',
        `-p ${shq(still.prompt)}`,
        `--model ${still.model}`,
        `--seed ${seed}`,
        `--size ${still.size}`,
        `--name ${still.jobId}`,
        nBatch > 1 ? `--batch ${nBatch}` : '',
        still.negative ? `--neg ${shq(still.negative)}` : '',
        still.lora ? `--lora ${shq(still.lora)} --lora-strength ${shq(String(still.lora_strength ?? '0.8'))}` : '',
        ...refArgs,
      ].filter(Boolean).join(' ');

      const t0 = Date.now();
      const gen = await runBox(box, 'ssh', [...sshArgs(box), remoteCmd],
        { timeoutMs: timeoutFor({ ...still, batch: nBatch }), signal });
      let failMsg = null; const bufs = [];
      if (gen.code !== 0) {
        failMsg = gen.code === 255 ? `无法连接渲染服务器（未启动或地址失效）：${(gen.err || '').slice(-300)}`
          : `生成失败 exit ${gen.code}：${(gen.err || gen.out).slice(-500)}`;
      } else {
        const remotePaths = gen.out.split('\n').map((l) => l.trim())
          .filter((l) => l.includes('/outputs/') && /\.(png|webp|jpg)$/.test(l));
        if (!remotePaths.length) failMsg = `服务器已执行完毕但未返回文件路径：${gen.out.slice(-400)}`;
        // batch 的 N 张全取回来，别只拿第一张（08-11 前就是丢了后面全部）。
        // 多源拼进一次 scp —— 逐张各开连接的老写法，握手开销能跟生成时间打平（08-11 实测）
        if (!failMsg && remotePaths.length) {
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `h3pull-${still.jobId}-`));
          const pull = await runBox(box, 'scp',
            [...scpArgs(box), ...remotePaths.map((r) => `${box.target}:${r}`), tmpDir],
            { timeoutMs: 60_000 + 20_000 * remotePaths.length });
          if (pull.code !== 0) failMsg = `取图失败：${(pull.err || '').slice(-300)}`;
          else {
            try {
              for (const r of remotePaths) bufs.push(await fs.readFile(path.join(tmpDir, path.basename(r))));
            } catch (e) { failMsg = `取图落盘缺文件：${e.message}`; }
          }
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* */ });
        }
      }
      const wallS = Math.round((Date.now() - t0) / 1000);
      for (let k = 0; k < bufs.length; k++) {
        lines.push(await landStill({
          imgBuf: bufs[k], still, seed: seed + k, outDir, ctx, sessionId, wallS,
          idx: k, total: bufs.length,
        }));
      }
      if (!bufs.length) {
        failed.push(`[${still.name}] ${failMsg}`);
        break;   // 串行批中途失败即停：后张大概率同因，别空烧
      }
      if (failMsg) failed.push(`[${still.name}] 部分失败：${failMsg}`);
      if (signal?.aborted) break;
    }

    // ── 标签体检（2026-08-18）──
    // danbooru 系模型的标签写错不报错、只静默失效，一个 agent 因此白烧过至少
    // 五轮出图。fail-open：查不到就什么都不说。位置有讲究 —— 放在"看图挑废图"
    // 那句**之前**，因为它说的是"这批图可能根本不该按它判断方向"。
    let tagNote = null;
    try {
      const danbooruStills = stills.filter(s => ['noobai', 'noobai-eps', 'pony'].includes(s.model ?? 'noobai'));
      if (danbooruStills.length) {
        const { lintTags, formatTagLint } = await import('../../../lib/danbooru-tags.js');
        tagNote = formatTagLint(await lintTags(
          danbooruStills.flatMap(s => [s.prompt, s.negative].filter(Boolean)),
        ));
      }
    } catch { /* 体检本身不能变成新的故障源 */ }

    const head = `Batch done ${lines.length}/${stills.length} stills`;
    // （"产物可以看、只挑技术性废图"08-21 起只写在工具描述和 prelude 里，不再每批返回都带）
    if (failed.length) {
      return asText([head, ...lines, 'FAILED（批在此中断）：', ...failed, tagNote]
        .filter(Boolean).join('\n'), lines.length === 0);
    }
    return asText([head, ...lines, tagNote].filter(Boolean).join('\n'));
  } catch (err) {
    return asText(`paint_still 失败：${err.message}`, true);
  }
}

/**
 * @param {object} deps
 */
export function makePaintStillTool(deps) {
  return tool(
    'paint_still',
    (localBoxEnabled()
      ? ''
      : '⛔ CURRENTLY UNAVAILABLE — this GPU lane is powered on and off manually, '
        + 'and it is offline right now. Do not call this tool. Use generate_image instead, '
        + 'and tell the user the local lane is offline if they asked for it specifically.\n\n')
    + `Generate anime/illustration images on the platform's self-hosted GPU lane. One call =
1-16 stills rendered serially; each finished image lands on the canvas
immediately. Each still can also set batch=N to get N variations of the SAME
prompt from one sampling pass — far cheaper than N separate stills, and it is
the right way to "roll" for a good result.

Models per still:
- "noobai" (default): NoobAI-XL V-Pred 1.0. Danbooru/e621 tags,
  comma-separated. Best anatomy and tag control for anime. ~25-40s.
- "noobai-eps": NoobAI-XL 1.1 (epsilon). Same tag language. Use ONLY when a
  LoRA you need exists solely in an eps build — eps LoRAs on the v-pred model
  wash out or oversaturate.
- "pony": Pony Diffusion V6 XL. Quality prefix is added box-side; write plain
  danbooru-ish tags. Its LoRA ecosystem is separate from NoobAI's and the two
  do NOT interchange. ~25-40s.
- "anima": natural-language English. ~20-40s.
- "krea2": Krea 2 Turbo 12B — natural-language English, aesthetic-first, good
  photoreal/editorial. 8-step, seconds per image once warm (first call after
  another model ~1 min to load 24GB). The negative field is a NO-OP here.

REFERENCE IMAGES (SDXL models: noobai / noobai-eps / pony). Three independent
channels, stackable, all taking workspace-relative paths:
- ref_image  -> IP-Adapter. Carries the CHARACTER'S LOOK across into a new
  picture. This is the right tool for "draw this character somewhere else".
- control_image -> ControlNet. Locks pose/structure; prompt drives the rest.
- init_image -> img2img. Repaints on top of the given picture (denoise 0.3 =
  touch-up, 0.6 default, 0.8 = loose reinterpretation).
Combine them: ref_image for who it is + control_image for the pose + prompt
for the scene is the strongest setup for keeping a character consistent.

Quality prefixes and per-model sampler settings are applied box-side — do not
repeat them in the prompt. LoRA trigger words DO have to be written into the
prompt yourself; the cookbook lists them.

TAG DISCIPLINE (noobai / noobai-eps / pony): pure comma-separated tags, no
sentences, spaces not underscores. Before the FIRST still of a new subject or
scene: understand what the user wants → write candidate tags → run
lookup_tags ONCE on all of them → paint with the verified ones. Re-rolls of
the same scene need no new lookup. The return of this tool carries a tag
check-up (weak/missing/sentence-like fragments) — fix those before judging
the batch.

Use for anime needs and video keyframes (1344x768 matches the video lane).
Requires the box online — if unreachable, tell the user and fall back to
generate_image.

Outputs land at assets/generated/still-*.png. You MAY look at them to catch
technical write-offs — duplicated figures, broken limbs, colour cast, all
black/white, stray watermark text — and just re-roll those yourself. Taste and
style direction stay the user's call: do not re-roll because you dislike it, and
do not tell the user which one is better. Default detail is enough to spot
breakage; do not burn high-detail on every frame.`,
    {
      stills: z.array(z.object({
        prompt: z.string().describe('danbooru/e621 tags (noobai/noobai-eps/pony) or natural English (anima/krea2)'),
        model: z.enum(['noobai', 'noobai-eps', 'pony', 'anima', 'krea2']).default('noobai'),
        negative: z.string().optional().describe('overrides the per-model default; no-op for krea2'),
        size: z.string().regex(/^\d{3,4}x\d{3,4}$/).default('1344x768'),
        seed: z.number().int().optional().describe('omit for fresh random per still; batch uses seed, seed+1, ...'),
        name: z.string().regex(/^[\w一-鿿぀-ヿ-]{1,40}$/).default('still'),
        batch: z.number().int().min(1).max(8).optional()
          .describe('variations of this same prompt in one pass (default 1). Use 4-8 to roll for a keeper.'),
        lora: z.string().optional()
          .describe('LoRA filename(s) in the box loras/ dir, comma-separated for stacking. Only names from the cookbook or given by the user.'),
        lora_strength: z.string().optional()
          .describe('single value applied to all, or comma-separated per LoRA. Default "0.8". Slider-type LoRAs want 2-4 and accept negatives — do not assume 0-1.'),
        // ---- 参考图三路，可叠加。路径都是工作区相对路径 ----
        init_image: z.string().optional()
          .describe('img2img base, workspace-relative path. Redraws ON TOP of this image. SDXL models only.'),
        denoise: z.number().min(0.1).max(1).optional()
          .describe('with init_image only. Default 0.6. Lower = closer to the original (0.3 = light touch-up, 0.8 = loose reinterpretation).'),
        control_image: z.string().optional()
          .describe('ControlNet reference, workspace-relative. Locks POSE/STRUCTURE while the prompt decides everything else.'),
        control_type: z.enum(['openpose', 'depth', 'canny', 'lineart', 'scribble', 'none'])
          .optional().describe('what to extract from control_image. Default openpose. "none" = image is already a processed control map.'),
        control_strength: z.number().min(0).max(2).optional().describe('default 0.7'),
        ref_image: z.string().optional()
          .describe('IP-Adapter reference(s), workspace-relative, comma-separated for UP TO 5. Transfers the CHARACTER LOOK into a new picture — the one for "draw my character somewhere else". Feeding 2-4 shots of the same character from different angles is markedly more consistent than one.'),
        ref_weight: z.string().optional()
          .describe('single value for all, or comma-separated per reference. Default "0.8". Higher = closer to the reference, less obedient to the prompt.'),
        ref_mode: z.enum(['style and composition', 'style transfer', 'composition',
          'strong style transfer', 'style transfer precise', 'composition precise']).optional()
          .describe('what to carry over. Default "style and composition". Use "style transfer" to take the look but NOT the layout — usually what you want when moving a character to a new scene.'),
        ref_combine: z.enum(['concat', 'add', 'subtract', 'average', 'norm average', 'max', 'min'])
          .optional().describe('how multiple references merge. Default concat. "average" is calmer when the refs disagree.'),
        ref_preset: z.enum(['PLUS (high strength)', 'PLUS FACE (portraits)',
          'STANDARD (medium strength)', 'VIT-G (medium strength)']).optional()
          .describe('IP-Adapter weight set. Default PLUS. Switch to "PLUS FACE (portraits)" when the point is keeping a FACE consistent.'),
      })).min(1).max(16).describe('stills rendered serially; each may itself batch'),
    },
    (args) => paintStills(deps, args),
  );
}
