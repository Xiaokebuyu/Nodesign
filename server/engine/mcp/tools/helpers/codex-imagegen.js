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
import { spawn } from 'node:child_process';

export const CODEX_BIN = process.env.NODESIGN_CODEX_BIN || 'codex';
// 240s → 300s（09-08 深夜实测：codex 内置 image_gen 一张 100～217s，壳子再加 25～50s；271s 那张被 240s 掐死时图已经出来了）。
// 三道预算要错开：这里 300s < relay produce 330s < 桌面 relay 腿 360s，谁先到都能报出人话而不是 unknown。
export const CODEX_IMAGE_TIMEOUT_MS = Number(process.env.NODESIGN_CODEX_IMAGE_TIMEOUT_MS) || 300_000;

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
 * 跑一次 codex exec 生图，以目标文件落盘为成功标准（codex 的文本回复不可信），
 * 失败自动重试一次。abort signal / 超时都 SIGKILL 子进程。
 */
export async function runCodexImageGen({ bridgePrompt, refPaths, cwd, signal, expectFile, timeoutMs = CODEX_IMAGE_TIMEOUT_MS }) {
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', cwd, bridgePrompt];
  for (const p of refPaths) args.push('-i', p);

  const runOnce = () => new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderrTail = '';
    child.stdout.on('data', () => { /* 排空防背压 */ });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`codex exec timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } };
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
    try {
      await runOnce();
      const st = await fs.stat(expectFile).catch(() => null);
      if (st && st.size > 0) return;
      throw new Error(`codex finished but target file missing/empty: ${expectFile}`);
    } catch (err) {
      if (attempt === 2 || signal?.aborted) throw err;
      console.warn(`[generate-image] codex attempt ${attempt} failed (${err.message}), retrying once`);
    }
  }
}
