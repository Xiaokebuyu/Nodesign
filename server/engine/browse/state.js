/**
 * server/engine/browse/state.js — 浏览器在桌面上留下的那点持久痕迹（2026-08-18）
 *
 * ## 为什么需要它
 *
 * 浏览器实例本身是**进程内的、易失的**（`registry.js` 的 Map，空闲 5 分钟就回收，
 * pm2 重启就没了）。这是对的 —— 浏览器真的没了。
 *
 * 但用户要的是「**桌面上有一张浏览器卡片，随时能进去看和用**」（2026-08-18 拍板，
 * 推翻了当初 BrowserWindow 里那句「你不会想在桌面上永久摆着一张某次浏览的卡片」）。
 * 卡片要活得比实例长：agent 昨天逛过的站，今天打开项目还应该看得见那张卡，双击
 * 就回到那一页。所以要有一点**落盘**的状态。
 *
 * ## 落哪儿
 *
 * `<pid>/.browser/`，跟 chromium 的 profile 同级、在 `shared/` **外面**。
 * 理由跟 profile 一样（registry.js 里核过）：`shared/` 是 agent 的 cwd 也是
 * artifact-file 的服务根，放进去等于让 agent 能 Read 自己的浏览历史、
 * 还会被当文件服出去、还进 per-project git。删项目时 `<pid>/` 整个挪进回收站
 * （09-17 起，到期真删），这里跟着走，不用另写清理。
 *
 * ## 两份东西，两种性质
 *
 * - `state.json` —— 上次在哪一页（`{url, title, at}`）。导航/点击后写，**必须极便宜
 *   且永不抛**：它长在导航路径上，为了一张卡片让 agent 的导航失败是划不来的。
 * - `last.webp` —— 上次看到的样子（卡片上那块预览）。
 *   ⭐ 只在**本来就截了图**的时候顺手存（`browser_screenshot` 的视口档），
 *   或者用户正在看画布、preview 端点现截一张。**不为了刷新卡片主动截图** ——
 *   实测视口截图在 stripe/小红书这种站上要 1.7~4.2 秒，而这台机器只有 1 个核。
 *
 * 卡上的预览因此是「**上次看到的样子**」，跟 word 卡是同一路数（那也是一张静态页图）。
 * 活的画面流只在窗打开时给：实测每 fps 约 3.1pp 单核，满帧 40%。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { getProjectWorkspace } from '../../projects/workspace.js';
import { assertProjectLive } from '../../projects/project-gone.js';

const dirOf = (projectId) => path.join(getProjectWorkspace(projectId), '.browser');
/** 写入口用（09-17）：已删除的项目不再写 .browser/ —— mkdir 会把 `<pid>/` 建回来。两个调用点都在 try 里，抛了就是不写 */
const liveDirOf = (projectId) => { assertProjectLive(projectId); return dirOf(projectId); };
const STATE_FILE = 'state.json';
const FRAME_FILE = 'last.webp';

/** 卡片预览的绝对路径（存在与否由调用方 stat） */
export function framePath(projectId) {
  return path.join(dirOf(projectId), FRAME_FILE);
}

/**
 * 记一笔「现在在这一页」。**永不抛** —— 它挂在导航路径上。
 * @param {string} projectId
 * @param {import('playwright').Page} page
 */
export async function recordVisit(projectId, page) {
  try {
    const url = page.url();
    if (!/^https?:/.test(url)) return;      // about:blank / chrome-error 不值得记
    const title = await page.title().catch(() => '');
    const dir = liveDirOf(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, STATE_FILE), `${JSON.stringify({
      url, title: title || null, at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch { /* 记不下来就算了，不能因此让导航失败 */ }
}

/**
 * 上次在哪一页。没逛过 → null（桌面上就没有这张卡）。
 * @returns {Promise<{url: string, title: string|null, at: string}|null>}
 */
export async function readVisit(projectId) {
  try {
    const raw = await fs.readFile(path.join(dirOf(projectId), STATE_FILE), 'utf8');
    const v = JSON.parse(raw);
    return (v && typeof v.url === 'string' && /^https?:/.test(v.url)) ? v : null;
  } catch { return null; }
}

/**
 * 存一帧当卡片预览。传的是原始截图 buffer，这里缩成卡片尺寸再落盘。
 *
 * 卡片预览区 640×400（`ARTIFACT_PREVIEW_H.browse`），主角档 ×1.5 = 960 宽，
 * 所以存 1024 宽足够，再大是白占盘和白花编码时间。**永不抛。**
 */
export async function saveFrame(projectId, buf) {
  try {
    const { default: sharp } = await import('sharp');
    const out = await sharp(buf).resize({ width: 1024, withoutEnlargement: true })
      .webp({ quality: 72 }).toBuffer();
    const dir = liveDirOf(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, FRAME_FILE), out);
    return out.length;
  } catch { return 0; }
}

/**
 * 忘掉这个项目的浏览痕迹 —— 桌面上那张卡随之消失。
 *
 * 为什么需要：卡片的存在判据是 `state.json` 在不在，而它一旦写下就永远在 ——
 * 一个月前逛过一次的项目，桌面上会一直摆着那张卡赶不走。这是"卡活得比实例长"
 * 的代价，得给个出口。
 *
 * ⚠️ **profile 不删**（`.browser/default/`）：登录态是资产，用户点的是"这张卡
 * 我不看了"，不是"把我在那个站的登录清掉"。
 */
export async function forgetVisit(projectId) {
  const dir = dirOf(projectId);
  await Promise.all([
    fs.unlink(path.join(dir, STATE_FILE)).catch(() => {}),
    fs.unlink(path.join(dir, FRAME_FILE)).catch(() => {}),
  ]);
}

/** 上次那张预览的字节 + mtime；没有 → null */
export async function readFrame(projectId) {
  const file = framePath(projectId);
  try {
    const [buf, st] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    return { buf, mtime: st.mtime };
  } catch { return null; }
}
