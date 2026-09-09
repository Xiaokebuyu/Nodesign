import { Exports } from '../../lib/api.js';
import { defaultFormatFor } from '../../lib/export-formats.js';
import { useGlobalStore } from '../../stores/globalStore.js';

/**
 * card-export.js — 导出画布上的一张卡（2026-08-17 重做导出）
 *
 * 从 BoardCanvas 拆出来（行数棘轮：那份贴着上限）。拆得动是因为它不闭包
 * BoardCanvas 的任何状态 —— 只要 projectId 和那个物件。
 *
 * ⚠️ 调用方只该对**背后真有文件**的卡挂这颗按钮（BoardCanvas 用 isFileBacked 判）：
 * 涂鸦和画布文字是画布原生物件，它们的 id 是布局档里的条目不是路径，导出必然 404。
 *
 * 默认格式按卡类型来：文件类（图 / 视频 / 便签 / 其它文件）给原件，目录与页面类
 * 给打包。想换格式走顶栏那个菜单 —— 卡上这颗是「我就要这个东西」的快捷键，
 * 不该在卡上再长一层菜单。
 */

/** 把 blob 塞进浏览器下载。objectURL 要回收，不然一次会话点几十次就攒一堆 */
/**
 * 拿一个同源下载地址，先 fetch 成 blob 再走 pushDownload。
 *
 * 09-09 桌面版 0.1.34 案：agent deliver_files 后前端用 `<a href="/api/…/exports/file/x.zip" download>`
 * 直接点，Electron 主进程的 will-download 一次都没触发（desktop.log 里只有手动导出的两条「已保存」），
 * 用户什么都没拿到而 agent 说「已在下载」。手动导出走的是 blob URL + <a download>，同一台机器上落地
 * 正常 —— 所以交付也收口到这一条：不依赖浏览器对「带 download 的同源导航」的处理，两种壳一种路。
 * 非 2xx 时把服务端的错误说出来（原来的写法 404 也只是静静地什么都不发生）。
 */
export async function downloadFromUrl(url, filename) {
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status });
  }
  pushDownload(await res.blob(), filename);
}

function pushDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '导出';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {string} projectId
 * @param {{id:string, cardKind?:string, type?:string, title?:string}} obj 画布物件
 */
export async function exportCard(projectId, obj) {
  const format = defaultFormatFor(obj.cardKind || obj.type);
  const toast = useGlobalStore.getState().showToast;
  try {
    const { blob, filename, skipped } = await Exports.cards(projectId, [obj.id], format);
    pushDownload(blob, filename || obj.title);
    // ⚠️ 收不到的卡必须说出来。静默少东西是导出最贵的失败方式：用户解压之后
    // 才发现少了，那时他已经不知道是哪一步丢的。
    if (skipped?.total) {
      const first = skipped.items?.[0];
      toast(`有 ${skipped.total} 张没导出${first ? `：${first.reason}` : ''}`, 'error');
    }
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
}

/**
 * 走**按卡导出**那条新管线的格式。key = 菜单里的格式 id，value = 新路由的格式。
 *
 * `site`（整站打包）也收进来，是为了消掉一处真分叉：同一个站，菜单原来走
 * `GET /exports/site`（`site/` 前缀 + 路径改写 + 自己那份扫描器），卡按钮走新路
 * （工作区相对、零改写、按引用收），**两份 zip 内容不一样**。用户从两条路各导
 * 一次就会发现对不上，而这种不一致没人查得出是哪来的。
 *
 * 不在表里的（html / pdf / pptx）要跑 playwright / esbuild 烘焙管线，仍走老路由。
 */
const CARD_PIPELINE = { handoff: 'handoff', site: 'zip', zip: 'zip', raw: 'raw', md: 'md' };

/**
 * 顶栏导出菜单的下载动作。
 *
 * ⭐**工程包与整站打包走「按卡导出」**：旧的 `GET /exports/handoff` 把整个项目级
 * `shared/assets` 打进包（生产上最大的项目 280MB，含别的任务的图），README 还是
 * 静态模板；新路只收这份产物真正引用到的素材，README 带「你的后端要实现哪些接口」。
 *
 * ⚠️ 聚焦不到具体产物（cardId 为空）时：老路由有的格式退回老路；**新管线独有的
 * 格式（raw/zip/md）没有对应 GET 路由**，退回去只会打到 404 —— 那种「点了没反应
 * 还不知道为什么」比直接说话糟得多，所以明说。
 */
export async function exportFromMenu(projectId, format, cardId, fallbackName) {
  const toast = useGlobalStore.getState().showToast;
  const cardFormat = CARD_PIPELINE[format];
  if (cardFormat && !cardId) {
    if (!['handoff', 'site'].includes(format)) {
      toast('先在画布上点开要导出的那份产物，再从这里导', 'error');
      return;
    }
  }
  try {
    const { blob, filename, skipped } = (cardFormat && cardId)
      ? await Exports.cards(projectId, [cardId], cardFormat)
      : await Exports.download(projectId, format);
    const name = filename || `${fallbackName || 'design'}.${format === 'handoff' ? 'zip' : format}`;
    pushDownload(blob, name);
    toast(`已下载：${name}`, 'success');
    if (skipped?.total) toast(`有 ${skipped.total} 张没导出`, 'error');
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error');
  }
}
