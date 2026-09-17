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

/**
 * 电脑休眠打断的网络请求（09-17）：Chromium 在系统挂起时把在飞请求全部以 ERR_NETWORK_IO_SUSPENDED 结束。
 * 问题库里 0.1.43 一台机一晚两条「更新失败[github]：net::ERR_NETWORK_IO_SUSPENDED」—— 镜像那一路先因休眠失败，
 * 退回 GitHub 又因休眠失败，再作为故障上报。这不是更新源的问题：不切源、不上报，唤醒后重查一次。
 */
export function isSuspendError(e) {
  return /ERR_NETWORK_IO_SUSPENDED/.test(String(e?.message || e || ''));
}

/** 手动安装包的固定地址（官网下载按钮同一个，工作流每次发版覆盖成最新版） */
export const MANUAL_INSTALLER_URL = 'https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe';

/**
 * 退出时静默安装没装上（09-17）：原来只记一条问题，用户那边什么都看不到，下次照样静默失败。
 * 问题库里一台机器（WY）连着两次没装上，同一分钟还起不来（node.exe ENOENT）—— 推断是安装器回滚留下了残缺目录。
 * 给用户一条能自己走通的路：下载完整安装包覆盖安装（数据目录在家目录下，不受影响）。
 */
export function installFailedNotice(pending, current) {
  const to = pending?.to || '新版本';
  return {
    title: '自动更新没有装上',
    message: `上次退出时应当更新到 ${to}，现在运行的仍是 ${current}。`,
    detail: '常见原因是安装目录里有文件被占用，安装器会回滚且不提示。'
      + '可以下载完整安装包，直接覆盖安装；项目和设置保存在数据目录里，不受影响。',
    buttons: ['下载安装包', '先不处理'],
  };
}
