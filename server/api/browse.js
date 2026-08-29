/**
 * server/api/browse.js — 桌面上那张浏览器卡片背后的三个端点（2026-08-18）
 *
 * ## GET /api/projects/:pid/browse → { live, url, title, at, busy, help }
 *
 * 「现在是什么状况」。为什么需要：浏览器窗原来完全由一次性的
 * `run.browser_opened` / `run.browser_help` 事件驱动，于是刷新一下页面：
 *   - 窗没了，而且没有任何入口能再把它开出来；
 *   - 如果 agent 正举着手等人过验证码，**用户从头到尾看不见它举手**，
 *     两分钟后 agent 超时、告诉用户"这个站过不去"——一次白等。
 *
 * `live` 是**进程内的瞬态事实**（浏览器活着就是活着，pm2 重启就没了）；
 * `url/title/at` 来自落盘的 `.browser/state.json`，所以**浏览器被空闲回收之后
 * 卡片还在**，还知道上次停在哪一页。两种性质混在一个响应里是刻意的：
 * 前端要的就是"卡上写什么"+"点进去有没有活画面"。
 *
 * ⚠️ 桌面上那张浏览器卡也吃这个响应，**刻意不塞进 `/artifacts`**：那条是磁盘扫描
 * 的结果（"工作区里有哪些文件"），而浏览器卡的真相在进程里。混进去的话每次列
 * 产物都要多一次 stat + 读 json，而且会给人一种"它是一份产物"的错觉 —— 它不是。
 *
 * ## GET …/browse/preview → image/webp
 *
 * 卡片上那块预览 = **上次看到的样子**（跟 word 卡的页图同一路数）。
 * ⭐ 活着且空闲时现截一张（顺手把缓存也刷新）；否则回上次那张；都没有 → 204。
 * ⚠️ **不走 `withBrowser`**：那把锁是给 agent 的，画布刷张缩略图不该排在
 * agent 的导航后面、更不该让 agent 排在缩略图后面。用 `peek` 直接截，
 * 撞上 agent 正在导航就抛错 —— 抛了就回缓存，无所谓。
 *
 * ## DELETE …/browse → 关实例 + 删痕迹（卡片消失，profile 留着）
 *
 * ## POST …/browse/open → { live, url, title }
 *
 * **用户主动进去**。这是「随时能进」的那条路：浏览器空闲 5 分钟被回收之后，
 * 卡还在，双击它就走这里把浏览器起回来、回到上次那一页。
 * 地址只接受两种来源：落盘状态里的 url，或者请求里给的 url——后者照样过出网闸。
 *
 * ⚠️ 这里刻意允许"用户起浏览器"，而 WS 画面通道刻意**不允许**（那边用 `peek`，
 * 理由是别让看客占掉 1 vCPU 上的常驻名额）。区别是意图：订阅画面是被动看，
 * 双击卡片是明确要用。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { browseState, peek, withBrowser, touchProject, closeFor, _limits } from '../engine/browse/registry.js';
import { pendingHelp } from '../engine/browse/handover.js';
import { readVisit, readFrame, saveFrame, recordVisit, forgetVisit } from '../engine/browse/state.js';
import { browseCard } from '../engine/browse/card.js';
import { checkUrl } from '../lib/ssrf-guard.js';
import { msg } from '../shared/messages.js';

const router = express.Router();

/** 现截一张的最小间隔 —— 画布会重复问，1 vCPU 上截图要 0.2~4 秒 */
const RESHOOT_MS = 8000;
const lastShot = new Map();

router.get('/:pid/browse', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const pid = req.params.pid;
    const help = pendingHelp(pid);
    // card = 桌面那张卡要的一切（逛过站才非 null）；help 只有窗要
    const card = await browseCard(pid);
    res.json({ live: false, url: null, title: null, at: null, busy: false,
      ...(card || {}), help: help ? help.reason : null });
  } catch (err) { next(err); }
});

router.get('/:pid/browse/preview', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const pid = req.params.pid;
    const live = peek(pid);
    const state = browseState(pid);
    const stale = (Date.now() - (lastShot.get(pid) || 0)) > RESHOOT_MS;
    if (live && !state.busy && stale) {
      lastShot.set(pid, Date.now());
      try {
        const buf = await live.page.screenshot({ type: 'png', fullPage: false, timeout: 8000 });
        await saveFrame(pid, buf);
      } catch { /* agent 正在导航之类 —— 回缓存那张就好 */ }
    }
    const frame = await readFrame(pid);
    if (!frame) return res.status(204).end();
    res.set('Content-Type', 'image/webp');
    // 会变的东西不许缓存：卡片要看到 agent 刚翻到的那一页
    res.set('Cache-Control', 'no-store');
    res.set('Last-Modified', frame.mtime.toUTCString());
    res.end(frame.buf);
  } catch (err) { next(err); }
});

router.post('/:pid/browse/open', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const pid = req.params.pid;
    const visit = await readVisit(pid);
    const want = String(req.body?.url || visit?.url || '');
    if (!/^https?:\/\//i.test(want)) {
      return res.status(400).json({ error: msg(req, '没有可打开的地址（这个项目还没逛过任何站）') });
    }
    // 用户点的也过闸 —— 闸是硬边界，不因为"是人点的"就放行
    const pre = await checkUrl(want);
    if (!pre.ok) return res.status(403).json({ error: msg(req, '网络闸拒了这个地址：{reason}', { reason: pre.reason }) });

    const out = await withBrowser(pid, async ({ page }) => {
      if (page.url() !== want) {
        await page.goto(want, { timeout: _limits.NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      }
      await recordVisit(pid, page);
      return { url: page.url(), title: await page.title().catch(() => '') };
    });
    touchProject(pid);
    res.json({ live: true, ...out });
  } catch (err) {
    // 常驻名额满了是 503（registry 抛的），照原样告诉用户，别静默排队
    if (err?.status === 503) return res.status(503).json({ error: err.message });
    next(err);
  }
});

/**
 * DELETE …/browse —— 「这张卡我不看了」。
 *
 * 关掉活实例 + 删掉浏览痕迹（卡片消失）。**profile 留着** —— 用户是在收拾桌面，
 * 不是要退出在那个站的登录；下次 agent 再逛同一个站还是登录状态。
 */
router.delete('/:pid/browse', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const pid = req.params.pid;
    await closeFor(pid, 'user dismissed the card');
    await forgetVisit(pid);
    lastShot.delete(pid);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
