/**
 * mcp/tools/roll-film.js — roll_film MCP tool（2026-08-08；批量制同晚补上）
 *
 * 自部署 MiniMax-H3 视频产线。一次调用 = 一批镜头（1-16 条），全批共用一个
 * seed（成片纪律）；盒上串行渲，每出一镜当场落盘上墙。后端两档：
 *   box（默认）  站主 5090 盒子（h3box.py video over SSH），模型常驻零冷启动。
 *   modal        Modal H100+sage 备用档，NODESIGN_FILM_BACKEND=modal 显式才走。
 * 配方恒定：Turbo 8 步 / 1344×768 / 单镜 ≤12.25s。批准制：admin+获批账号。
 * 只回文本路径，不回 image block；agent 可以自己抽帧看（2026-08-18 解禁），
 * 但"这条好不好"归用户判。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Events } from '../../agent/events.js';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { can, localGenApproved, DENIAL } from '../../../auth/tier.js';
import { boxConfig, runBox, sshArgs, scpArgs, localBoxEnabled, BOX_OFF_MSG } from './h3box-ssh.js';

const H3_REPO = process.env.NODESIGN_H3_REPO || '/home/wangang-dev/projects/minimax-h3-modal';
const MODAL_BIN = process.env.NODESIGN_MODAL_BIN || path.join(os.homedir(), '.local/bin/modal');
const PER_SHOT_TIMEOUT_MS = Number(process.env.NODESIGN_FILM_TIMEOUT_MS) || 900_000;

function frameCount(durationS) {
  const f = Math.max(5, Math.round(durationS * 24));
  return f + ((5 - (f % 17)) % 17 + 17) % 17;
}

function estCostUsd(d, backend) {
  const pts = backend === 'modal'
    ? [[5.17, 0.10], [8, 0.16], [10, 0.21], [12.25, 0.28]]
    : [[5.17, 0.015], [8, 0.02], [12.25, 0.03]];
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i][0]) {
      const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
      return Math.round((y0 + (d - x0) * (y1 - y0) / (x1 - x0)) * 1000) / 1000;
    }
  }
  return pts[pts.length - 1][1];
}

function runModal(args, { cwd, signal, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(MODAL_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-8000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, out, err });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
  });
}

/** 单镜落盘 + sidecar + 上墙事件；返回 caption 行 */
async function landShot({ localMp4, shot, seed, backend, wallS, outDir, ctx, sessionId }) {
  const fileName = `${shot.name}-${shot.jobId.slice(5)}.mp4`;
  const absOut = path.join(outDir, fileName);
  await fs.rename(localMp4, absOut).catch(async () => {
    await fs.copyFile(localMp4, absOut); await fs.unlink(localMp4).catch(() => { /* */ });
  });
  const sizeBytes = (await fs.stat(absOut)).size;
  const cost = estCostUsd(shot.duration, backend);
  try {
    const metaDir = path.join(outDir, '.meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(path.join(metaDir, `${path.parse(fileName).name}.json`), JSON.stringify({
      prompt: shot.prompt, kind: 'film', durationS: shot.duration, frames: frameCount(shot.duration),
      seed, model: backend === 'modal' ? 'minimax-h3-turbo8-h100-sage' : 'minimax-h3-turbo8-5090-sage2',
      estCostUsd: cost, wallClockS: wallS,
      firstFrame: shot.first_frame || null, lastFrame: shot.last_frame || null,
      sessionId: ctx?.sessionId || sessionId || null, runId: ctx?.runId || null,
      ts: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.warn(`[roll-film] meta sidecar failed: ${e.message}`); }
  // MCP 工具写盘不走自动 file_changed —— 手动发，出一镜上墙一镜
  // 工作区相对路径（fileChanged 正字法，2026-08-14 普查改；绝对路径=前端寻址哑弹）
  try { ctx?.emit?.(Events.fileChanged(path.posix.join('assets', 'generated', fileName), 'add')); } catch { /* */ }
  return `[${shot.name}] assets/generated/${fileName} — ${shot.duration}s ${(sizeBytes / 1e6).toFixed(1)}MB ${Math.floor(wallS / 60)}m${wallS % 60}s ~$${cost}`;
}

export async function rollFilm(
  { workspaceRoot, sharedRoot, projectId, sessionId, ctx },
  { shots, seed },
) {
  const asText = (text, isError = false) =>
    ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  try {
    const project = getProject(projectId);
    if (!project) return asText('错误：项目不存在', true);
    const owner = project.ownerId ? getUserById(project.ownerId) : null;
    if (!owner) return asText('错误：找不到项目归属用户', true);
    // 档位闸 + 逐人批准（auth/tier.js）：basic 档不开本地产线；pro 档还要被站主批过
    if (!can(owner, 'localGen')) return asText(DENIAL.localGenTier, true);
    if (!localGenApproved(owner)) return asText(DENIAL.localGenApproval, true);

    // 全批先验完再花钱：帧域 + 关键帧存在性 + 名字唯一
    const names = new Set();
    for (const s of shots) {
      const frames = frameCount(s.duration);
      if (frames > 294) return asText(`[${s.name}] ${frames} 帧超产线安全域 294（12.25s），拆镜`, true);
      if (names.has(s.name)) return asText(`镜名重复：${s.name}`, true);
      names.add(s.name);
      for (const slot of ['first_frame', 'last_frame']) {
        if (!s[slot]) continue;
        const abs = path.resolve(workspaceRoot || process.cwd(), s[slot]);
        try {
          if (!(await fs.stat(abs)).isFile()) throw new Error('x');
        } catch { return asText(`[${s.name}] ${slot} 找不到：${s[slot]}`, true); }
        s[`_abs_${slot}`] = abs;
      }
    }

    const backend = (process.env.NODESIGN_FILM_BACKEND || 'box').toLowerCase();
    // 只拦 box 后端：modal 是另一台机器，站主关本地盒子不影响它
    if (backend === 'box' && !localBoxEnabled()) {
      return asText(BOX_OFF_MSG, true);
    }
    const signal = ctx?.abortController?.signal;
    const outDir = path.join(sharedRoot || workspaceRoot, 'assets', 'generated');
    await fs.mkdir(outDir, { recursive: true });
    const batch = Date.now().toString(36);
    const lines = []; const failed = [];

    let box = null;
    if (backend !== 'modal') {
      box = boxConfig();
      if (!box) return asText('视频服务器未配置（当前未启动）。转告用户；启用备用 Modal 档需将 NODESIGN_FILM_BACKEND 设为 modal。', true);
      const mk = await runBox(box, 'ssh', [...sshArgs(box), 'mkdir -p nd_jobs'], { timeoutMs: 30_000, signal });
      if (mk.code !== 0) return asText(`无法连接渲染服务器（未启动或地址失效）：\n${(mk.err || '').slice(-400)}\n转告用户。`, true);
    }

    // 逐镜串行：一镜完整走完（渲→取回→上墙）再下一镜，agent 中途被打断也保住已出的
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      shot.jobId = `film-${batch}s${i}`;
      const job = { name: shot.jobId, prompt: shot.prompt, seed, duration: shot.duration, width: 1344, height: 768 };
      if (shot.steps) job.steps = shot.steps;
      const t0 = Date.now();
      let localMp4 = null; let failMsg = null;

      if (backend === 'modal') {
        if (shot._abs_first_frame) job.first_frame = shot._abs_first_frame;
        if (shot._abs_last_frame) job.last_frame = shot._abs_last_frame;
        const jp = path.join(os.tmpdir(), `nd-${shot.jobId}.json`);
        await fs.writeFile(jp, JSON.stringify([job]));
        const r = await runModal(['run', 'h3_comfy.py', '--jobs-file', jp], { cwd: H3_REPO, signal, timeoutMs: PER_SHOT_TIMEOUT_MS });
        fs.unlink(jp).catch(() => { /* */ });
        if (r.code !== 0) failMsg = (r.err || r.out).slice(-600);
        else {
          const hits = (await fs.readdir(path.join(H3_REPO, 'outputs'))).filter((f) => f.startsWith(`${shot.jobId}_`) && f.endsWith('.mp4'));
          if (hits.length) localMp4 = path.join(H3_REPO, 'outputs', hits[0]);
          else failMsg = `无成片。输出尾：${r.out.slice(-400)}`;
        }
      } else {
        for (const slot of ['first_frame', 'last_frame']) {
          const abs = shot[`_abs_${slot}`];
          if (!abs) continue;
          const remote = `nd_jobs/${shot.jobId}-${slot}${path.extname(abs) || '.png'}`;
          const up = await runBox(box, 'scp', [...scpArgs(box), abs, `${box.target}:${remote}`], { timeoutMs: 60_000, signal });
          if (up.code !== 0) { failMsg = `关键帧上传失败：${up.err.slice(-300)}`; break; }
          job[slot] = `~/${remote}`;
        }
        if (!failMsg) {
          const jl = path.join(os.tmpdir(), `nd-${shot.jobId}.json`);
          await fs.writeFile(jl, JSON.stringify([job]));
          const upJ = await runBox(box, 'scp', [...scpArgs(box), jl, `${box.target}:nd_jobs/${shot.jobId}.json`], { timeoutMs: 30_000, signal });
          fs.unlink(jl).catch(() => { /* */ });
          if (upJ.code !== 0) failMsg = `任务上传失败：${upJ.err.slice(-300)}`;
          else {
            const gen = await runBox(box, 'ssh', [...sshArgs(box), `python3 ~/h3box.py video ~/nd_jobs/${shot.jobId}.json`], { timeoutMs: PER_SHOT_TIMEOUT_MS, signal });
            if (gen.code !== 0 || !gen.out.includes('success')) failMsg = `渲染失败（exit ${gen.code}）：${(gen.err || gen.out).slice(-600)}`;
            else {
              const pd = await fs.mkdtemp(path.join(os.tmpdir(), 'nd-film-'));
              const pull = await runBox(box, 'scp', [...scpArgs(box), `${box.target}:outputs/${shot.jobId}_*.mp4`, pd], { timeoutMs: 120_000, signal });
              const got = pull.code === 0 ? (await fs.readdir(pd)).filter((f) => f.endsWith('.mp4')) : [];
              if (got.length) localMp4 = path.join(pd, got[0]);
              else failMsg = `成片取回失败：${pull.err.slice(-300)}`;
            }
          }
        }
      }

      const wallS = Math.round((Date.now() - t0) / 1000);
      if (localMp4) {
        lines.push(await landShot({ localMp4, shot, seed, backend, wallS, outDir, ctx, sessionId }));
      } else {
        failed.push(`[${shot.name}] ${failMsg}`);
        if (signal?.aborted) break;
        break;   // 串行批中途失败即停：后镜大概率同因失败，别空烧
      }
    }

    const head = `Batch done ${lines.length}/${shots.length} shots, seed=${seed}, via ${backend === 'modal' ? 'Modal H100+sage' : '5090 sage2'}`;
    // 2026-08-18：解禁。mp4 塞不进视觉通道，要看就 ffmpeg 抽帧再看那几张图。
    const tail = 'You may check these: pull two or three frames with ffmpeg and look at them '
      + 'for technical breakage (colour cast, duplicated figures, broken limbs, mush, first '
      + 'frame not matching the anchor) and re-roll those yourself; delete the temp frames after. '
      + 'Do NOT judge whether a shot is good — hand the paths to the user for that.';
    if (failed.length) {
      return asText([head, ...lines, 'FAILED（批在此中断，未渲镜不再空烧）：', ...failed, tail].join('\n'), lines.length === 0);
    }
    return asText([head, ...lines, tail].join('\n'));
  } catch (err) {
    return asText(`roll_film 失败：${err.message}`, true);
  }
}

/**
 * @param {object} deps
 */
export function makeRollFilmTool(deps) {
  return tool(
    'roll_film',
    ((localBoxEnabled() || (process.env.NODESIGN_FILM_BACKEND || 'box').toLowerCase() === 'modal')
      ? ''
      : '⛔ CURRENTLY UNAVAILABLE — this GPU lane is powered on and off manually, '
        + 'and it is offline right now. Do not call this tool; tell the user the local lane is offline.\n\n')
    + `Generate video shots (picture + native audio) on the platform's self-hosted
MiniMax-H3 lane (RTX 5090 server, SageAttention, Turbo 8-step, 24fps). One call =
one batch of 1-16 shots rendered back-to-back; each finished shot lands on the
canvas immediately. Max 12.25s per shot — longer stories are multiple shots.

Call ONLY when the user explicitly asks for video, and align the shot list with
the user before rolling a multi-shot batch. Roughly 3-5 minutes per shot,
serial; tell the user rendering has started. Never auto-retry shots you already
got back. Requires the GPU box online — if unreachable, relay that and stop.

Prompts must follow the H3 three-field English format (cookbook arrives as a
system reminder attached to your FIRST call — treat your first batch as the
learning pass and refine from it). Keep character/style blocks verbatim
identical across shots; the whole batch shares ONE seed automatically. Keyframe
anchors (first_frame/last_frame) accept paths like "assets/generated/kf1.png"
(make them with paint_still or generate_image, ideally 1344x768).

Clips land at assets/generated/<name>-*.mp4. To check one, pull a couple of
frames with ffmpeg and look at those — catch colour cast, duplicated figures,
broken limbs, mush, or a first frame that does not match its anchor, and re-roll
those yourself (delete the temp frames after). Whether a shot is GOOD is the
user's call, not yours: report paths
and move on.`,
    {
      shots: z.array(z.object({
        prompt: z.string().describe('H3 three-field English prompt'),
        duration: z.number().min(5.2).max(12.25).default(8),
        name: z.string().regex(/^[\w一-鿿぀-ヿ-]{1,40}$/).describe('shot slug, unique in batch'),
        first_frame: z.string().optional(),
        last_frame: z.string().optional(),
        steps: z.number().int().min(4).max(8).optional().describe('default 8; 4 = fast draft'),
      })).min(1).max(16).describe('shots rendered serially in one batch'),
      seed: z.number().int().default(1101).describe('ONE seed shared by the whole batch (film discipline)'),
    },
    (args) => rollFilm(deps, args),
  );
}
