/**
 * server/ws/browse-channel.js — 浏览器画面/输入的专用 WS 通道（2026-08-18）
 *
 * 路径 `/ws/projects/:pid/browser`。**跟现有 `/ws/projects/:pid` 刻意分开**，
 * 理由是那条通道的性质完全不同：
 *
 * - 现有通道是**纯下行**（服务端没有任何 `ws.on('message')`）、走 per-project
 *   EventBus 广播、**带 2000 条重放缓冲 + hydrate 分片**。
 *   高频画面帧灌进去会**冲爆重放缓冲**、混进 hydrate 回放。
 * - 而且那条通道是 JSON 文本帧 + perMessageDeflate：base64 一张 JPEG 先胖 33%，
 *   再让 zlib 白压一遍（JPEG 压不动）。
 *
 * 这条通道：**二进制帧下行**（无 base64、`compress:false`）、per-connection 直发
 * （只发给开着窗的那条 socket）、**上行**收订阅控制与人接手的输入。
 *
 * 低频信号（agent 求助、窗该开了）仍然走**现有** EventBus —— 它天生适合那种
 * switch-case 路由。像素和输入才走这里。
 */

import { WebSocketServer } from 'ws';
import { requestUser } from '../auth/session.js';
import { originAllowed } from '../auth/origin-guard.js';
import { userOwnsProject } from '../api/_guard.js';
import { getProject, validateProjectId } from '../projects/store.js';
import { peek, touchProject, _limits } from '../engine/browse/registry.js';

const { VIEWPORT } = _limits;
import { subscribe, unsubscribe, frameMeta } from '../engine/browse/screencast.js';
import { releaseHelp, pendingHelp } from '../engine/browse/handover.js';

export const BROWSE_WS_RE = /^\/ws\/projects\/([^/]+)\/browser$/;

/** 接手时人的输入 → CDP。坐标从"canvas 上的比例"换算成设备像素。 */
async function dispatchInput(page, projectId, msg) {
  const cdp = await page.context().newCDPSession(page);
  const meta = frameMeta(projectId);
  // 前端发的是 0..1 的比例（它比谁都清楚自己那块 canvas 多大），服务端换算成
  // **页面 CSS 像素** —— CDP 的 Input 坐标系是页面视口，不是 screencast 那张图。
  // ⚠️ 兜底值原来写的是 CAST 的 maxWidth/maxHeight（1024×700），那是**图**的上限、
  // 不是页面的尺寸 —— meta 还没到手时点击会全部偏掉（审查实测点中错元素）。
  // 兜底要用真实视口（registry 的 VIEWPORT）。
  const w = meta?.deviceWidth || VIEWPORT.width;
  const h = meta?.deviceHeight || VIEWPORT.height;
  const x = Math.round((msg.rx ?? 0) * w);
  const y = Math.round((msg.ry ?? 0) * h);

  if (msg.kind === 'click') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return;
  }
  if (msg.kind === 'move') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return;
  }
  if (msg.kind === 'wheel') {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: msg.dx || 0, deltaY: msg.dy || 0,
    });
    return;
  }
  if (msg.kind === 'key') {
    // ⚠️ Phase 1 只支持可打印字符与几个功能键。中文输入法要按 composer 那套
    // isIme 判定处理（chat-composer-fixes 的教训），留 Phase 2 —— 现在人要输中文
    // 请直接在自己浏览器里操作，别指望这条通道。
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (text) {
      await cdp.send('Input.insertText', { text });
      return;
    }
    const key = msg.key;
    if (!key) return;
    // ⚠️ **必须给 windowsVirtualKeyCode**。原来是 `msg.code || 0`，而前端不发 code ——
    // 恒等于 0 的话回车、退格、Tab 全部没反应（审查实测：登录表单提交不了、
    // 删不掉字），而人接手最常要做的就是这几个键。
    const VK = {
      Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
    };
    const vk = msg.code || VK[key] || 0;
    const common = { key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code: key };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    // 回车/Tab 这些在很多表单上要 char 事件才触发默认行为
    if (key === 'Enter') await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...common });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }
}

function handleConn(ws, pid) {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* */ } };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const live = peek(pid);

    try {
      if (msg.type === 'subscribe') {
        if (!live) return send({ type: 'idle', reason: 'agent 还没开始浏览（没有常驻浏览器）' });
        // 桌面版共视（09-08）：页面是 Electron 原生视图，不要帧 —— 只要状态和地址。截帧编码是纯浪费
        if (msg.native) { touchProject(pid); return send({ type: 'subscribed', url: live.page.url(), native: true }); }
        const r = await subscribe(pid, ws, live.page);
        if (r.ok) touchProject(pid);
        return send(r.ok ? { type: 'subscribed', url: live.page.url() } : { type: 'error', reason: r.reason });
      }
      if (msg.type === 'unsubscribe') return void unsubscribe(pid, ws);
      if (msg.type === 'input') {
        if (!live) return send({ type: 'idle', reason: '浏览器已经关了' });
        // 人的每一次输入都算"用过" —— 空闲计时器只认 agent 的调用，不认这条通道，
        // 于是安静看五分钟会被在眼前关掉
        touchProject(pid);
        await dispatchInput(live.page, pid, msg);
        return;
      }
      if (msg.type === 'nav') {
        // 人接手时的后退/刷新。⚠️ **不提供"输入地址"** —— 那等于给人开一条绕过
        // 出网闸的入口的错觉（其实闸在网络层照样拦，但不如不提供这个入口）。
        if (!live) return send({ type: 'idle', reason: '浏览器已经关了' });
        touchProject(pid);
        if (msg.action === 'back') await live.page.goBack({ timeout: 15000 }).catch(() => {});
        if (msg.action === 'reload') await live.page.reload({ timeout: 20000 }).catch(() => {});
        return send({ type: 'url', url: live.page.url() });
      }
      if (msg.type === 'release') {
        // 人点了「好了继续」→ 把等着的 agent 放走
        releaseHelp(pid, { url: live ? live.page.url() : null, by: 'human' });
        return send({ type: 'released' });
      }
    } catch (err) {
      send({ type: 'error', reason: err?.message || String(err) });
    }
  });

  const bye = () => { unsubscribe(pid, ws).catch(() => {}); };
  ws.on('close', bye);
  ws.on('error', bye);
  // ⭐ hello 要带上「agent 是不是正举着手」：求助 banner 原来只由一次性的
  // `run.browser_help` 事件驱动，**刷新一下就失传** —— 于是 agent 在那儿等两分钟、
  // 超时、告诉用户"这站过不去"，而用户从头到尾没看见过它举手。
  const help = pendingHelp(pid);
  send({ type: 'hello', hasBrowser: !!peek(pid), help: help ? help.reason : null });
}

/**
 * 挂在现有 httpServer 的 upgrade 分支上。
 * ⚠️ 现有 upgrade handler 对不匹配的路径**直接 404**，所以这条分支必须排在它前面。
 * @returns {{ matches: (pathname: string) => RegExpMatchArray|null, accept: Function }}
 */
export function createBrowseWS() {
  const wss = new WebSocketServer({ noServer: true });

  return {
    matches: (pathname) => pathname.match(BROWSE_WS_RE),
    accept(req, socket, head, m) {
      // 上游 upgrade 已经拦过一道；这里再拦是因为闸不该靠「谁先调用谁」成立
      // —— 这条通道自带 WebSocketServer，将来换挂载点也不能失守
      if (!originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const pid = decodeURIComponent(m[1]);
      try { validateProjectId(pid); } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        return socket.destroy();
      }
      // 鉴权跟主通道同一套，也同一个 4401（外人不该分得清"没登录"和"不是你的项目"）
      const user = requestUser(req);
      const project = getProject(pid);
      if (!user || !userOwnsProject(user, project)) {
        return wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'unauthorized'));
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.binaryType = 'nodebuffer';
        handleConn(ws, pid);
      });
    },
  };
}
