import path from 'node:path';

/**
 * 工具入参里的 `file_path` → **工作区相对路径**。
 *
 * ## 为什么这件事必须在服务端做
 *
 * 画布上的物件 id 就是工作区相对路径（2026-08-08：`deck:鉴赏页/主稿.html`、
 * `site:伊蕾娜手账研究站`、文件夹就是路径本身）。而 agent 的工具入参给的多半是
 * **绝对路径**（Write / Edit 要求绝对），只有服务端知道工作区根在哪。
 *
 * 扁平化之前前端能自己抠：绝对路径里有 `tasks/<任务>/` 这个特征段，正则一锚就
 * 拿到相对部分。`tasks/` 那层拆掉之后，绝对路径里**再没有任何可锚定的标志** ——
 * 工作区根就是项目目录本身，名字是随机 id。前端猜不出来，也不该猜。
 *
 * 所以凡是要发给前端当"物件寻址依据"的路径，一律在 emit 之前过这一道。
 * 漏掉的症状是**不报错**的：舞台卡认不出目标 → 静静地掉进屏幕底部的 dock，
 * 看起来只是"agent 干活时画布没反应"。
 *
 * @param {string} filePath      绝对路径或相对 cwd 的路径
 * @param {string} workspaceRoot 工作区根（agent 的 cwd）
 * @returns {string} 工作区相对路径；不在工作区里的原样返回
 */
export function toWorkspaceRel(filePath, workspaceRoot) {
  if (typeof filePath !== 'string' || !filePath) return '';
  if (!workspaceRoot) return filePath.replace(/\\/g, '/');
  const root = path.resolve(workspaceRoot);

  // ⛔ 09-08 修：原来第一行就把入参的 `\` 全换成 `/`，然后拿它去跟 `root` 比 ——
  // 而 `root` 是 `path.resolve` 出来的，**Windows 上带反斜杠**。
  // 正斜杠 startsWith 反斜杠永远 false，于是这个函数在 Windows 上**恒定失败**：
  // 绝对路径原样退回（而不是转成相对路径），`abs === root` 也永远不成立。
  //
  // 后果不是报错，是一串静默症状：
  //   · `hooks/file-events.js` 拿到的 rel 是绝对路径 → `path.isAbsolute` 判真 →
  //     静默 return，**Windows 上 `run.file_changed` 一个都不发** ——
  //     agent 写完文件画布不动、iframe 不重载，要等下一次全盘扫描才冒出来
  //   · `tool-input-stream.js` 把 `C:/...` 当物件 id 发给前端 → 画布上长出一块
  //     名叫 `C:` 的影子文件夹，而那种影子「永不退场」
  //
  // Linux 上永远绿：`path.sep === '/'` 时那次归一化正好跟 root 对齐。
  // 改法跟 `lib/safe-path.js` 一致 —— 用 `path.relative`，不要自己拼字符串比。
  // ⭐ 附带解决大小写：`path.win32.relative` 是**大小写不敏感**的（内部两边 lowercase
  //   再比），所以 `c:\users\...` 和 `C:\Users\...` 也能对上。
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  // 工作区根自己 → 空串（"就是这张桌面"）
  if (!rel) return '';
  // 根之外的路径原样退回，让调用方决定
  if (rel.startsWith('..') || path.isAbsolute(rel)) return filePath.replace(/\\/g, '/');
  // 对外一律正斜杠：画布物件 id、board.json 的 key 都是这个口径
  return rel.split(path.sep).join('/');
}
