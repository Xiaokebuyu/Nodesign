/**
 * useViewpointReport —— 把「用户此刻在看哪」告诉服务端（2026-08-23 黑板）
 *
 * 服务端在这之前对相机、开着的窗、选中集一无所知，agent 只能猜「这个」指什么。
 * 这个 hook 把视口的世界矩形 + 缩放 + 当前文件夹层 + 开着的窗 + 选中集按节流
 * POST 上去（只在变化时发，最快 1.2s 一次）。fire-and-forget：失败不打扰用户。
 *
 * 相机模型：屏幕 = (世界 + cam.xy) * cam.z，所以可见世界矩形左上 = (-cam.x, -cam.y)，
 * 宽高 = 视口 / z。
 *
 * 眼睛模式（?eye=1，agent 的 look_at_board 开的那一页）**不上报**：那不是用户在看。
 *
 * ## 2026-08-28：连「你在什么机器上」一起报
 *
 * 服务端本来能从 `camera.w × zoom` 反推出屏幕像素（sketch-layout 的 fitFor 就在
 * 这么干），但那个数**推不出档位**：它分不清「390 宽的手机」和「用户把桌面窗口
 * 拖窄了」，更看不见有没有 hover。而 agent 要据此改摆位和尺寸 —— 判错一档，
 * 手机用户就会收到一块 1700 宽、要横着滑四屏才读得完的板书。
 *
 * ⭐ 所以档位在**浏览器这边判一次**（lib/device-class.js）然后报上去，服务端不
 * 自己再算一遍。真屏幕多大、是不是手指，只有浏览器知道；一件事一个真相源。
 */
import { useEffect, useRef } from 'react';
import { Assets } from '../../lib/api.js';
import { useDeviceEnv } from '../../lib/device-class.js';

const MIN_INTERVAL_MS = 1200;

export function useViewpointReport({ projectId, cam, viewport, layer = '', openWindow = null, selectedIds = [], occupied = [], enabled = true }) {
  const lastRef = useRef({ key: '', at: 0, timer: null });
  const device = useDeviceEnv();
  useEffect(() => {
    if (!enabled || !projectId || !viewport?.w || !viewport?.h || !cam) return undefined;
    const z = cam.z || 1;
    const camera = {
      x: Math.round(-cam.x), y: Math.round(-cam.y),
      w: Math.round(viewport.w / z), h: Math.round(viewport.h / z),
    };
    const payload = {
      camera, zoom: Math.round(z * 100) / 100, layer: layer || '',
      openWindow: openWindow || null,
      selected: (selectedIds || []).slice(0, 24),
      // 只有浏览器知道的占地（2026-09-05）：生图幻影 —— 服务端落位要躲它
      occupied: (occupied || []).slice(0, 24).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })),
      device: { class: device.class, w: device.w, h: device.h, dpr: device.dpr, coarse: device.coarse },
    };
    const occKey = payload.occupied.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(';');
    // 变化判据：相机挪超过 1/8 视口、缩放变、窗/选中变、换机器/转屏、幻影增减
    const key = `${Math.round(camera.x / Math.max(1, camera.w / 8))}:${Math.round(camera.y / Math.max(1, camera.h / 8))}:${payload.zoom}:${payload.layer}:${payload.openWindow}:${payload.selected.join(',')}:${device.class}:${device.w}x${device.h}:${occKey}`;
    const st = lastRef.current;
    if (key === st.key) return undefined;
    const send = () => {
      st.key = key; st.at = Date.now(); st.timer = null;
      Assets.reportViewpoint(projectId, payload).catch(() => { /* 视点丢一拍无所谓 */ });
    };
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - st.at));
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(send, wait);
    return () => { if (st.timer) { clearTimeout(st.timer); st.timer = null; } };
  }, [enabled, projectId, cam?.x, cam?.y, cam?.z, viewport?.w, viewport?.h, layer, openWindow, selectedIds, device, occupied]);
}
