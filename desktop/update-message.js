/**
 * desktop/update-message.js — 「检查更新」弹的那句话。单独成文件是为了不带 electron 也能测。
 *
 * ⛔ 三种结果都要说话（09-07）：站主装着比已发布版本新的草稿包点「检查更新」，没有任何反应 ——
 * 原来只在"版本号相等"时弹"已是最新"，服务器版本比本机旧那条路什么都不说。
 * updater 只看得见**已发布**的 release，草稿不算。
 */
export function updateCheckMessage(r, current) {
  const remote = r?.updateInfo?.version;
  if (r?.isUpdateAvailable) return `发现新版本 ${remote}，正在后台下载，下载完成会提示重启。`;
  if (remote && remote !== current) return `已经是最新版本（${current}）。\n\n已发布的最新版是 ${remote}，本机装的比它新（草稿包不算发布，更新器看不见）。`;
  return `已经是最新版本（${current}）。`;
}
