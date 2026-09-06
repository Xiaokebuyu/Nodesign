/**
 * server/engine/mcp/tools/helpers/reference-download.js
 * 把搜到的参考图下载进 `assets/references/`（2026-08-18 从 web-search.js 拆出）
 *
 * 拆的直接原因是行数棘轮，但拆对了：这跟"搜索"是两件事 —— 一件是问 provider 要结果，
 * 一件是把图落进工作区。`browser_capture` 也往同一个目录写，两边的落点约定
 * （`assets/references/`、`.meta/<主干>.json` 出处 sidecar）应该看得见彼此。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

/**
 * 搜图落点（2026-09-07 站主拍板：搜到的图要在桌面上看得见）。
 * 此前落 assets/references/ —— 那是画布扫描的盲区：入座器给它排座、状态块催 agent 去 pin、
 * pin_to_board 又拒收，三处判据各说各话。工作区根上的一个真文件夹是三处都认的形状：
 * 扫描把它当文件夹卡，入座器按文件夹里的座位排，organize_board / 用户拖拽都能挪。
 * browser_capture 采回来的调色板/截图仍在 assets/references/web/（给 agent 看的，走「参考素材」抽屉）。
 */
export const REFERENCE_IMAGE_DIR = '参考图';

// ── reference image download ──

const DL_TIMEOUT_MS = 10_000;
const DL_MAX_BYTES = 5 * 1024 * 1024; // 5MB（Anthropic image content block 单图上限）
const DL_MIN_BYTES = 5 * 1024;        // 5KB（< 这个多半是 logo / 损坏）

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

/**
 * 下载一张图到 <root>/assets/references/ref-<hash>-<role>.<ext>。
 * 已存在 → 直接返回（按 hash 去重）。
 *
 * @returns {Promise<{ relPath: string, absPath: string, sizeBytes: number, mimeType: string } | null>}
 *   失败/校验不通过 → null（caller 跳过这一张）
 */
async function downloadOneImage(url, refsDir) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DL_TIMEOUT_MS);
  try {
    const hash = shortHash(url);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const ext = MIME_TO_EXT[mime];
    if (!ext) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < DL_MIN_BYTES || buf.length > DL_MAX_BYTES) return null;

    const fileName = `ref-${hash}${ext}`;
    const absPath = path.join(refsDir, fileName);
    // 去重：同 url → 同 hash → 同文件名 → 已存在就跳写
    let exists = false;
    try { await fs.access(absPath); exists = true; } catch { /* not exists */ }
    if (!exists) await fs.writeFile(absPath, buf);

    return {
      relPath: path.posix.join(REFERENCE_IMAGE_DIR, fileName),
      absPath,
      sizeBytes: buf.length,
      mimeType: mime,
      base64: buf.toString('base64'), // 直接传给 CallToolResult image block
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发下载 top-N 图，filter 掉失败/超大/过小。
 *
 * @returns {Promise<Array<{url, description, title, relPath, absPath, sizeBytes, mimeType}>>}
 */
export async function downloadReferenceImages(images, { workspaceRoot, sharedRoot, stopAfter = Infinity }) {
  const baseRoot = sharedRoot || workspaceRoot;
  if (!baseRoot) return [];
  const refsDir = path.join(baseRoot, REFERENCE_IMAGE_DIR);
  await fs.mkdir(refsDir, { recursive: true });

  // ⚠️ **够了就停**（2026-08-18）。原来是把候选全并发下完再 slice，于是多下的那些
  // 留在磁盘上、agent 不知道它们存在、却照样占空间和进导出包。候选多给是为了容错
  // （有些 URL 会 404），不是为了多存。
  // 代价：从全并发变成小批并发，慢一点；换来的是"盘上有什么 = 报了什么"。
  const out = [];
  const BATCH = 3;
  for (let i = 0; i < images.length && out.length < stopAfter; i += BATCH) {
    const settled = await Promise.allSettled(
      images.slice(i, i + BATCH).map(async (img) => {
        const dl = await downloadOneImage(img.url, refsDir);
        return dl ? { ...img, ...dl } : null;
      }),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && out.length < stopAfter) out.push(r.value);
    }
  }
  return out;
}
