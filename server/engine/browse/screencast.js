/**
 * server/engine/browse/screencast.js — 把 agent 的浏览器画面推给用户（2026-08-18）
 *
 * 用户要的形态：「**用通用显示器来播放 agent 当前浏览器操作画面，必要时人类可以
 * 协助 agent**」。这个模块是那条像素通路加上行输入。
 *
 * ## 为什么是 CDP screencast（而不是轮询截图）
 *
 * ⭐ **screencast 是 damage-driven**（实测）：页面静止时 30 秒只发 1 帧、0.1% 单核；
 * 一次 DOM 改动 = 一帧。所以代价全在「页面在动 + 有人看」，静止时近乎免费。
 * 周期性 `page.screenshot()` 轮询正好丢掉这个免费午餐 —— 页面动不动都要编码一张，
 * 在 1 vCPU 上更差。
 *
 * ## 1 vCPU 上的账（⚠️ 实测纠正过一次归因）
 *
 * ⚠️ **这一节我写错过一次，纠正如下。**
 *
 * 第一版量的是「动画页 + 没人订阅 85.6% / 有人订阅 86.6%」，据此写了「贵的是页面
 * 自己在动，画面流几乎免费」。两处都错：
 *   - 基线**本来就吃满核了**（只剩 ~14pp 余量），推流的成本被天花板挡住
 *   - 用的是 `ps` 的 `pcpu`，那是进程**生命周期平均值**，量不出增量
 *
 * 改用 `/proc` 的 utime+stime 差分 + 稳态等待，在**有余量**的页面上量两次：
 *
 *   小元素每 100ms 变一次：基线 1.3% → 订阅中 7.6% → 退订 1.8%（漂移 0.5pp）
 *       → 净成本 **+6.0pp @ 2.0 fps**
 *   小元素 rAF 每帧变：    基线 4.0% → 订阅中 43.5% → 退订 4.1%（漂移 0.2pp）
 *       → 净成本 **+39.4pp @ 12.2 fps**
 *
 * 两点独立，每 fps 约 **3.1pp 单核**。所以：**满帧推流要吃掉约 40% 单核**，
 * `MAX_ACTIVE = 1` 恰恰是唯一能把这个核还回来的刹车 —— 不是"便宜无害的装饰"。
 * （待考虑没做：没人看时用 `Emulation.setVirtualTimePolicy` 把页面本身冻住，
 *  能再省下页面动画那部分，但有些页面 resume 会坏，要真跑一批站才敢上。）
 *
 * 三道刹车：
 * 1. **帧率硬压**：`everyNthFrame=5`（60fps 动画 → ~12fps）、`quality=45`、`maxWidth=1024`
 * 2. ⭐ **ack 门控背压**：CDP 的 screencast 是 ack 驱动的 —— 只在 socket 没堵
 *    （`bufferedAmount` 低于阈值）时才 `screencastFrameAck`。socket 堵住就不 ack，
 *    chromium 自然停发下一帧。**把"没人接得住"直接变成"不生产"**，不丢帧也不排队膨胀。
 * 3. **没人看就停**：最后一个订阅者断开 → 立刻 `stopScreencast`，不等浏览器空闲回收。
 *    同时活跃画面流全局 ≤1（**这条是 CPU 定的，不是内存**）。
 */

import { profile } from '../../runtime/profile.js';

/**
 * 帧参数 —— **按 profile 分两档**（09-08 桌面版改走 CDP 连续帧时拆开的）。
 *
 * 上面文件头那三道刹车全是给**托管版那台 1 vCPU 机器**定的：满帧推流吃掉约 40% 单核、
 * 每 fps 约 3.1pp。那些数在托管版仍然成立，一个都没动。
 *
 * 桌面版的量纲完全不同：
 *   · 帧不过网 —— 服务端和浏览器在同一台机器上，走 localhost
 *   · 核不是 1 个，是用户自己的 PC
 *   · 看的人只有他自己，不存在多个订阅者抢一路流
 *
 * 所以本地档把三个旋钮全松开：`everyNthFrame: 1`（**这就是上限 —— CDP 没有 fps 这个
 * 参数**，帧率由页面自己产帧的速度和 ack 往返决定，设不出 60，只能尽力）、
 * quality 45 → 82、画幅 1024 → 1366（跟视图 viewport 一致，不再降采样）。
 *
 * ⚠️ 两笔 localhost 抹不平的成本，别指望跟原生视图一样：JPEG 编解码的 CPU，
 * 以及负载下的丢帧（滚动和视频最明显）。要再高就不是 JPEG 能解决的了。
 */
const CAST_HOSTED = { format: 'jpeg', quality: 45, maxWidth: 1024, maxHeight: 700, everyNthFrame: 5 };
const CAST_LOCAL = { format: 'jpeg', quality: 82, maxWidth: 1366, maxHeight: 768, everyNthFrame: 1 };
const CAST = profile.isLocal ? CAST_LOCAL : CAST_HOSTED;
/** socket 里积压超过这个就不再 ack（= 让 chromium 停发） */
const BACKPRESSURE_BYTES = 256 * 1024;
/** 全局同时只允许一路活跃画面流。**这是 CPU 的主要保护**：满帧推流约 40% 单核
 * （见文件头的实测），这台机器只有一个核。 */
const MAX_ACTIVE = 1;

/** projectId → { page, cdp, subs:Set<ws>, meta } */
const casts = new Map();

function activeCount() {
  let n = 0;
  for (const c of casts.values()) if (c.subs.size) n += 1;
  return n;
}

/**
 * 让某个 socket 订阅某项目的画面。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
let subscribing = false;   // 绕过二的锁，见下

export async function subscribe(projectId, ws, page) {
  let cast = casts.get(projectId);
  // ⛔ **上限检查要在"这一路要不要开始编码"上判，不是在"有没有这个条目"上判**
  // （审查攻出来的两个绕过）：
  //   ① 退订只清 subs、**不删 casts 里的条目**，于是"再订一次"会走进 `cast` 已存在
  //      那一支，整个跳过上限检查 —— 两路同时推流。
  //   ② 检查之后紧跟着 await（建 CDP 会话），两个并发 subscribe 都能过。
  const willStartCasting = !cast || !cast.casting;
  if (willStartCasting) {
    if (subscribing) {
      return { ok: false, reason: '另一路画面正在建立，稍等一下再打开这扇窗。' };
    }
    if (activeCount() >= MAX_ACTIVE) {
      // ⚠️ 这个上限是**全机器**的（CPU 是全机器的），所以占着它的那一路很可能
      // 属于**别的项目、甚至别的用户**。原来的话术是"先关掉另一扇浏览器窗"，
      // 那扇窗他既看不见也关不掉 —— 一句让人白忙的假指令。说实话就行。
      const mine = casts.get(projectId)?.subs?.size ? '（就是这个项目自己的那扇）' : '（在别的会话里，你看不到也关不掉）';
      return { ok: false, reason: `这台机器同时只能推一路浏览器画面，现在有一路在跑${mine}。`
        + '满帧推流约吃 40% 个核（实测），而这里只有 1 个核。等那边看完再打开，'
        + '或者让 agent 用截图代替实时画面。' };
    }
    subscribing = true;
  }
  try {
  if (!cast) {
    const cdp = await page.context().newCDPSession(page);
    cast = { projectId, page, cdp, subs: new Set(), meta: null, casting: false };
    casts.set(projectId, cast);

    cdp.on('Page.screencastFrame', (ev) => {
      cast.meta = ev.metadata;   // 里面有 deviceWidth/deviceHeight —— 接手时坐标换算要用
      const buf = Buffer.from(ev.data, 'base64');
      let anyoneKeepingUp = false;
      for (const sock of cast.subs) {
        if (sock.readyState !== 1) continue;
        // ⭐ 堵住的 socket 直接跳过这一帧（画面会掉帧，但不会积压）
        if (sock.bufferedAmount > BACKPRESSURE_BYTES) continue;
        anyoneKeepingUp = true;
        try { sock.send(buf, { binary: true, compress: false }); } catch { /* 下一帧再说 */ }
      }
      // ack 决定 chromium 发不发下一帧：没人接得住就不 ack = 不生产
      if (anyoneKeepingUp) {
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      } else {
        // 留一条慢速心跳，免得所有人都堵住之后再也不恢复
        setTimeout(() => {
          cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
        }, 500).unref?.();
      }
    });
  }

  cast.subs.add(ws);
  if (!cast.casting) {
    await cast.cdp.send('Page.startScreencast', CAST);
    cast.casting = true;
    // ⭐ 立刻补一帧。screencast 是 damage-driven —— 静止页面订阅之后可能**一帧都不发**，
    // 用户看到的是一扇全白的窗，而它其实是"连上了但页面没动"。
    // 这条是审查锐化出来的：接手功能在静止页面上由构造决定会失败（窗白着没法点）。
    try {
      const shot = await cast.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: CAST.quality });
      const buf = Buffer.from(shot.data, 'base64');
      for (const sock of cast.subs) {
        if (sock.readyState === 1) sock.send(buf, { binary: true, compress: false });
      }
    } catch { /* 补不上就等页面自己动 */ }
  }
  return { ok: true };
  } finally {
    if (willStartCasting) subscribing = false;
  }
}

/** 退订。最后一个人走了就停止编码。 */
export async function unsubscribe(projectId, ws) {
  const cast = casts.get(projectId);
  if (!cast) return;
  cast.subs.delete(ws);
  if (cast.subs.size) return;
  if (cast.casting) {
    await cast.cdp.send('Page.stopScreencast').catch(() => {});
    cast.casting = false;
  }
  // 条目留着也没用（下次订阅要重新 startScreencast），而留着正好造出上面那个
  // "跳过上限检查"的绕过。删掉 —— `activeCount()` 数的是"有订阅者的路"，
  // 但少一个空壳条目也少一处可以钻的缝。
  casts.delete(projectId);
}

/** 浏览器被关掉时（空闲回收 / LRU 淘汰）把这一路彻底忘掉 */
export function forget(projectId) {
  const cast = casts.get(projectId);
  if (!cast) return;
  casts.delete(projectId);
  for (const sock of cast.subs) {
    try { sock.send(JSON.stringify({ type: 'closed', reason: 'browser was shut down' })); } catch { /* */ }
  }
}

/** 当前帧的设备像素尺寸 —— 接手时前端坐标要按它换算 */
export function frameMeta(projectId) {
  return casts.get(projectId)?.meta ?? null;
}

