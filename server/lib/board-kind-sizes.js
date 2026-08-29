/**
 * board-kind-sizes —— 画布物件身位的服务端镜像（2026-08-14，agent 摆位批）
 *
 * read_board / arrange_on_board / create_on_board 要在服务端估算卡片矩形
 * （挨着谁摆、会不会压到谁），而身位真相住在前端 `web/src/lib/board-kinds.js`
 * （渲染方）。这里抄一份**常量**，web 侧有 parity 测试钉着两边一致 ——
 * 改那边忘了改这边，测试直接红（跟 binding-types 的双份表同一套纪律）。
 *
 * 文字/涂鸦不在表里：它们的 w/h 是逐条存在 board.json 里的（本体即数据）。
 */

import { KINDS } from './kinds/index.js';
import { boardHeroId, heroSize } from './board-hero.js';

export const DECK_EMBED_W = 640;
export const ARTIFACT_HEADER_H = 28;
export const ARTIFACT_PREVIEW_H = { deck: 360, site: 400, docx: 420, browse: 360 };

// file 是 224x32 的细条卡（parity 测试上岗第一天就逮住我猜成 160x120 ——
// 那是涂鸦的默认身位。别猜，抄表）
export const KIND_SIZES = {
  image: { w: 200, h: 176 },
  video: { w: 240, h: 160 },
  note: { w: 200, h: 148 },
  file: { w: 224, h: 32 },
};

/**
 * 文件夹卡的身位（2026-08-29 占位契约刀 A）。真身在前端
 * `web/src/lib/board-geometry.js` 的 FOLDER_CARD —— zones 存档 08-13 瘦身后只剩
 * 坐标，尺寸就是这个常量，两边靠 parity 测试钉着。
 *
 * ⛔ 它以前从不参与落位：三处障碍集合都只遍历 objects，文件夹对落位系统**结构性
 * 隐形**（生产 128 块真板实测：文件夹被压 112 次 —— 被产物 34、被文件 33、
 * 被文档 23、被板书 13）。现在它跟别的物件一样是障碍，见 board-obstacles.js。
 */
export const FOLDER_CARD = { w: 288, h: 240 };

/** 文件夹卡矩形（根层物件；id = 目录路径，跟 zones 的键一致） */
export function zoneRects(board) {
  const out = [];
  for (const [path, z] of Object.entries(board?.zones || {})) {
    if (!Number.isFinite(z?.x) || !Number.isFinite(z?.y)) continue;
    out.push({ id: path, x: z.x, y: z.y, ...FOLDER_CARD, folder: true });
  }
  return out;
}

// 前缀表从注册表派生（「写死表家族」第 4 处，2026-08-18 收）：手写
// `deck|site|docx` 的话加形态必漏，新形态的卡掉到 file 兜底（224×32 细条），
// agent 摆位按错矩形算。⚠️ 新形态要同步给 ARTIFACT_PREVIEW_H 加一行
//（两边都有 parity 测试钉着前端那份）。
const KIND_PREFIX_RE = new RegExp(`^(${Object.keys(KINDS).join('|')}):`);

const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

/**
 * 按 id + board.json 条目估身位。优先条目里存的 w/h（文字/涂鸦，或将来任何
 * 显式尺寸），其次按 id 形态推：kind 前缀 → 产物卡，扩展名 → 图/视频/便签/文件。
 */
export function estimateSize(id, entry) {
  if (entry && Number.isFinite(entry.w) && Number.isFinite(entry.h)) {
    return { w: entry.w, h: entry.h };
  }
  const s = String(id || '');
  // 浏览器卡是**单例**，id 就是 'browse'（没有路径可挂 —— 它背后不是文件）。
  // 不给这条分支的话它会掉到最后的 file 兜底（224×32 的细条），agent 摆位时
  // 就会拿一个错的矩形去算"挨着谁摆、会不会压到谁"。
  if (s === 'browse') {
    return { w: DECK_EMBED_W, h: ARTIFACT_HEADER_H + ARTIFACT_PREVIEW_H.browse };
  }
  const m = KIND_PREFIX_RE.exec(s);
  if (m) {
    const t = m[1];
    return { w: DECK_EMBED_W, h: ARTIFACT_HEADER_H + ARTIFACT_PREVIEW_H[t] };
  }
  if (IMG_EXT.test(s)) return KIND_SIZES.image;
  if (VIDEO_EXT.test(s)) return KIND_SIZES.video;
  // 文本类文件卡带内容预览（08-24：md/json 等升级出预览体），身位=note
  if (/\.(md|markdown|txt|json|csv|ya?ml)$/i.test(s)) return KIND_SIZES.note;
  return KIND_SIZES.file;
}

/**
 * 按**这块板**估尺寸：主角卡（board-hero 的判断）放大 1.5 倍，其余同 estimateSize。
 * 凡是拿尺寸去避让/取景/列座次的地方都该用它 —— 主角不是特例，是版面常态。
 * heroId 按 board 对象缓存一次（同一次工具调用里反复问不重算）。
 */
const heroCache = new WeakMap();
export function estimateSizeOn(board, id, entry) {
  if (entry && Number.isFinite(entry.w) && Number.isFinite(entry.h)) return { w: entry.w, h: entry.h };
  if (board && typeof board === 'object') {
    let hero = heroCache.get(board);
    if (hero === undefined) {
      hero = boardHeroId(board);
      heroCache.set(board, hero);
    }
    if (hero && hero === id) {
      const hs = heroSize(id);
      if (hs) return hs;
    }
  }
  return estimateSize(id, entry);
}
