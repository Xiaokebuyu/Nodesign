/**
 * mcp/tools/trace-motion.js — trace_motion（2026-08-19，问题库 iss_mszv782a_toab）
 *
 * ## 为什么有这个工具
 *
 * 胶片条（screenshot_canvas frames）解决"看得见"，这个解决"量得出"。上报里
 * 的三类事故它都能直接抓：
 *   - 装弹位姿写到镜头背后（z=-2.76，镜头在 -2.68）—— 采一条 z 曲线，数字直接露馅，
 *     不用赌"恰好在静帧上也是错的"
 *   - 两个 tween 之间硬切 —— 单帧跳变检测，标出时刻
 *   - 过冲回稳 170ms 够不够 —— overshoot% 和 settle 时刻都是量出来的数
 * 帧健康（fps/p95/最长帧）顺带回传：按帧衰减、卡顿这类"环境恰好跑得慢才暴露"
 * 的问题从此不靠运气。
 *
 * ## 数字怎么读
 *
 * ⚠️ 同 profile_scroll：1 vCPU、录制自身有开销，绝对帧率不代表用户设备。
 *    曲线形状（过冲/硬切/稳定时间）不受影响 —— 它们跟的是页面自己的时钟。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveCanvasTarget, CANVAS_PATH_DESC, KIND_SITE, requireBrowsable } from '../../../lib/artifact-target.js';
import { resolveDeckSize, extractDeckAspect } from '../../../shared/deck.js';
import { degradedNote } from './helpers/perception-page.js';
import { acquireArtifactPage, LIVE_PARAM_DESC } from './helpers/acquire-page.js';
import { runWaitFor, runBeforeShot, attachPageDiagnostics, normalizeShot } from './helpers/shot-pipeline.js';
import { recordMotion, seriesReport, chartSvg, fmtNum, motionCaptionLines } from './helpers/motion-lab.js';
import { wheelScroll, elementMotionReport, elementMotionLines } from './helpers/motion-scroll.js';
import { promises as fs } from 'node:fs';

export function makeTraceMotionTool({ workspaceRoot, projectId, sessionId }) {
  return tool(
    'trace_motion',
    `Numerically trace a motion: sample JS expressions once per animation frame
while a move plays, and get back per-curve statistics plus ONE rendered chart
image. This is the instrument for easing quality — where a screenshot guesses,
this measures.

Give it named expressions (page context, evaluated every rAF):
  expressions: { gun_y: "window.game.gun.position.y",
                 cam_z: "window.game.camera.position.z" }
plus trigger:"window.game.startReload()" (JS that starts the move) and/or
click:"#fire" (a REAL trusted click — needed for pointer lock / AudioContext).

Per curve you get: first/final/min/max, overshoot % of travel, settle time
(last moment it was >3% of travel away from final), and HARD CUTS — single-frame
jumps >22% of range, i.e. the visible snap between two tweens or a teleporting
bone. The chart draws every curve (normalized, real ranges in the legend) with
cut moments marked in red. Also returned: frame health (fps / p95 / worst frame
— catches per-frame decay written without dt, and jank) and an audio event log
(when media.play()/bufferSource.start() fired — you cannot hear, but you can
check sync against the motion).

Use it when:
- an easing feels wrong and you need to see WHERE (attack too soft? no follow-
  through? overshoot 0%?) — sample the animated property itself
- you suspect a position/rotation goes somewhere silly (behind the camera,
  under the floor) — sample it; the numbers do not depend on luck
- the user says an animation is janky/mushy — run with no expressions at all:
  you still get frame health during the move
- two tweens meet and you want to prove the transition is C1-smooth — the cut
  detector is exactly that check

Works on any browsable artifact (deck or site). ⚠️ Absolute fps numbers are from
a 1-vCPU box with recording overhead — use them for A/B, not as the user's
experience. Curve SHAPES (overshoot, cuts, settle) follow the page's own clock
and are trustworthy.

For SEEING the frames instead of measuring them, use screenshot_canvas with
frames:[...] (filmstrip contact sheet).`,
    {
      path: z.string().optional().describe(CANVAS_PATH_DESC),
      live: z.boolean().optional().describe(LIVE_PARAM_DESC),
      scrollBy: z.number().min(-8000).max(8000).optional()
        .describe('Pixels of REAL wheel scrolling dispatched over the recording window (positive = down): trace scroll-driven motion (ScrollTrigger scrub, parallax, reveals) the way a visitor triggers it. Can combine with trigger/click.'),
      elements: z.boolean().optional()
        .describe('Also run the element probe (default true): which elements moved / faded / scaled during the recording, by how much and when — the no-expression way to see who moves.'),
      expressions: z
        .record(z.string(), z.string())
        .optional()
        .describe('Named JS expressions sampled every animation frame, e.g. {"gun_y": "window.game.gun.position.y"}. Names: ASCII letters/digits/underscore. Max 6. Each must evaluate to a number. Omit to trace frame health only.'),
      durationMs: z
        .number()
        .int()
        .min(300)
        .max(15000)
        .optional()
        .describe('How long to record after the trigger (default 2000ms). Cover the whole move plus a settle margin.'),
      trigger: z
        .string()
        .optional()
        .describe('JS snippet that STARTS the motion, evaluated in page context at t=0 (await OK). Omit to trace whatever is already animating.'),
      click: z
        .string()
        .optional()
        .describe('CSS selector to REAL-click at t=0 (trusted user gesture — pointer lock, AudioContext, autoplay). Fires before trigger if both given.'),
      waitFor: z
        .string()
        .optional()
        .describe('JS expression polled every 100ms until truthy before anything else runs (15s budget) — wait for slow boots: "window.__game".'),
      beforeShot: z
        .string()
        .optional()
        .describe('Setup JS run after waitFor, before recording starts (10s budget) — e.g. skip an intro, select a weapon.'),
      viewport: z
        .object({
          width: z.number().int().min(320).max(3840),
          height: z.number().int().min(240).max(2160),
        })
        .optional()
        .describe('Browser viewport; defaults to the deck aspect (decks) or 1440x900 (sites).'),
    },
    async ({ path: relPath, expressions, durationMs, trigger, click, waitFor, beforeShot, viewport, live, scrollBy, elements }) => {
      const target = await resolveCanvasTarget(workspaceRoot, relPath, sessionId);
      if (!target.ok) return { content: [{ type: 'text', text: target.message }], isError: true };
      const guard = requireBrowsable(target);
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

      const names = Object.keys(expressions || {});
      if (names.length > 6) {
        return { content: [{ type: 'text', text: 'Max 6 expressions per trace — run twice instead.' }], isError: true };
      }
      const badName = names.find((n) => !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(n));
      if (badName) {
        return { content: [{ type: 'text', text: `Expression name "${badName}" — use ASCII letters/digits/underscore only.` }], isError: true };
      }

      let vp = viewport;
      if (!vp) {
        if (target.kind === KIND_SITE) vp = { width: 1440, height: 900 };
        else {
          const html = await fs.readFile(target.absPath, 'utf8').catch(() => '');
          const d = resolveDeckSize(extractDeckAspect(html));
          vp = { width: d.width, height: d.height };
        }
      }

      const dur = durationMs ?? 2000;
      let acq;
      try {
        // 量逐帧数值：独占全部浏览器槽位（helpers/browser-slots.js）
        acq = await acquireArtifactPage({ projectId, workspaceRoot, target, live, viewport: vp, exclusive: true });
        const page = acq.page;
        const opened = acq;
        if (acq.live) vp = acq.viewport;
        const diag = attachPageDiagnostics(page);

        const waitForNote = waitFor ? await runWaitFor(page, waitFor) : null;
        const beforeShotNote = beforeShot ? await runBeforeShot(page, beforeShot) : null;

        // 纯数值通道：不开 screencast，jpeg 编码那份 CPU 省给页面本身
        const y0 = await page.evaluate(() => window.scrollY).catch(() => 0);
        const during = scrollBy ? (p) => wheelScroll(p, { px: scrollBy, durationMs: Math.max(200, dur - 100) }) : null;
        const rec = await recordMotion(page, {
          durationMs: dur, trigger, click, during, expressions, wantShots: false, probeElements: elements !== false,
        });
        const y1 = await page.evaluate(() => window.scrollY).catch(() => y0);
        const probe = elements !== false ? elementMotionReport(rec.elems, { scrolledPx: y1 - y0 }) : null;

        const lines = [];
        const degraded = degradedNote(opened);
        if (degraded) lines.push(degraded, '');
        if (acq.liveNote) lines.push(acq.liveNote, '');
        if (acq.gotoNote) lines.push(acq.gotoNote, '');
        lines.push(`trace_motion — ${target.relPath} @ ${vp.width}x${vp.height}, ${dur}ms after t=0${trigger || click ? '' : ' (no trigger — ambient recording)'}`);

        const seriesList = [];
        for (const name of names) {
          if (rec.errs[name]) {
            lines.push(`✗ ${name}: ${rec.errs[name]}`);
            continue;
          }
          const points = rec.rows.map((r) => ({ t: r.t, v: r[name] }));
          const rep = seriesReport(points);
          if (!rep.ok) {
            lines.push(`✗ ${name}: only ${rep.n} numeric samples — nothing to say`);
            continue;
          }
          seriesList.push({ name, points, report: rep });
          const bits = [
            `${name}: ${fmtNum(rep.first)} → ${fmtNum(rep.final)} (min ${fmtNum(rep.min)}, max ${fmtNum(rep.max)}, ${rep.n} samples)`,
          ];
          if (rep.still) {
            bits.push('  ⚠ value never changed — the expression is right but nothing moved (wrong object? move never started?)');
          } else {
            bits.push(`  overshoot ${rep.overshootPct.toFixed(1)}% of travel, settled by ~${Math.round(rep.settleMs)}ms`);
            if (rep.cuts.length) {
              bits.push(`  ⚠ HARD CUT at ${rep.cuts.map((t) => `${t}ms`).join(', ')} — single-frame jump >22% of range (tween boundary snap / teleport)`);
            }
          }
          lines.push(...bits);
        }

        if (probe) lines.push('', ...elementMotionLines(probe));
        lines.push('', ...motionCaptionLines(rec));
        const diagText = diag.summary();
        if (diagText) lines.push(diagText);

        const content = [{ type: 'text', text: lines.join('\n') }];
        if (seriesList.length) {
          const { default: sharp } = await import('sharp');
          const svg = chartSvg(seriesList, dur);
          const png = await sharp(Buffer.from(svg)).png().toBuffer();
          const shot = await normalizeShot(png);
          content.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
        }
        return { content };
      } catch (err) {
        return { content: [{ type: 'text', text: `trace_motion failed: ${err?.message || String(err)}` }], isError: true };
      } finally {
        await acq?.release?.();   // 一次性：关浏览器；live：松会话锁
      }
    },
  );
}
