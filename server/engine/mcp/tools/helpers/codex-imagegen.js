/**
 * helpers/codex-imagegen.js — codex 生图桥的 prompt 组装 + 子进程执行
 * （2026-08-24 从 generate-image.js 迁出：给棘轮腾行 + prompt 组装层归位一处）
 *
 * 两层各管一事：
 *   - buildVariationPrompt：变体模式（variationOf）的 prompt 骨架。把"要保持的
 *     东西逐项列出"从 agent 手写咒语变成参数 —— 32 张换装立绘实战里，漏写一项
 *     （袜子）整行就坏，这套骨架把踩过的坑固化成默认禁止项。
 *   - buildCodexBridgePrompt / runCodexImageGen：codex CLI 桥（原样迁出，
 *     仅第 3 条在变体模式下改口径：参考图第 1 张是编辑基底，不是风格参照）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serverTmpPath } from '../../../../lib/server-tmp.js';

export const CODEX_BIN = process.env.NODESIGN_CODEX_BIN || 'codex';
/**
 * 生图桥自己的模型与推理档（09-08 深夜站主定）：这一趟 codex 只做「调生图工具 → 拷文件」，不需要 ~/.codex/config.toml
 * 里给编码用的 gpt-6-astra + high。实测一张图 API 本身 100～217s，壳子（读 SKILL、想、cp）25～50s —— 换小模型省的是
 * 壳子那段和额度，不是 API 那段。留 env 口：NODESIGN_CODEX_IMAGE_MODEL / NODESIGN_CODEX_IMAGE_EFFORT；给空串 = 用 config.toml 的。
 */
export const CODEX_IMAGE_MODEL = process.env.NODESIGN_CODEX_IMAGE_MODEL ?? 'gpt-5.6-luna';
export const CODEX_IMAGE_EFFORT = process.env.NODESIGN_CODEX_IMAGE_EFFORT ?? 'low';
// 240s → 300s（09-08 深夜实测：codex 内置 image_gen 一张 100～217s，壳子再加 25～50s；271s 那张被 240s 掐死时图已经出来了）。
// 三道预算要错开：这里 300s < relay produce 330s < 桌面 relay 腿 360s，谁先到都能报出人话而不是 unknown。
export const CODEX_IMAGE_TIMEOUT_MS = Number(process.env.NODESIGN_CODEX_IMAGE_TIMEOUT_MS) || 300_000;

/**
 * 一趟 codex 生图的时间预算随提示词变长（09-17）。codex 的模型要把提示词逐字写进生图调用，
 * 实测 10001 字的中文提示词光写就用了约 3 分钟（出图本身二十来秒）。3500 字以内仍是 300 秒；
 * 更长的按每字 30ms 加（8000 字 → 360 秒，1 万字 → 420 秒）。relay 与桌面两道外层各在此基础上 +30 秒、+60 秒，
 * 三道仍然错开。
 */
export function codexImageBudgetMs(promptText = '') {
  const chars = [...String(promptText ?? '')].length;
  return Math.max(CODEX_IMAGE_TIMEOUT_MS, 120_000 + chars * 30);
}
export const relayProduceBudgetMs = (promptText) => codexImageBudgetMs(promptText) + 30_000;
export const relayLegBudgetMs = (promptText) => codexImageBudgetMs(promptText) + 60_000;

/**
 * 变体模式的 preserve 词表。键是 agent 传的枚举值，值是展开进 prompt 的英文短语。
 * 短语必须把"缺席也是要保持的"写死（no socks 的参考图，结果也必须 no socks）——
 * 这是实战里最容易漂的一类。
 */
export const PRESERVE_PHRASES = {
  pose: 'the exact same pose and body position',
  framing: 'the same framing, camera distance and position of the subject in the frame',
  proportions: 'the same height and body proportions',
  face: 'the same face and the same expression',
  hair: 'the same hairstyle and hair color',
  hands: 'the same hand positions, holding the same things (empty hands stay empty)',
  top: 'the same top garment — identical cut, color, sleeves, neckline and every detail',
  bottom: 'the same bottom garment (skirt / trousers) — identical in every detail',
  shoes: 'the same footwear, identical in every detail',
  socks: 'the same socks / legwear (if the reference has none, the result has none)',
  accessories: 'the same accessories — nothing added, nothing removed',
  background: 'the same background',
  lighting: 'the same lighting and color grading',
  style: 'the same art style and rendering technique',
};
export const PRESERVE_KEYS = Object.keys(PRESERVE_PHRASES);

// 不论 preserve 传什么都追加的通用军规 —— 全部是真实翻过车的：凭空长出背带、
// 白袜整行消失、取景悄悄拉近。
const VARIATION_HARD_RULES = [
  'Do NOT invent anything that is not in the reference: no added straps, suspenders,'
  + ' belts, hair ornaments, jewelry or extra garments.',
  'Absences are part of the reference: whatever the reference does not have, the result must not have.',
  'Do NOT change the subject\'s height, body proportions, or position in the frame.',
].join('\n');

/**
 * variationOf 模式：把 change + preserve 展开成"只改一处、其余照搬"的固定骨架。
 * @param {object} o
 * @param {string} o.change     唯一要改的那一处（自然语言）
 * @param {string[]} [o.preserve]  PRESERVE_KEYS 的子集；缺省 = 全部
 * @param {string} [o.extra]    附注（agent 想额外说明的，放在骨架之后）
 */
export function buildVariationPrompt({ change, preserve, extra }) {
  const keys = (preserve && preserve.length > 0) ? preserve : PRESERVE_KEYS;
  const phrases = keys.map((k) => PRESERVE_PHRASES[k]).filter(Boolean);
  return [
    'Reproduce the reference illustration (the first reference image) with ONE single change.',
    `THE ONLY CHANGE: ${change}`,
    `Everything else must be identical to the reference: ${phrases.join('; ')}.`,
    VARIATION_HARD_RULES,
    ...(extra ? [extra] : []),
  ].join('\n');
}

/**
 * codex 桥接 prompt。必须写死"逐字传递零改写"——codex agent 默认会按自己的
 * Augmentation rules 润色 prompt。变体模式下第 3 条改口径：第 1 张参考图是
 * **编辑基底**，必须除指定改动外逐细节复现（"风格参照"的软口径会被当成
 * style reference，收敛不住）。
 */
export function buildCodexBridgePrompt({ prompt, aspectRatio, absOut, refCount, variation = false }) {
  let refLine;
  if (refCount > 0 && variation) {
    refLine = `3. 本消息附带 ${refCount} 张参考图。第 1 张是**编辑基底**：除 <image-prompt> 指定的那一处改动外，`
      + '必须逐细节复现它的全部内容；其余参考图（如有）才是风格 / 一致性参照。';
  } else if (refCount > 0) {
    refLine = `3. 本消息附带 ${refCount} 张参考图，把它们作为图像生成的参考输入（风格 / 主体一致性参照）。`;
  } else {
    refLine = '3. 本次无参考图。';
  }
  return [
    '你是图像生成管道的执行端，只做下面几件事，不做任何多余动作：',
    '1. 调用你的图像生成工具生成一张图。<image-prompt> 标签内的内容必须逐字作为生成 prompt，禁止改写、增删、翻译或润色。',
    `2. 输出比例：${aspectRatio}。优先用工具的比例/尺寸参数；工具没有对应参数时，作为补充说明传给工具，但不修改 <image-prompt> 原文。`,
    refLine,
    `4. 生成后把图片文件复制到精确路径 ${absOut}（目录已存在）。`,
    '5. 最后只回复该绝对路径。',
    '<image-prompt>',
    prompt,
    '</image-prompt>',
  ].join('\n');
}

/**
 * 杀整棵进程树。⛔ 09-14 实证：`codex` 是 npm 的 node 外壳，真正干活的是它 spawn 的原生二进制，
 * 外壳只转发 SIGINT/SIGTERM/SIGHUP —— 对外壳发 SIGKILL 只杀掉外壳，原生 codex 成孤儿接着跑，
 * 重试那趟成功之后它又往同一路径写，生产上把一张已经交付的图截成了 0 字节。
 * POSIX 下 spawn 时开独立进程组（detached），杀 -pid；Windows 走 taskkill /T。
 */
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
  }
}

/** codex 最后一句像是拒绝 / 做不到：同样的请求再跑一次也是一样，不重试 */
const REFUSAL_RE = /(can['’]?t|cannot|unable to|not able to|won['’]?t|policy|safety|not allowed|refus|无法|不能|拒绝|违反|不允许|抱歉)/i;

/**
 * 跑一次 codex exec 生图，以目标文件落盘为成功标准（codex 的文本回复不可信），失败自动重试一次。
 *
 * 09-14 三处加固（问题库：生产 ×4、桌面 relay 两轮各 ×3 都只报「target file missing」）：
 *   - 每次尝试写各自的临时文件（同目录的点文件），成功后 rename 到 expectFile —— 残留的上一趟碰不到交付物；
 *   - 超时 / 中止杀整棵进程树（killTree）；
 *   - `-o` 让 codex 把最后一句话写进文件，缺图时带进报错；像拒绝的不重试。
 * @param {object} o
 * @param {(absOut: string) => string} o.makePrompt  按这一趟的落盘路径生成桥接 prompt
 */
export async function runCodexImageGen({ makePrompt, refPaths, cwd, signal, expectFile, timeoutMs = CODEX_IMAGE_TIMEOUT_MS }) {
  const runOnce = (args) => new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: process.platform !== 'win32' });
    let stderrTail = '';
    child.stdout.on('data', () => { /* 排空防背压 */ });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    const killTimer = setTimeout(() => {
      killTree(child);
      reject(new Error(`codex exec timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) return reject(new Error(`codex exec exited ${code}: ${stderrTail.slice(-300) || 'no stderr'}`));
      resolve();
    });
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const tag = `${process.pid}-${Date.now().toString(36)}-${attempt}`;
    const attemptOut = path.join(path.dirname(expectFile), `.codex-${tag}-${path.basename(expectFile)}`);
    // codex 的最后一句回复里是用户的生图意图，落在服务端私有临时根（沙盒遮读，09-17）
    const lastMsgFile = serverTmpPath(`nd-codex-last-${tag}.txt`);
    const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', cwd, '-o', lastMsgFile];
    if (CODEX_IMAGE_MODEL) args.push('-m', CODEX_IMAGE_MODEL);
    if (CODEX_IMAGE_EFFORT) args.push('-c', `model_reasoning_effort="${CODEX_IMAGE_EFFORT}"`);
    args.push(makePrompt(attemptOut));
    for (const p of refPaths) args.push('-i', p);
    let refused = false;
    try {
      await runOnce(args);
      const st = await fs.stat(attemptOut).catch(() => null);
      if (st && st.size > 0) {
        await fs.rename(attemptOut, expectFile);
        return;
      }
      const last = (await fs.readFile(lastMsgFile, 'utf8').catch(() => '')).trim().replace(/\s+/g, ' ');
      refused = !!last && REFUSAL_RE.test(last);
      throw new Error(`codex finished but target file missing/empty: ${expectFile}`
        + (last ? `；codex 最后说：「${last.slice(0, 300)}」` : '；codex 没有留下回复'));
    } catch (err) {
      if (attempt === 2 || signal?.aborted || refused) throw err;
      console.warn(`[generate-image] codex attempt ${attempt} failed (${err.message}), retrying once`);
    } finally {
      await fs.rm(attemptOut, { force: true }).catch(() => {});
      await fs.rm(lastMsgFile, { force: true }).catch(() => {});
    }
  }
}
