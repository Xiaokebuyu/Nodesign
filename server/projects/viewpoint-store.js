/**
 * server/projects/viewpoint-store.js —— 用户视点（2026-08-23 黑板）
 *
 * 服务端在这之前对「用户此刻看着哪里」一无所知：相机在哪、哪扇窗开着、选中了
 * 谁，全在前端。agent 于是只能猜「这个」「这里」指什么。前端按节流上报一份
 * 视点，这里存**每个项目最近一份**（进程内存，不落盘 —— 它是"此刻"，重启即作废）。
 *
 * 读者：read_board（小地图画视口框 + 列视口里有什么）、UserPromptSubmit 注入
 * （只报变化）、read_user_view 工具。
 *
 * 只存最近一份而不是按用户存：一个项目同时几个人看是例外不是常态，而 agent
 * 要的是"跟它说话的那个人在看哪"——发消息的人上一拍上报的视点就是它。
 * 写入带 userId，以后要拆按用户拆读法就行。
 */

const TTL_MS = 10 * 60 * 1000;   // 十分钟没上报就当离开了
const store = new Map();          // pid → viewpoint

function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function sanitizeViewpoint(raw, userId) {
  if (!raw || typeof raw !== 'object') return null;
  const cam = raw.camera && typeof raw.camera === 'object' ? raw.camera : null;
  const camera = cam ? {
    x: num(cam.x, -1e6, 1e6), y: num(cam.y, -1e6, 1e6),
    w: num(cam.w, 1, 1e5), h: num(cam.h, 1, 1e5),
  } : null;
  if (camera && Object.values(camera).some(v => v === null)) return null;
  const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : null);
  return {
    userId: userId || null,
    camera,
    zoom: num(raw.zoom, 0.01, 100),
    layer: str(raw.layer, 300) || '',
    openWindow: str(raw.openWindow, 300),
    openPage: str(raw.openPage, 120),
    selected: Array.isArray(raw.selected) ? raw.selected.filter(s => typeof s === 'string' && s.length <= 300).slice(0, 24) : [],
    at: Date.now(),
  };
}

export function setViewpoint(pid, raw, userId = null) {
  const v = sanitizeViewpoint(raw, userId);
  if (!v) return null;
  store.set(pid, v);
  return v;
}

export function getViewpoint(pid) {
  const v = store.get(pid);
  if (!v) return null;
  if (Date.now() - v.at > TTL_MS) { store.delete(pid); return null; }
  return v;
}

/** 一行人话（注入/工具共用一份措辞）。rects 可选：给了就报视口里有什么 */
export function describeViewpoint(v, rects = null) {
  if (!v) return null;
  const bits = [];
  if (v.layer) bits.push(`在文件夹「${v.layer}」里`);
  if (v.camera) {
    bits.push(`视口 (${Math.round(v.camera.x)},${Math.round(v.camera.y)}) ${Math.round(v.camera.w)}x${Math.round(v.camera.h)}${v.zoom ? ` 缩放 ${Number(v.zoom).toFixed(2)}` : ''}`);
    if (rects) {
      const c = v.camera;
      const inside = rects.filter(r => !(r.x + r.w < c.x || r.x > c.x + c.w || r.y + r.h < c.y || r.y > c.y + c.h));
      // 带坐标和占位（08-27 用户提）：agent 摆放要知道视口里谁占了哪，不该再专门调工具去问
      if (inside.length) {
        bits.push(`视口里 ${inside.length} 件（id@(x,y)宽x高）：${inside.slice(0, 12)
          .map(r => `${r.id}@(${Math.round(r.x)},${Math.round(r.y)})${Math.round(r.w)}x${Math.round(r.h)}`)
          .join('、')}${inside.length > 12 ? ' 等' : ''}`);
      } else bits.push('视口里是空地');
    }
  }
  if (v.openWindow) bits.push(`开着窗：${v.openWindow}${v.openPage ? `（${v.openPage}）` : ''}`);
  if (v.selected?.length) bits.push(`选中：${v.selected.slice(0, 8).join('、')}${v.selected.length > 8 ? ' 等' : ''}`);
  return bits.join('；') || null;
}

export function _resetViewpoints() { store.clear(); }
