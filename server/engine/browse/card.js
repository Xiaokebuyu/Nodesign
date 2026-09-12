/**
 * server/engine/browse/card.js — 桌面上那张浏览器卡（2026-08-18）
 *
 * `/artifacts` 每次都会调它，所以要便宜：一次读小 json + 一次 stat，读不到就 null。
 *
 * ## 为什么它是一张卡，而不只是一扇窗
 *
 * 建这条通道时我在 `BrowserWindow.jsx` 的文件头里写过：「这扇窗不是产物…
 * **你不会想在桌面上永久摆着一张"某次浏览"的卡片**」。用户 2026-08-18 拍反了，
 * 而且理由比我的判断硬：agent 逛站这件事**用户要能随时进去看、随时接手**。
 * 只由 `run.browser_opened` 事件开窗意味着"错过就没了"——刷新一下、切个项目回来，
 * 那扇窗和它背后正在等人的 agent 就都找不见了。
 *
 * 所以卡片的性质要说清楚，它跟另外三种产物卡**不一样**：
 * - deck / 站点 / word 的真相是**磁盘上的文件**，卡是文件的投影；
 * - 这张卡的真相是**一段浏览痕迹**（`.browser/state.json`），卡是"上次逛到哪"的
 *   投影，背后那只 chromium 是**运行时**，可以不在（空闲 5 分钟就回收）。
 *
 * ## 它是「工具卡」这一类的第一张（2026-08-18 下午，用户定的类别）
 *
 * 用户的原话：「可以是单纯的内容卡，也可以是单纯的**工具卡**（工具存放工具采集到的
 * 内容，以及可互动工具的显示）」。所以这张卡同时是两样东西：
 *
 * 1. **一个目录**（`assets/references/web/`，一站一子文件夹）—— 工具采回来的东西
 *    住在里面，按站点产物那条范式：目录 = 单位，文件名表明类别；
 * 2. **一个可交互的东西** —— 双击进去是活的浏览器画面，能接手操作。
 *
 * 类别是**两条叠加的轴**（也是用户定的）：内容轴（这是什么）× 来源轴（谁产出的）。
 * 这张卡在内容轴上是 `tool`、来源轴上是 `tool`；agent 写的 deck 是 `work`+`agent`；
 * 用户传的图是 `material`+`user`。桌面按任意一条轴过滤。
 *
 * 后果是具体的：它不进 kinds 注册表（那张表登记的是**产物**形态）、不能导出、
 * 不进上下文托盘。它是入口 + 容器。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { browseState } from './registry.js';
import { readVisit, framePath } from './state.js';
import { CAPTURE_DIR } from './capture.js';
import { getSharedDir } from '../../projects/workspace.js';

/**
 * @param {string} projectId
 * @returns {Promise<null | {url: string, host: string, title: string|null,
 *                           at: string, live: boolean, busy: boolean, hasPreview: boolean}>}
 *   null = 这个项目没逛过任何站 → 桌面上就不该有这张卡
 */
export async function browseCard(projectId) {
  let visit = null;
  let state = { live: false, url: null, busy: false };
  try {
    visit = await readVisit(projectId);
    state = browseState(projectId);
  } catch { return null; }
  // 活实例的 url 才是当下；没有活实例时用落盘的那个（卡活得比实例长）
  const raw = state.live ? (state.url || visit?.url) : visit?.url;
  const url = (raw && /^https?:/.test(raw)) ? raw : null;
  const sites = await collectedSites(projectId);
  /**
   * ⭐ 存在判据是**两者之一**：有访问记录，或者采到过东西。
   *
   * 只看访问记录是不够的（第一版就是，普查时逮到）：`state.json` 是 2026-08-18
   * 下午才开始写的，而 `assets/references/web/` 里线上已经躺着别的项目采的东西 ——
   * 那些项目会一张卡都没有，采集成果彻底看不见。反过来"逛过但没采"也该有卡
   * （它是入口）。所以两条任一成立就出卡。
   */
  if (!url && !sites.length) return null;
  const hasPreview = await fs.stat(framePath(projectId)).then(() => true, () => false);
  return {
    sites,
    url,
    host: (() => {
      if (!url) return sites[0]?.site || '采集';   // 只有采集没有访问记录时，卡上写第一个站
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
    })(),
    title: visit?.title || null,
    at: visit?.at || null,
    live: !!state.live,
    busy: !!state.busy,
    hasPreview,
  };
}

/**
 * 这个工具采回来的东西，**按站分组**（目录 = 单位）。
 *
 * 只 readdir 两层（站目录 + 里面的文件），不进 `.meta/`。封面取第一张 screenshot ——
 * 卡面和窗里的分组头都用它。读不到就当没有：采集清单列不出来不该让整张卡消失。
 */
const MAX_FILES_PER_SITE = 60;
/** 文件名表明类别（一站一文件夹那条范式）：截图 / 其它图 / 文本（调色板、字体、结构、CSS） */
export function categoryOf(name) {
  if (/\.screenshot\.(webp|png)$/i.test(name)) return 'screenshot';
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(name)) return 'image';
  return 'text';
}

async function collectedSites(projectId) {
  const root = path.join(getSharedDir(projectId), CAPTURE_DIR);
  let ents;
  try { ents = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const groups = new Map();   // 站名 → { site, count, cover, dir, files }
  const add = (site, dir, file) => {
    const g = groups.get(site) || { site, count: 0, cover: null, dir, files: [] };
    g.count += 1;
    if (!g.cover && /\.screenshot\.(webp|png)$/i.test(file)) g.cover = `${dir}/${file}`;
    // 2026-09-12：清单也带上（原来数完个数就丢，窗里点开一站只能看到一行路径，
    // 用户报「采到的东西点不开」）。每站封 60 件，够看不撑爆 /artifacts。
    if (g.files.length < MAX_FILES_PER_SITE) g.files.push({ name: file, rel: `${dir}/${file}`, category: categoryOf(file) });
    groups.set(site, g);
  };

  for (const d of ents) {
    if (d.name.startsWith('.')) continue;
    if (d.isDirectory()) {
      // 现行布局：一站一文件夹
      let files;
      try { files = await fs.readdir(path.join(root, d.name)); } catch { continue; }
      for (const f of files.filter(n => !n.startsWith('.'))) {
        add(d.name, `${CAPTURE_DIR}/${d.name}`, f);
      }
    }
  }

  /**
   * ⚠️ **存量：平铺在 `web/` 根上的老采集**（一站一文件夹是 2026-08-18 下午才改的）。
   * 线上真有 —— 普查时另一个项目躺着 8 个。不认它们的话那张卡会写"采过 0 个站"，
   * 而文件明明在，用户只会觉得东西丢了。
   *
   * 归站靠**出处 sidecar 里的 sourceUrl**，不是猜文件名前缀（老命名是
   * `<host>-<时间>.<档>`，host 里带点、时间带横线，切出来的东西不能当站名）。
   * **刻意不搬文件**：references 是用户数据，静默 mv 会打断任何引用了老路径的
   * 东西（便签里记的路径、站点里 `<img src>`）。读的时候认就够了。
   */
  const loose = ents.filter(e => e.isFile() && !e.name.startsWith('.')).slice(0, 60);
  for (const f of loose) {
    let host = '早期采集';
    try {
      const stem = f.name.replace(/\.[^.]+$/, '');
      const meta = JSON.parse(await fs.readFile(path.join(root, '.meta', `${stem}.json`), 'utf8'));
      if (meta?.sourceUrl) host = new URL(meta.sourceUrl).hostname.replace(/^www\./, '');
    } catch { /* 没出处就归到"早期采集" */ }
    add(host, CAPTURE_DIR, f.name);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
}
