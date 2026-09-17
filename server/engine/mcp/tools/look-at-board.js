/**
 * mcp/tools/look-at-board.js —— look_at_board（2026-08-23 黑板）
 *
 * agent 的眼睛。在这之前它对画布只有文字座次表；画了涂鸦/草图看不见结果，
 * 08-14 才会说"agent 画矢量笔迹没意义"。有了眼睛，涂鸦就是有回路的事：
 * 画一笔、看一眼、改一笔。
 *
 * 怎么看：用常驻 chromium 打开**用户看的同一张画布页**（?eye=1 眼睛模式，见前端
 * eye-mode.js），等页面把相机摆好打 data-eye-ready，截一张 PNG 回来。不另写服务端
 * 渲染器 —— 同一件东西两个实例会分叉（最贵的一课）。
 *
 * 入口地址：hosted 模式下 SPA 由 nginx 发（node 只出 API），所以要 NODESIGN_WEB_ORIGIN
 * 指到对外入口（exp: https://…:8443）；本地分发版 node 自己发 dist，走 127.0.0.1。
 * 两者都没有 → 工具老实说看不了，别静默截一张 API 404 页。
 *
 * 代价：1 vCPU 上一张图几秒钟 + 一阵 CPU；token 按像素算（1400×900 ≈ 1.7k），
 * 所以按需调用，不做每回合自动注入。
 *
 * 09-17 两处（问题库）：
 *   - around 接共用锚点解析（iss_mtjevkfs_n9dm）：原来只做 normalizeCanvasId + 精确查座位，`X（site）`、
 *     `xx/index.html`、还没座位的真文件一律报「还没有座位」，对不存在的文件也这么说。现在跟 write_on_board 同口径。
 *   - 截图超时兜底（iss_mtcl9nps_7q15）：page.screenshot 等稳定帧 / 字体，画布上有持续动画时可能等满
 *     默认 30s 直接失败。先给 15s，超时改走 CDP Page.captureScreenshot 抓当前帧（同 helpers/shot-pipeline.js
 *     shotWithFallback 的做法，本体在 look-at-board-frame.js，不跨文件引用那个管线）。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getProject } from '../../../projects/store.js';
import { getUserById } from '../../../auth/users-store.js';
import { authEnabled } from '../../../auth/session.js';
import { mintInternalCookie } from '../../../auth/internal-credentials.js';
import { platform } from '../../../runtime/platform.js';
import { launchPerceptionBrowser, PERCEPTION_ORIGIN } from './helpers/perception-page.js';
import { gatedBrowser } from './helpers/browser-slots.js';
import { bareTag } from '../../../lib/canvas-id.js';
import { captureBoardShot, frameAround } from './look-at-board-frame.js';

const VIEW = { width: 1400, height: 900 };
const READY_TIMEOUT_MS = 25_000;
// 并发闸：一次只开一台 chromium 看板（1 vCPU 机器多会话同时看板 = 多个浏览器进程；fable 08-23 P2）。
// 排队不拒绝，等前一个看完。09-13 起开浏览器还要过进程级槽位（helpers/browser-slots.js，跟截图类工具共用）；
// 这条留着：看板打开的是整个前端应用，比截一个产物页重得多，本地版两个槽位时也只许一只在看板。
// 先过这条再拿槽位，顺序固定，不会互等。
let gate = Promise.resolve();
const withGate = (fn) => { const run = gate.then(fn, fn); gate = run.catch(() => {}); return run; };

export function webOrigin() {
  const env = String(process.env.NODESIGN_WEB_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return env;
  if (platform?.serveWeb) return PERCEPTION_ORIGIN;
  return null;
}

export function makeLookAtBoardTool({ projectId }) {
  return tool(
    'look_at_board',
    `LOOK at the canvas (a real screenshot of the board as the user sees it). Use it after
write_on_board / edit_board to check what you drew, or when the
user talks about how things look on the board. Pick a region — the whole board shrunk
into one image is unreadable:
- tag: frame the group carrying this #tag (a sketch you made)
- around: frame this canvas id (and some margin)
- view: explicit world rect {x,y,w,h} (coordinates from read_board)
- none of the above: everything (overview only)
Costs a few seconds and ~1.7k tokens; don't call it in a loop.`,
    {
      tag: z.string().max(40).optional(),
      around: z.string().max(300).optional(),
      margin: z.number().min(0).max(2000).optional().describe('World px of margin around `around` (default 160)'),
      view: z.object({ x: z.number(), y: z.number(), w: z.number().min(50), h: z.number().min(50) }).optional(),
    },
    async ({ tag: rawTag, around, margin, view }) => {
      const tag = rawTag ? bareTag(rawTag) : rawTag;   // 同上：查询侧统一剥 #
      const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
      if (!projectId) return err('No project bound.');
      const origin = webOrigin();
      if (!origin) {
        return err('look_at_board 不可用：这台服务不知道画布页的入口地址（hosted 模式 SPA 由 nginx 发）。'
          + '管理员在 .env 设 NODESIGN_WEB_ORIGIN=https://<域名>[:端口] 后重启即可。本地分发版自动可用。');
      }
      let box = view || null;
      let what = 'whole board';
      if (!box && around) {
        const f = await frameAround(projectId, around, margin ?? 160);
        if (f.error) return err(f.error);
        box = f.box; what = f.what;
      }
      if (tag && !box) what = `group #${tag}`;
      if (box) what = `${what === 'whole board' ? 'rect' : what} (${Math.round(box.x)},${Math.round(box.y)}) ${Math.round(box.w)}x${Math.round(box.h)}`;

      const q = new URLSearchParams({ eye: '1' });
      if (box) q.set('view', [box.x, box.y, box.w, box.h].map(n => Math.round(n)).join(','));
      else if (tag) q.set('tag', tag);
      const url = `${origin}/projects/${encodeURIComponent(projectId)}/work?${q}`;

      return withGate(async () => {
      let browser = null;
      try {
        browser = await gatedBrowser(() => launchPerceptionBrowser(), { key: projectId });
        const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
        if (authEnabled()) {
          const ownerId = getProject(projectId)?.ownerId;
          const owner = ownerId ? getUserById(ownerId) : null;
          if (!ownerId || !owner || owner.disabled) return err('look_at_board：项目所有者账号不可用（不存在或已停用），拿不到看画布的身份。');
          await context.addCookies([{ ...mintInternalCookie(ownerId), url: origin, httpOnly: true }]);   // 进程内短期凭证（auth/internal-credentials.js）
        }
        const page = await context.newPage();
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (resp && resp.status() >= 400) return err(`画布页打开失败：HTTP ${resp.status()}（${origin}）。请确认 NODESIGN_WEB_ORIGIN 配置正确。`);
        try {
          await page.waitForSelector('html[data-eye-ready="1"]', { timeout: READY_TIMEOUT_MS });
        } catch {
          return err('画布页没在 25s 内就绪（data-eye-ready 没出现）。通常为入口地址错误或鉴权失败；本次截图终止。');
        }
        const { buf: png, degraded } = await captureBoardShot(page);
        const data = png.toString('base64');
        // 眼睛模式页面会把相机摆到的真实矩形写在 dataset 里（如果前端给了就报）
        const shown = await page.evaluate(() => document.documentElement.dataset.eyeView || null).catch(() => null);
        const text = `Board view: ${what}${shown ? ` — camera showed world rect ${shown}` : ''}. ${VIEW.width}x${VIEW.height} px. `
          + (degraded ? '（页面迟迟等不到稳定帧，这是超时后直接抓的当前帧，动画中的东西可能停在半途。）' : '')
          + 'Half-transparent items are still staging. Lines: red with pins = yarn, wobbly = pencil, plain = ink.';
        return { content: [{ type: 'text', text }, { type: 'image', data, mimeType: 'image/png' }] };
      } catch (e) {
        return err(`look_at_board failed: ${String(e?.message || e).slice(0, 200)}`);
      } finally {
        try { await browser?.close(); } catch { /* noop */ }
      }
      });
    },
  );
}
