/**
 * server/engine/mcp/tools/helpers/perception-page.js
 * 感知工具的**唯一**页面加载口（2026-08-18）
 *
 * ## 为什么要有这一层
 *
 * 在这之前四个感知工具各自 `page.goto('file://' + abs)`，而用户预览走的是
 * `/api/projects/:pid/artifact-file/*`（http）。**两条通道不同源**，于是：
 *
 *   - `location.protocol` 守卫（导出 zip 用 file:// 打开时关掉客户端路由那种）
 *     在自检时触发，agent 看到的是退化行为
 *   - `fetch`/XHR 被 CORS 拒 —— 任何加载 JSON 的站点在自检里是死的
 *   - **localStorage 的 origin 是字符串 "null"**，全部任务共用一个桶；而用户
 *     预览下它们各自独立。mock-app 产线「写了刷新还在」那条硬定义正好踩在
 *     这上面 —— agent 验的东西和用户看的东西不是一回事
 *   - Service Worker / 动态 import 同理
 *
 * 一个 agent 为此花了 4 次截图 + 一次把 `location.protocol` 写进 DOM 再截图，
 * 才反推出来自己被 file:// 打开了（问题库 iss_msxk2oci_0v0v）。
 *
 * ## 凭什么能走 http
 *
 * MCP 工具的 handler 跟 express server 跑在**同一个进程**里，而 token 是无状态
 * HMAC：`mintToken(ownerId)` 当场铸一个、塞进 chromium 的 cookie jar 即可。
 * 拿到的权限跟项目所有者在浏览器里一模一样——不是新开一道后门，是走用户那道门。
 * （web/scripts/shot-live.mjs 早就是这么干的，这里只是把它收进产品代码。）
 *
 * ⚠️ 铸出来的 token 只进本机 chromium 的 cookie jar，不写日志、不进返回文本。
 * ⚠️ 前提是**调用方跟 HTTP server 同进程**（共用 NODESIGN_AUTH_SECRET）。独立脚本
 *    里直接调这个 helper 会铸出对不上号的 token，服务端回 401 —— 那是环境问题不是
 *    产品 bug，跑验证脚本记得 `node --env-file=.env`。
 */

import path from 'node:path';
import { fileUrl } from '../../../../lib/file-url.js';
import { getProject } from '../../../../projects/store.js';
import { COOKIE_NAME, mintToken, authEnabled } from '../../../../auth/session.js';
import { getUserById } from '../../../../auth/users-store.js';

// ── 渲染层保真（2026-08-07 立，2026-08-18 从 screenshot.js 挪来收成一份）──
// Chromium 的强制暗色（Auto Dark）会在 paint 层反转颜色，而页面自己的 JS
// 一点都测不到 —— 2026-08-05 那次「位图深色 / computed style 浅色」事故就是它。
// ⚠️ 这组参数以前只有 screenshot / screenshot-url 两条路带，query_elements /
// get_computed_styles / list_pages 是裸奔的 —— 同一个 DOM 两条通道两种渲染，
// 正是「判据本身要先验一遍」那类坑。现在收成一份，谁开 chromium 都带上。
export const FIDELITY_LAUNCH_ARGS = [
  '--disable-features=WebContentsForceDark',  // 自动暗色：paint 层反转，页面自己测不到
  '--force-color-profile=srgb',               // 色彩配置固定 srgb，排除 ICC 差异
];

/** 服务端自己的监听口。跟 server/index.js 同一个默认值，改端口两处一起改。 */
const PORT = Number(process.env.PORT || 4001);

/** 127.0.0.1 而不是 localhost：避免 ::1/127.0.0.1 双栈解析下 cookie 域对不上 */
export const PERCEPTION_ORIGIN = `http://127.0.0.1:${PORT}`;
/**
 * 站点检查的真实设备宽（08-21 收成一份：以前 screenshot / explain_style / profile_scroll
 * 各抄一份 {desktop:1440,…}）。站点没有"比例"，版面是宽度算出来的，所以档位给
 * 真实设备宽、直接当 viewport、不缩放。
 */
export const SITE_DEVICE_W = { desktop: 1440, tablet: 834, mobile: 390 };

/**
 * 开一个「保真」chromium。凡是要把页面变成给人或给模型看的像素的地方都走这里 ——
 * 参数散在九个调用点上时，有三个是漏的（2026-08-18 逐处对账才发现，当天收敛完）。
 *
 * ⚠️ **有两处故意不走这里**，别顺手也"收敛"掉：
 *   `screenshot-url.js` 和 `engine/browse/registry.js`。它们打的是**外部 URL**，
 *   必须挂 `--proxy-server` 走出网闸（lib/browse-proxy.js）；而这个函数开的浏览器
 *   专门打 `127.0.0.1:4001` 上我们自己的产物 —— 那正是出网闸要拦的地址。
 *   两条通道的**安全前提相反**，共用一个 launch 只会让其中一条失守或不通。
 */
export async function launchPerceptionBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: FIDELITY_LAUNCH_ARGS });
}

/**
 * 工作区相对路径 → 用户预览用的同一个 URL。
 * 逐段 encodeURIComponent —— 任务名和文件名大量是中文，整体编码会把 `/` 也吃掉。
 */
export function artifactFileUrl(projectId, relPath, { raw = true } = {}) {
  const sub = String(relPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  // ⭐ `?nd=raw` —— 不走显示改写层，拿原始 HTML + 原图。
  //
  // artifact-file 平时是**显示通道**：给 html 注 srcset/sizes/loading=lazy、给图发
  // 降尺寸的 webp/avif 派生图。对用户预览这些都对（省 90% 流量）。但 agent 的眼睛
  // 走同一条路由之后，它看到的就不是**交付物**了 —— 发布出去的站点是原始 HTML
  // （site-publish 拷原文，没有这层注入）。
  //
  // ⛔ 实测差别（2026-08-18 审查攻出来的）：一张 1800px 宽、没有 CSS 宽约束的图，
  // 注入 `sizes="100vw"` 之后在 agent 眼里渲染成 1440px、`overflow:false`；
  // 而访客那边是 1800px、`overflow:true` —— **显示改写层把横向溢出藏起来了**，
  // 而「忘写 max-width:100%」正是最常见的那类真 bug。顺带图也不是原图
  // （naturalWidth 1440 vs 1800），逐像素/锐度类判断跟着失真。
  //
  // ⚠️ 代价：感知页加载原图更慢更吃 CPU（1 vCPU 上是真代价）。取舍是**眼睛的
  // 正确性优先于自检速度** —— 一个看错的自检比一个慢的自检坏得多。
  // （http 同源那半边不受影响：fetch/localStorage/SW 照旧跟用户预览一致，实测过。）
  return `${PERCEPTION_ORIGIN}/api/projects/${projectId}/artifact-file/${sub}${raw ? '?nd=raw' : ''}`;
}

/**
 * 退化提示 → 一行可以直接拼进返回文本的话。
 *
 * `openArtifactPage` 的契约是「note 非空 = 没能走成 http，调用方必须把它写进
 * 返回文本」。⛔ 实测只有 screenshot 一个调用方照做了，另外五个工具连 `.note`
 * 两个字都没出现过（grep 计数 0）—— 也就是 07-29 那个「file:// 静默回退」的
 * bug 被重新种了一遍：`profile_scroll` 的描述铁口直断"走 http 同源"，一旦回退，
 * 它按 Resource Timing 报「images 0 files 0KB」，那正好是它主诊断的反面，
 * 而唯一能解释这件事的 note 被丢掉了。
 *
 * 所以把措辞收成一份，调用点无脑拼。配套有个 lint 钉住"import 了就必须用"。
 */
export function degradedNote(opened) {
  if (!opened?.note) return null;
  return `⚠️ 这一页没能按用户预览的方式打开（${opened.note}）。`
    + 'fetch/XHR/localStorage 的行为跟用户那边不一样，凡是依赖它们的结论都不作数。';
}

/**
 * 打开一个产物页面，返回 { page, context, url, note }。
 *
 * - `note` 非空表示**没能走成 http**（退回了 file://），调用方应把它写进 caption：
 *   悄悄退回去就是把这个 bug 重新种一遍。
 * - HTTP 状态 >= 400 直接抛错，不截一张 JSON 错误页给 agent 当产物看。
 *
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.workspaceRoot  项目工作区根（= artifact-file 的可服务根）
 * @param {string} opts.absPath        要打开的文件绝对路径
 * @param {object} [opts.viewport]
 * @param {number} [opts.deviceScaleFactor]
 * @param {number} [opts.timeout]
 * @param {string} [opts.waitUntil]
 */
export async function openArtifactPage(browser, {
  projectId, workspaceRoot, absPath,
  viewport, deviceScaleFactor = 1, timeout = 15000, waitUntil = 'networkidle',
}) {
  const contextOpts = { colorScheme: 'light', deviceScaleFactor };
  if (viewport) contextOpts.viewport = viewport;
  // ⭐ `?nd=raw` 只挂在**主文档**的 URL 上，页面里 `<img src="assets/x.png">` 发出去的
  // 请求不带任何 query —— 于是主文档拿到了原样 HTML，图片却照旧走派生图。实测：
  // 一张 1.36MB 的 PNG 发出去是 **35.7KB 的 webp（2.6%）**。两个后果都真实：
  //   ① 没有 CSS 宽约束的图按**固有尺寸**排版，派生图尺寸不同 → 版面跟访客不一样；
  //   ② `profile_scroll` 的"图片总字节"少报了几十倍，而它的头号建议就是按体积开药。
  // 每个请求都带一个头最省：query 要改写 HTML（那就不叫 raw 了）。
  //
  // ⚠️ 但**不能用 context 级 extraHTTPHeaders**（第一版就是，agent 上报逮到）：
  // 那会把这个自定义头带给页面请求的**所有主机**，而任何自定义头都会把跨域字体
  // 请求从「简单请求」升级成要 CORS 预检 —— fonts.gstatic.com 不认这个头，预检
  // 挂掉，Google Fonts 整站全灭，感知截图里字体全部回退。头只对感知源有意义
  //（assets.js 读它决定给不给原图），所以用 route 只加在同源请求上。
  const context = await browser.newContext(contextOpts);
  await context.route(`${PERCEPTION_ORIGIN}/**`, (route) => route.continue({
    headers: { ...route.request().headers(), 'X-ND-Raw': '1' },
  }));

  let url = null;
  let note = null;

  const rel = projectId && workspaceRoot
    ? path.relative(workspaceRoot, absPath)
    : null;
  const insideWorkspace = rel != null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);

  if (insideWorkspace) {
    url = artifactFileUrl(projectId, rel.split(path.sep).join('/'));
    if (authEnabled()) {
      // 项目所有者的身份 —— guardProject 只认 owner 或 admin
      const ownerId = getProject(projectId)?.ownerId;
      // ⚠️ 光有 ownerId 不够：`mintToken` 只把 id 烤进签名，而 `requestUser` 会
      // **重新查库**并拒掉 disabled / 已删除的用户。于是账号一被停用，六个感知工具
      // 全部报「artifact-file returned HTTP 401」—— 一句完全指不到根因的话
      // （真因是账号状态，跟文件、路径、权限配置都无关）。这里提前认出来，
      // 退到 file:// 并把真原因写进 note（note 会被所有调用方拼进返回文本，
      // 有 lint 钉着）。
      const owner = ownerId ? getUserById(ownerId) : null;
      if (ownerId && owner && !owner.disabled) {
        await context.addCookies([{
          name: COOKIE_NAME, value: mintToken(ownerId), url: PERCEPTION_ORIGIN,
        }]);
      } else {
        const why = !ownerId ? 'project owner unknown'
          : (!owner ? `owner account ${ownerId} no longer exists`
            : `owner account ${owner.username} is disabled — an admin has to re-enable it; `
              + 'this is an account-state problem, not a file or path problem');
        note = `${why} — loaded via file:// (fetch/XHR/localStorage behave differently from the user preview)`;
        url = null;
      }
    }
  } else {
    // 产物落在工作区外（不该发生，但寻址层出岔子时别整个瞎掉）
    note = 'file is outside the project workspace — loaded via file:// (fetch/XHR/localStorage behave differently from the user preview)';
  }

  const page = await context.newPage();
  if (!url) {
    const fileHref = fileUrl(absPath);
    return { page, context, url: fileHref, note, viaHttp: false, goto: () => page.goto(fileHref, { waitUntil, timeout }) };
  }

  return {
    page, context, url, note, viaHttp: true,
    goto: async () => {
      const resp = await page.goto(url, { waitUntil, timeout });
      // 401/403/404 会渲成一张 JSON 错误页 —— 截它等于给 agent 一张假产物
      const status = resp?.status();
      if (status && status >= 400) {
        throw new Error(`artifact-file returned HTTP ${status} for ${decodeURIComponent(url.replace(PERCEPTION_ORIGIN, ''))}`);
      }
      return resp;
    },
  };
}
