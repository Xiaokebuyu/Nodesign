/**
 * render.js — docx → PDF → PNG 的 QC 渲染链路。
 *
 * ⭐**必须是异步的。** 第一版写成 `execFileSync`，实测一份 55 页中文文档
 * 把事件循环**整整堵死 11.7 秒** —— 期间全站所有 HTTP、WebSocket 心跳、
 * agent 流式输出一起停摆。而触发它的不是"用户主动导出"，是**一张卡片滚进
 * 视口**：画布上有人放了一份长文档，所有人的站就冻一次。
 * node 是单线程，凡是要等外部进程的地方一律不许用 *Sync。
 *
 * 三条已实证的军规：
 *   1. per-run 独立 LO profile + 可写 HOME（多会话并发抢默认 profile 是必然事件）
 *   2. soffice 吃不下中文文件名 → 进场先拷成 ASCII 名
 *   3. FONTCONFIG_FILE 指向 fonts/nodesign-cjk.conf（中文字体替身映射，
 *      per-run 生效，不污染系统 fontconfig）
 *
 * ⚠️ 失败也要收摊：`mkdtemp` 一建出来就进 try，任何一步抛都在 finally 里删掉
 * scratch —— 第一版是"抛了就拿不到 res，调用方无从 cleanup"，每失败一次漏
 * 一个约 870KB 的目录在 /tmp（跟数据库抢同一个根分区）。
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileUrl } from '../file-url.js';
// 二进制路径走启动探测（Mac/Win 的 LibreOffice 不在 PATH；没探到就原名让 ENOENT 原样报）
import { resolveBinary } from '../../runtime/capabilities.js';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const FONTCONF = join(HERE, 'fonts', 'nodesign-cjk.conf');

/** 单份文档的渲染上限。超时的天花板同时也是"最坏情况占用一个 soffice 槽多久" */
const SOFFICE_TIMEOUT = 120_000;
const PDFTOPPM_TIMEOUT = 60_000;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * @param {string} docxPath
 * @param {object} opts { pngPages?: [from,to] | true, dpi?: number, timeoutMs?: number }
 * @returns {Promise<{ pdf: string, pngs: string[], scratch: string, ms: number }>}
 *   产物落在独立 scratch 目录里，**调用方成功拿到之后自己收**（cleanupRender）。
 *   失败的话这里已经收干净了，调用方不用管。
 */
export async function renderDocx(docxPath, opts = {}) {
  const scratch = await fs.mkdtemp(join(tmpdir(), 'ndocx-'));
  const t0 = Date.now();
  try {
    const inFile = join(scratch, 'in.docx');       // 军规2：ASCII 文件名
    await fs.copyFile(docxPath, inFile);
    const env = {
      ...process.env,
      HOME: scratch,                                // 军规1：可写 HOME
      FONTCONFIG_FILE: FONTCONF,                    // 军规3：字体替身
    };
    await run(resolveBinary('libreoffice', 'soffice'), [
      // 军规1：独立 profile。⚠️ 必须是**真的 file URL**（fileUrl 而不是 'file://' + 路径）：
      // Windows 上拼出来的 `file://C:\…` 会让 LO 弹「bootstrap.ini 已经损坏」后退 1（见 lib/file-url.js）
      `-env:UserInstallation=${fileUrl(join(scratch, 'loprofile'))}`,
      '--headless', '--convert-to', 'pdf', '--outdir', scratch, inFile,
    ], { env, timeout: opts.timeoutMs ?? SOFFICE_TIMEOUT });

    const pdf = join(scratch, 'in.pdf');
    if (!await exists(pdf)) throw new Error('soffice produced no pdf');

    const pngs = [];
    if (opts.pngPages) {
      const args = ['-png', '-r', String(opts.dpi ?? 120)];
      if (Array.isArray(opts.pngPages)) {
        args.push('-f', String(opts.pngPages[0]), '-l', String(opts.pngPages[1]));
      }
      await run(resolveBinary('poppler', 'pdftoppm'), [...args, pdf, join(scratch, 'page')], { timeout: PDFTOPPM_TIMEOUT });
      // pdftoppm 按总页数补零（55 页 → page-01…page-55），宽度统一，
      // 所以字典序等于数字序 —— 这条核过，不是碰运气
      for (const f of (await fs.readdir(scratch)).sort()) {
        if (f.startsWith('page-') && f.endsWith('.png')) pngs.push(join(scratch, f));
      }
    }
    return { pdf, pngs, scratch, ms: Date.now() - t0 };
  } catch (err) {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export async function cleanupRender(res) {
  if (!res?.scratch) return;
  await fs.rm(res.scratch, { recursive: true, force: true }).catch(() => {});
}
