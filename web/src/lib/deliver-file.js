/**
 * deliver-file.js —— 「一个文件怎么交到用户手上」全站一处（2026-09-10）。
 *
 * 起因：09-09 桌面 0.1.34 导出 zip，通知说"已保存到下载"，下载目录里什么都没有。日志里五次
 * `[download] 已保存 …Downloads\Nodesign官网.zip`，**同名五次都没加 (2) 序号** —— 每次存之前
 * 上一份已经不在了，而工作区 `shared/exports/` 里那份一直好好的。也就是说：不是没写进去，是
 * **写进去之后被拿走**（浏览器下载出来的文件带 Mark-of-the-Web，杀软对这种 zip 下手是常事）。
 *
 * 所以桌面版不再走 Chromium 的下载通道：渲染进程把字节交给壳，**主进程自己 fs 写盘**。
 * 没有 MotW 这个标记，也就没有那条"这是从网上下来的"理由。写完主进程回摸一次文件，
 * 不见了就记进问题库 —— 下次再丢，日志里分得清是"没写"还是"写了又没了"。
 *
 * ⚠️ 网页版没有壳，照旧 `<a download>`；桥调用失败也退回它 —— 导出这件事不能因为壳的毛病卡死。
 * ⚠️ 全站三处原本各写了一遍这段 blob→a[download] 的舞蹈（卡导出 / 导出清单 / 导出面板），
 *    现在都进这道门。别再抄第四份。
 */

/** 浏览器下载（网页版，以及桥不在/出错时的退路）。objectURL 要回收，一次会话点几十次不然攒一堆 */
export function pushDownload(blob, filename) {
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
 * 把一份产物交给用户。
 * @returns {Promise<{path: string|null}>} path = 桌面版真正落盘的位置（网页版是 null，调用方自己决定怎么说）
 */
export async function deliverFile(blob, filename) {
  const desktop = typeof window !== 'undefined' ? window.nodesignDesktop : null;
  if (desktop?.saveExport) {
    try {
      const r = await desktop.saveExport(filename || '导出', await blob.arrayBuffer());
      if (r?.path) return { path: r.path };
    } catch { /* 壳那边出错就当没有壳，走下面的退路 */ }
  }
  pushDownload(blob, filename);
  return { path: null };
}
