/**
 * lib/artifact-thumb.js — 画布远景的产物缩略图（09-17，问题库 iss_mu0v5pa5_3ojg）
 *
 * ## 为什么要有
 *
 * 画布上的站点 / deck 卡只在镜头够近（ArtifactCard 的 PREVIEW_MIN_SCALE）且在视口里时挂活
 * iframe；拉远以后原来只画横线纸加一个形态图标。电脑上分级渲染是关的，拉远看全貌是常态，
 * 于是用户看到的是「固定画幅页面在卡上是空白缩略图，只能双击开窗才看得到」。远景改用服务端
 * 截一张图：截图本身沿用首页封面那一路（lib/cover.js 的 renderCoverShot，取景口径相同：
 * 站点 1440×900 首屏，与卡上活预览的 1440 设备宽一致；deck 按真实画幅）。
 *
 * ## 缓存与失效
 *
 * 缓存键 = 形态 | 入口路径 | 源签名 | 出图宽 | 渲染代号。源签名按形态取：
 *   deck —— 入口文件的 mtime 与大小（deck 是单文件）；
 *   site —— 入口 html 的 mtime 与大小，加上站点根下**非 html** 文件与各级目录的最大 mtime、
 *           文件数、总大小。口径同前端 versionOfSitePage：css / js / 图片改了要重截，别的页面
 *           的 html 改了不重截。目录 mtime 进来是为了接住删文件和改名（mv 不改文件 mtime）。
 * 一个产物只留一张：写入新图后删掉同一产物的旧图（按入口路径哈希作文件名前缀），缓存不随改动次数长。
 *
 * ## 限流（这台机器 1 vCPU，每起一次 chromium 都贵）
 *
 *   1. 自己一条串行队列：拉远时一屏十几张卡同时要图，也只一个一个截。
 *   2. 开浏览器过 gatedBrowser（helpers/browser-slots.js）：跟 agent 的感知工具抢同一组槽位，
 *      不会在 profile_scroll 量帧时间时另起一只 chromium 把数搅乱。首页封面不过这道闸（用户在等），
 *      缩略图是锦上添花，排在 agent 后面。封面队列与本队列各自串行，两边加起来同时最多一只不过闸的。
 *   3. 同一个缓存键在飞时合并成一次渲染。
 *   4. 排到时先看：同一产物已有更新的请求（源又变了）→ 这一版不截，等最新那版的结果；
 *      请求方都已断开（镜头拉回、卡移出视口）→ 不截。
 *   5. 截失败的键记十分钟，期间直接回「没有图」，不反复起 chromium（改了文件签名就变，自然重试）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { platform } from '../runtime/platform.js';
import { resolveArtifactFile } from './artifact-file-path.js';
import { loadIgnore, HARD_IGNORE_DIRS, RESERVED_DIRS } from './task-scan.js';
import { renderCoverShot } from './cover.js';
import { launchPerceptionBrowser } from '../engine/mcp/tools/helpers/perception-page.js';
import { gatedBrowser } from '../engine/mcp/tools/helpers/browser-slots.js';

/** 只有这两种形态是「html 入口 + 浏览器里跑」的卡 */
export const THUMB_KINDS = new Set(['deck', 'site']);
/** 渲染管线换代时改它，旧图自然作废（同 cover.js 的 RENDER_GEN 那一课） */
const RENDER_GEN = 'thumb-v1';
const OUT_WIDTH = 800;
export const FAIL_TTL_MS = 10 * 60_000;
/** 站点签名的扫描深度与条目上限：再深再多的工作区就只看前面这些（签名可能漏掉极深处的改动） */
const WALK_DEPTH = 4;
const WALK_CAP = 3000;
/** 站点根是工作区根时要跳过的目录：保留目录里只有 assets 可能被页面引用（生图住那儿） */
const SKIP_DIRS = new Set([...RESERVED_DIRS].filter(d => d !== 'assets'));

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/**
 * 站点的源签名。
 * @param {string} entryAbs  入口 html 绝对路径
 * @param {string} sharedRoot 工作区根（.ndignore 的基准）
 */
export async function siteSignature(entryAbs, sharedRoot) {
  const st = await fs.stat(entryAbs);
  const baseAbs = path.dirname(entryAbs);
  const ignore = await loadIgnore(sharedRoot);
  let maxMtime = 0; let count = 0; let bytes = 0; let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > WALK_DEPTH || seen >= WALK_CAP) return;
    let dst;
    try { dst = await fs.stat(dir); } catch { return; }
    maxMtime = Math.max(maxMtime, dst.mtimeMs);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));   // 撞上限时每次截的是同一批，签名才稳定
    for (const e of entries) {
      if (seen >= WALK_CAP) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(sharedRoot, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (HARD_IGNORE_DIRS.has(e.name) || ignore(rel, true)) continue;
        if (dir === sharedRoot && SKIP_DIRS.has(e.name)) continue;
        seen += 1;
        await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || /\.html?$/i.test(e.name) || ignore(rel, false)) continue;
      seen += 1;
      try {
        const fst = await fs.stat(abs);
        maxMtime = Math.max(maxMtime, fst.mtimeMs); count += 1; bytes += fst.size;
      } catch { /* 扫描途中被删：下一次签名自然不同 */ }
    }
  };
  await walk(baseAbs, 1);
  return `${st.mtimeMs}:${st.size}|${maxMtime}|${count}|${bytes}`;
}

async function deckSignature(entryAbs) {
  const st = await fs.stat(entryAbs);
  return `${st.mtimeMs}:${st.size}`;
}

/** 真截图：封面那一路，浏览器过槽位闸 */
function defaultRender(target, { pid, sharedDir }) {
  return renderCoverShot(target, { projectId: pid, workspaceRoot: sharedDir }, {
    launch: () => gatedBrowser(() => launchPerceptionBrowser(), { key: pid }),
  });
}

/**
 * @param {object} [deps]  测试注入：cacheRoot（缓存根）、render（假截图函数）、now（时钟）
 */
export function makeThumbService({
  cacheRoot = path.join(platform.cacheRoot, 'covers'),
  render = defaultRender,
  now = Date.now,
} = {}) {
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  /** etag → { promise, waiters:Set<() => boolean> } */
  const inflight = new Map();
  /** etag → 失败时刻 */
  const failedAt = new Map();
  /** 产物 → 最新一次请求算出的 etag（排到时据此判断自己是不是已经过时） */
  const latestEtag = new Map();

  const noteFailure = (etag) => {
    const t = now();
    failedAt.set(etag, t);
    if (failedAt.size > 500) {
      for (const [k, at] of failedAt) if (t - at >= FAIL_TTL_MS) failedAt.delete(k);
    }
  };

  async function prune(dir, prefix, keep) {
    let names = [];
    try { names = await fs.readdir(dir); } catch { return; }
    await Promise.all(names
      .filter(n => n.startsWith(prefix) && n !== keep && n.endsWith('.webp'))
      .map(n => fs.rm(path.join(dir, n), { force: true }).catch(() => {})));
  }

  /** 已完成的键：读盘；在飞的键：等它 */
  async function resultOf(etag, file) {
    const job = inflight.get(etag);
    if (job) return job.promise;
    try { return { buffer: await fs.readFile(file) }; } catch { return { skipped: 'failed' }; }
  }

  /**
   * @param {{ pid: string, sharedDir: string, relPath: string, kind: string,
   *   ifNoneMatch?: string, isGone?: () => boolean }} q
   * @returns {Promise<{status: 200, etag: string, buffer: Buffer} | {status: 304, etag: string}
   *   | {status: 204, reason: string} | {status: 400|403|404, error: string}>}
   */
  async function get({ pid, sharedDir, relPath, kind, ifNoneMatch, isGone = () => false }) {
    if (!THUMB_KINDS.has(kind)) return { status: 400, error: 'kind must be deck or site' };
    const rel0 = String(relPath || '').replace(/\\/g, '/');
    if (!/\.html?$/i.test(rel0)) return { status: 400, error: 'path must be an .html entry' };
    // 路径判据（越界 / 软链 realpath 复核 / 点目录白名单）跟 artifact-file 路由同一份
    const resolved = await resolveArtifactFile(sharedDir, rel0);
    if (!resolved.ok) return { status: resolved.status, error: resolved.error };
    const { absPath, sharedRoot, subPath: rel } = resolved;

    let sig;
    try {
      sig = kind === 'site' ? await siteSignature(absPath, sharedRoot) : await deckSignature(absPath);
    } catch { return { status: 404, error: 'file not found' }; }
    const relHash = sha1(`${kind}|${rel}`).slice(0, 16);
    const etagOf = (s) => sha1(`${kind}|${rel}|${s}|${OUT_WIDTH}|${RENDER_GEN}`);
    const etag = etagOf(sig);
    if (ifNoneMatch === `"${etag}"`) return { status: 304, etag };

    const dir = path.join(cacheRoot, pid, 'thumbs');
    const fileOf = (e) => path.join(dir, `${relHash}-${e}.webp`);
    const file = fileOf(etag);
    try { return { status: 200, etag, buffer: await fs.readFile(file) }; } catch { /* 未命中 */ }

    const at = failedAt.get(etag);
    if (at !== undefined && now() - at < FAIL_TTL_MS) return { status: 204, reason: 'failed' };

    const relKey = `${pid}|${relHash}`;
    latestEtag.set(relKey, etag);
    let job = inflight.get(etag);
    if (!job) {
      job = { waiters: new Set() };
      const self = job;
      job.promise = enqueue(async () => {
        if (latestEtag.get(relKey) !== etag) return { skipped: 'superseded' };
        if (self.waiters.size && [...self.waiters].every(g => g())) return { skipped: 'gone' };
        try { return { buffer: await fs.readFile(file) }; } catch { /* 排队期间没人截过 */ }
        try {
          const buffer = await render({ absPath, kind, relPath: rel }, { pid, sharedDir });
          await fs.mkdir(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;   // 先写临时名再改名：并发读的人读不到半张图
          await fs.writeFile(tmp, buffer);
          await fs.rename(tmp, file);
          await prune(dir, `${relHash}-`, path.basename(file));
          failedAt.delete(etag);
          return { buffer };
        } catch (err) {
          noteFailure(etag);
          console.warn('[thumb] render failed:', rel, err?.message || err);
          return { skipped: 'failed' };
        }
      }).finally(() => { if (inflight.get(etag) === self) inflight.delete(etag); });
      inflight.set(etag, job);
    }
    job.waiters.add(isGone);

    let out = await job.promise;
    // 过时的那一版没截：跟着这个产物最新的那一版走（回它的图、它的 etag）
    let cur = etag;
    for (let hop = 0; out.skipped === 'superseded' && hop < 3; hop += 1) {
      const newer = latestEtag.get(relKey);
      if (!newer || newer === cur) break;
      cur = newer;
      out = await resultOf(newer, fileOf(newer));
    }
    if (out.buffer) return { status: 200, etag: cur, buffer: out.buffer };
    return { status: 204, reason: out.skipped || 'failed' };
  }

  return { get, _inflight: inflight, _failedAt: failedAt };
}

export const thumbService = makeThumbService();
