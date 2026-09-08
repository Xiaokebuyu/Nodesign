/**
 * server/engine/browse/registry.js — 常驻浏览器登记处（2026-08-18）
 *
 * agent 用浏览器看设计参考这条线的本体。**进程级单例，按 projectId 键。**
 *
 * ## 为什么是常驻，为什么按项目键
 *
 * 在这之前所有浏览器工具都是 launch→用→close 即弃（`screenshot-url.js` 那套），
 * 所以**没有会话**：点不了链接、翻不了子页、登录态留不住、Cookie 同意弹窗每次重新
 * 弹，想看第三层页面只能猜 URL。用户要的正是这条：让 agent 能真的**逛**。
 *
 * 键按 **projectId**（用户拍板）：项目 owner 唯一，所以这等于 per-user per-project；
 * 登录态天然跨会话复用 —— 用户的原话是「**此后**从浏览器中获得的可复用内容」，
 * 那个"此后"包含下一次开新对话。
 *
 * ## 这台机器只有 1 vCPU，所以每条约束都是硬的
 *
 * - 常驻浏览器 **≤ 2**：空闲实测 185 MiB PSS / 0.1% CPU，内存不是矛盾，但超了就
 *   按 LRU 关最久没用的**空闲**那个；一个都腾不出来就**拒绝并告诉 agent**，
 *   不静默排队（静默降级是这个仓库的老账）
 * - 同项目的调用走 **mutex 串行**：同一个项目可能同时开着两个会话，两个 agent 抢
 *   一个 page 会互相把对方导航走
 * - 空闲 5 分钟回收（保留 profile）。timer `.unref()` —— 别让它拖着进程不退出
 *
 * ## 跟感知通道刻意分开的两条通道
 *
 * `perception-page.js` 的 `launchPerceptionBrowser` 是**感知通道**：URL 由我们构造
 * （artifact-file loopback）、允许 loopback、用完即弃。这里是**浏览通道**：URL 由
 * agent 自由指定、**loopback 一律禁**（SSRF 闸）、常驻带持久 profile。
 * 两个函数并排放着而不是合成一个带 flag 的 —— 「同一件东西有多个实例」的反面是
 * 「两件不同的东西硬塞进一个函数」，安全语义会被 flag 搅浑。共享的只有
 * `FIDELITY_LAUNCH_ARGS` 那一份常量。
 */

import path from 'node:path';
import { mutex } from 'async-mutex-lite';
import { getProjectWorkspace } from '../../projects/workspace.js';
import { FIDELITY_LAUNCH_ARGS } from '../mcp/tools/helpers/perception-page.js';
import { attachSsrfGuard } from '../../lib/ssrf-guard.js';
import { startBrowseProxy } from '../../lib/browse-proxy.js';
import { attachPageLog } from './page-log.js';
import { desktopHostConfigured, openDesktopView, closeDesktopView } from './desktop-host.js';

/**
 * 常驻上限（内存）。1 vCPU 上活跃画面流另有 ≤1 的上限，见 screencast 那一层。
 *
 * ⚠️ 写法要 NaN-safe：`Number('yes')` 是 NaN，而 `live.size >= NaN` **恒为 false**
 * → 上限静默消失，chromium 无限起。这台机器 1 核 8G **无 swap**，尖峰直接进
 * 内核 OOM killer。（隔壁 IDLE_MS 用的 `|| 默认` 写法本来就是 NaN-safe 的。）
 */
const MAX_RESIDENT = Number(process.env.ND_BROWSE_MAX) > 0
  ? Math.floor(Number(process.env.ND_BROWSE_MAX)) : 2;
/** 空闲多久回收。仿 h3box 的 ControlPersist=600 与 WS grace 的思路。 */
const IDLE_MS = Number(process.env.ND_BROWSE_IDLE_MS || 0) || 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;

/**
 * 视口：桌面宽（看设计参考要的是版面不是移动端），**且坐标 1:1**。
 * 08-21 从 1440×900 改 1366×768：改的时候 shot-pipeline 阈值还是 1568/1.15MP，1440×900=1.30MP
 * 会被缩 0.94 倍 → browser_computer 从图上读的坐标和页面像素差 6%。同日阈值抬到 2000px/3.75MP
 * 后 1440×900 其实也不缩了，但 1366×768 留着：便宜（≈1372 token/张）、是文档推荐档、坐标 1:1。
 * 也是 Anthropic computer-use 文档给 web 应用推荐的档位。改它要连 browse-computer.test.js
 * 的"视口在阈值内"断言一起过。
 */
const VIEWPORT = { width: 1366, height: 768 };

/** projectId → entry */
const live = new Map();

/**
 * ⭐ 把 UA 里的 HeadlessChrome 换成 Chrome。
 *
 * 依据是一篇受控实验（arXiv:2606.14525，Tranco Top 10K × 4 万次抓取）：在「只有
 * headless 被封」的 784 个站上，**仅仅**把 UA 与 Client Hints 里的 `HeadlessChrome`
 * 换成 `Chrome`，590 个（**75%**）当场转 HTTP 2xx。也就是说 headed 相对 headless
 * 那 8 个百分点的优势，四分之三来自这个头部信号 —— 不是「headed 本身更像人」。
 * 所以我们不装 Xvfb（1 vCPU 付不起一颗核，而且 headed vs **新** headless 全世界
 * 没人测过），改这个字符串就吃满大头。
 *
 * ⚠️ 这不是为了绕强反爬（数据中心 IP 是改不掉的底噪，最凶的墙怎么配都拦 ——
 * 那是「人接手」存在的理由）。这是为了不在最脏的一档上白挨拦。
 */
function chromeUa(raw) {
  return String(raw).replace(/HeadlessChrome\//g, 'Chrome/');
}

/**
 * 桌面版（09-08 缝二）：页面住在 Electron 的 WebContentsView 里，这里只拿到它的 playwright page。
 * 跟下面 headless 那条的差别：不 launch、闸只装在这一页（context 是整个应用共用的）、关的时候销视图不关 context。
 */
async function attachDesktopView(projectId) {
  const { port: proxyPort } = await startBrowseProxy();
  const { page, context, viewId, cdp } = await openDesktopView(projectId, { proxyPort, viewport: VIEWPORT });
  const guard = await attachSsrfGuard(context, undefined, { proxied: true, scope: 'page' });
  await guard.armPage(page);
  guard.watchPopups(page);
  const realUa = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const ua = chromeUa(realUa.replace(/\s*Electron\/\S+/, '').replace(/\s*nodesign\/\S+/i, ''));
  const m = realUa.match(/Chrome\/(\d+)/);
  const major = m ? m[1] : '133';
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    userAgentMetadata: { brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not?A_Brand', version: '24' }], fullVersion: `${major}.0.0.0`, platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false },
  }).catch(() => { /* 覆盖不上就用 Electron 自己的 UA */ });
  return { context, page, guard, ua, desktopViewId: viewId };
}

async function launchBrowseBrowser(projectId) {
  if (desktopHostConfigured()) return attachDesktopView(projectId);
  const { chromium } = await import('playwright');
  // profile 必须落在 `<pid>/` 下、`shared/` **之外**：shared 是 agent 的 cwd 也是
  // artifact-file 的服务根 —— 放进去等于 (a) cookie jar 能被当文件服出去
  // (b) agent 能 Read 到自己的 cookie (c) 进 per-project git。
  // 放兄弟位就都避开了，而且删项目时 removeProjectWorkspace 删的是整个 `<pid>/`
  // （核过），profile 跟着走，不用额外写清理。
  const userDataDir = path.join(getProjectWorkspace(projectId), '.browser', 'default');

  // ⭐ 出网闸在**代理层**（2026-08-18 第二遍）：`--proxy-server` 之后 chromium 的
  // 每一次连接都从这儿走 —— 包括 CDP 的 Fetch 阶段看不见的那些（WebSocket 握手、
  // `<link rel=prefetch>`、sendBeacon、还没装上闸的弹窗）。理由与实测见
  // lib/browse-proxy.js 文件头。CDP 那道闸保留当纵深，不再是唯一一道。
  // ⚠️ `bypass: ''` 是必须的：默认会放过 loopback，那正好是我们最要拦的。
  const { port: proxyPort } = await startBrowseProxy();

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',            // ⭐ 不是默认的 headless_shell，见 chromeUa 的注释
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '' },
    // ⭐ WebRTC 是代理**看不见**的那条路：它走 UDP，不经 HTTP 代理，能被用来
    // 探内网存活（STUN 打内网地址）。看设计参考完全不需要 WebRTC，所以直接
    // 掐掉非代理 UDP —— 这是 Chromium 官方给的那个开关，不是我们发明的。
    args: [...FIDELITY_LAUNCH_ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    viewport: VIEWPORT,
    locale: 'zh-CN',                // 面向中文用户；顺带摆脱默认的 en-US@posix 那种怪指纹
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: false,         // 下载不是这条线要的，而且是一条额外的写盘面
  });

  // proxied: true —— 第二道（连上后看对端 IP）在代理下是纯冗余，而且会把每个页面
  // 都误杀（代理自己就是 127.0.0.1）。第一道（Fetch 阶段）保留当纵深。
  const guard = await attachSsrfGuard(context, undefined, { proxied: true });
  // 持久 context 自带一个空白页；没有就造一个
  const page = context.pages()[0] || await context.newPage();
  await guard.armPage(page);        // ⭐ 必须 await 完才允许导航（竞态是攻出来的）

  // UA 与 Client Hints 一起改 —— 只改 UA 字符串的话 sec-ch-ua 还在报 headless
  const cdp = await context.newCDPSession(page);
  const realUa = await page.evaluate(() => navigator.userAgent);
  const ua = chromeUa(realUa);
  const m = realUa.match(/Chrome\/(\d+)/);
  const major = m ? m[1] : '147';
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: ua,
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    platform: 'Linux x86_64',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not?A_Brand', version: '24' },
      ],
      fullVersion: `${major}.0.0.0`,
      platform: 'Linux',
      platformVersion: '6.1.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    },
  }).catch(() => { /* 覆盖不上就退回只改 UA 字符串那一档，别因此起不来 */ });

  return { context, page, guard, ua };
}

function touch(entry) {
  entry.lastUsed = Date.now();
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => { closeFor(entry.projectId, 'idle').catch(() => {}); }, IDLE_MS);
  entry.idleTimer.unref?.();
}

/** 关掉某个项目的浏览器（**保留 profile** —— 登录态是资产） */
export async function closeFor(projectId, why = 'explicit') {
  const entry = live.get(projectId);
  if (!entry) return false;
  live.delete(projectId);
  clearTimeout(entry.idleTimer);
  // 先让画面流那一层知道（它要通知正在看的人，并且停掉编码），再关浏览器 ——
  // 反过来的话 CDP 会话已经死了，stopScreencast 只会抛一堆没意义的错
  try { (await import('./screencast.js')).forget(projectId); } catch { /* */ }
  // 桌面版：context 是 Electron 整个应用的，关它等于关应用 —— 只销自己那张视图
  if (entry.desktopViewId) await closeDesktopView(entry.desktopViewId);
  else { try { await entry.context.close(); } catch { /* 已经死了就算了 */ } }
  console.log(`[browse] closed ${projectId} (${why})`);
  return true;
}

/** 腾一个位子出来：按 LRU 关最久没用的**空闲**实例。@returns 腾出来了没 */
async function evictOne() {
  const idle = [...live.values()].filter(e => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  if (!idle.length) return false;
  await closeFor(idle[0].projectId, 'evicted (LRU)');
  return true;
}

/**
 * 拿到某个项目的浏览器（懒启动）。**同项目串行**。
 *
 * @param {string} projectId
 * @param {(h: {page: import('playwright').Page, guard: object, ua: string}) => Promise<any>} fn
 * @returns {Promise<any>} fn 的返回值
 * @throws 超上限时抛错，**不静默排队** —— agent 该看到"满了"这件事
 */
export async function withBrowser(projectId, fn) {
  return mutex(`browse:${projectId}`, async () => {
    let entry = live.get(projectId);
    // ⚠️ 页可能已经不在了而 entry 还在：出网闸连到坏 IP 时会 `page.close()`
    // （ssrf-guard 的 [connected] 兜底）。任意页面塞一个
    // `<link rel=prefetch href=http://127.0.0.1:4001/>` 就能让常驻页变成一具尸体，
    // 而 5 分钟空闲计时器才会清它 —— 等于给外站开了个远程杀开关。
    // 这里发现就重建（别让 agent 拿着 "Target has been closed" 猜发生了什么）。
    if (entry && entry.page.isClosed()) {
      console.log(`[browse] ${projectId} 的页已被掐（多半是出网闸），重建`);
      await closeFor(projectId, 'page was closed underneath us');
      entry = null;
    }
    if (!entry) {
      if (live.size >= MAX_RESIDENT && !(await evictOne())) {
        throw Object.assign(
          new Error(`浏览器实例已满（${live.size}/${MAX_RESIDENT} 都在用）。`
            + '等一会儿再试，或者让别的会话先收工 —— 这台机器只有 1 个 CPU 核，常驻上限是硬的。'),
          { status: 503 },
        );
      }
      const t0 = Date.now();
      const h = await launchBrowseBrowser(projectId);
      entry = { projectId, ...h, lastUsed: Date.now(), busy: false, idleTimer: null };
      live.set(projectId, entry);
      attachPageLog(projectId, entry.page);   // 诊断埋点（page-log.js）：console / pageerror / 请求失败进环形账
      console.log(`[browse] launched ${projectId} in ${Date.now() - t0}ms (${live.size}/${MAX_RESIDENT} resident)`);
    }
    entry.busy = true;
    try {
      touch(entry);
      return await fn({ page: entry.page, guard: entry.guard, ua: entry.ua, context: entry.context });
    } finally {
      entry.busy = false;
      touch(entry);   // 用完重新起计时，别让长调用被自己的旧计时器掐掉
    }
  });
}

// ⚠️ **刻意没有 onSessionEnd。** 计划里写了「会话结束时在 session-loop 的 finally
// 里关掉该项目的浏览器」，落地时否掉了，理由两条：
//   ① `active-runs` 是按 sessionId 键的，**没有「这个项目还有别的活会话吗」这个
//      查询**。同一个项目同时开两个会话是常见的（用户经常这么用），照着关就是把
//      另一个会话正在看的页面关掉。
//   ② 5 分钟空闲回收已经覆盖了"人走了"这件事，而且它按**实际使用**判，不按会话
//      生命周期判 —— 后者跟"浏览器还有没有人要用"其实不是一回事。
// 与其造一个用不上的导出摆在这儿（这个仓库有过"全仓无人写入的字段假装第一优先级"
// 那种账），不如写清为什么没有。

/**
 * 把某个项目的浏览器**钉住**：期间它不空闲、不会被 LRU 挤掉、不会被空闲计时器关。
 *
 * 为什么需要（审查抓到的）：`browser_request_help` 是在 `withBrowser` **外面**等人的
 * （它必须放开 mutex，否则人在窗里点的每一下都会排在 agent 这次调用后面 = 死锁）。
 * 于是等人的那 120 秒里 `busy` 是 false、`lastUsed` 不动 —— `evictOne` 正好挑
 * "最久没用的空闲实例"，它就是那个**人正在过验证码的浏览器**。
 *
 * @returns {() => void} 松手（幂等）
 */
export function hold(projectId, why = 'held') {
  const entry = live.get(projectId);
  if (!entry) return () => {};
  entry.busy = true;
  entry.holds = (entry.holds || 0) + 1;
  touch(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const e = live.get(projectId);
    if (!e) return;
    e.holds = Math.max(0, (e.holds || 1) - 1);
    if (!e.holds) e.busy = false;
    touch(e);            // 松手时重新起计时，别让它带着旧计时器立刻被回收
    console.log(`[browse] ${projectId} 松手（${why}）`);
  };
}

/**
 * 人在窗里动了一下 → 重置空闲计时。
 * 没有这条的话：人安静看五分钟，浏览器在他眼前被关掉（空闲计时只认 agent 的调用）。
 */
export function touchProject(projectId) {
  const entry = live.get(projectId);
  if (entry) touch(entry);
  return !!entry;
}

/**
 * 刷新页面之后拿回「现在有没有浏览器 / agent 是不是正举着手」。
 * 求助 banner 原来只靠一次性的 WS 事件，刷新即失传 —— agent 在那儿等两分钟没人知道。
 */
export function browseState(projectId) {
  const e = live.get(projectId);
  return {
    live: !!e,
    url: e ? e.page.url() : null,
    busy: e ? !!e.busy : false,
  };
}

/**
 * 拿到某项目**已经在跑**的浏览器（不懒启动）。
 * 给 WS 画面通道用：用户开窗时如果 agent 还没开始浏览，就该显示"还没开始"，
 * 而不是替 agent 起一个浏览器（那会让 1 vCPU 上的常驻名额被看客占掉）。
 */
export function peek(projectId) {
  const e = live.get(projectId);
  return e ? { page: e.page, context: e.context, guard: e.guard } : null;
}

/** 给体检/日志用 */
export function status() {
  return [...live.values()].map(e => ({
    projectId: e.projectId,
    url: (() => { try { return e.page.url(); } catch { return '(gone)'; } })(),
    idleMs: Date.now() - e.lastUsed,
    busy: e.busy,
  }));
}

export const _limits = { MAX_RESIDENT, IDLE_MS, NAV_TIMEOUT_MS, VIEWPORT };
