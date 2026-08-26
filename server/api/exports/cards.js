/**
 * api/exports/cards.js — 按**产物卡**导出（2026-08-17 重做导出的入口）
 *
 * 从 exports.js 拆出来（行数棘轮：那份已经贴着上限）。放这儿也更对 ——
 * 它跟老的四条烘焙路由（html/pdf/pptx/site）不是一档东西：
 *   老路由 = **烘焙**，要跑 playwright / esbuild，产出是「给人看的文件」。
 *   本路由 = **原样打包**，产出是「别人能接手继续开发的工程」。
 *
 * 旧导出以「会话当前产物」为单位，且把整个项目级 `shared/assets` 打进包
 * （生产上最大的项目那目录 280MB）。新的以**画布上的那张卡**为单位：卡的类型
 * 决定收什么，素材只收这份产物真正引用到的。
 */

import { collectCards } from '../../lib/export-collect.js';
import { packageBundles } from '../../lib/export-package.js';

import { msg } from '../../shared/messages.js';
const FORMATS = ['raw', 'zip', 'md', 'handoff'];
const MAX_CARDS = 200;

/**
 * 并发闸。
 *
 * 打包是这台机器上最重的同步活：每个文件整读进内存，JSZip 的 DEFLATE 又在主线程
 * 跑。生产机是 **1 vCPU / 8G / 无 swap**（尖峰直接进内核 OOM killer），压缩期间
 * 唯一那颗核被占住，所有 SSE 与 agent 流一起饿着。没有闸的话，任何登录用户连点
 * 几下导出就能把整台机器拖垮 —— 而且症状是「网站卡住」，没人会怀疑到导出头上。
 *
 * 全局 2 是按核数定的，不是按用户：护的是机器不是公平性。per-project 再压 1，
 * 免得一个人连点把两个位置都占满。
 *
 * ⚠️ 这只挡住**同时几个**，挡不住**单个太大**（200 张视频卡可以到 GB 级）。
 * 体积闸是另一件事，还没做。
 */
const MAX_INFLIGHT = 2;
let inflight = 0;
const inflightByProject = new Map();

/**
 * @param {object} deps
 * @param {(req,res)=>object|null} deps.guard   exports.js 的 guard（项目/会话双挂载）
 * @param {(req)=>string} deps.rootOf           工作区根
 */
export function makeCardsExportHandler({ guard, rootOf }) {
  return async function handleCardsExport(req, res, next) {
    try {
      const project = guard(req, res);
      if (!project) return;
      const { cardIds, format } = req.body || {};
      if (!Array.isArray(cardIds) || !cardIds.length) {
        return res.status(400).json({ error: msg(req, '要导出哪几张卡（cardIds 不能为空）') });
      }
      if (cardIds.length > MAX_CARDS) {
        return res.status(400).json({ error: msg(req, '一次最多导出 {max} 张卡', { max: MAX_CARDS }) });
      }
      if (!FORMATS.includes(format)) {
        return res.status(400).json({ error: msg(req, '不认识的导出格式：{format}', { format }) });
      }

      if (inflight >= MAX_INFLIGHT) {
        res.setHeader('Retry-After', '10');
        return res.status(429).json({ error: msg(req, '导出排队中（这台机器一次只打两个包），过几秒再点') });
      }
      if (inflightByProject.get(project.id)) {
        res.setHeader('Retry-After', '10');
        return res.status(429).json({ error: msg(req, '这个项目已经有一个导出在跑了，等它完事') });
      }
      inflight += 1;
      inflightByProject.set(project.id, true);
      try {
      const workspaceRoot = rootOf(req);
      const { bundles, skipped } = await collectCards({ workspaceRoot, cardIds });
      if (!bundles.length) {
        return res.status(skipped[0]?.status === 404 ? 404 : 400)
          .json({ error: msg(req, '一张都没收到'), skipped });
      }

      // 格式合法性由 packageBundles 自己把关（raw 要单文件、md 要有 markdown），
      // 不在这儿再抄一份判据。⚠️ 曾经拿 `bundle.exportFormats.includes(format)`
      // 当闸，是错的：那张表说的是**产物形态**能出什么（site 卡是 site/html/handoff），
      // 跟本路由的打包档（zip/raw/md/handoff）语义不同，混用会把正常请求判死。
      const { filename, buffer, mime } = await packageBundles(bundles, {
        format,
        projectName: bundles.length === 1 ? bundles[0].title : project.name,
      });

      // 收不到的卡不拖累整批，但**必须让前端能说出少了哪几张**。
      // 静默少东西是导出最贵的失败方式：用户解压之后才发现，那时已经不知道
      // 是哪一步丢的。
      if (skipped.length) {
        // ⚠️ 头要封顶。中文经 UTF-8 + 百分号编码大约 9 倍膨胀，100 条 skipped
        // 实测 32KB —— nginx 默认 proxy_buffer_size 4k/8k，超了就是
        // "upstream sent too big header" → **502，打好的 zip 一个字节都到不了用户**。
        // 卡 id 长度也不设限的话，一个恶意长 id 单发就能触发。
        const items = skipped.slice(0, 20).map(x => ({
          cardId: String(x.cardId).slice(0, 120),
          reason: String(x.reason).slice(0, 120),
          status: x.status,
        }));
        let v = encodeURIComponent(JSON.stringify({ total: skipped.length, items }));
        if (v.length > 4000) v = encodeURIComponent(JSON.stringify({ total: skipped.length, items: [] }));
        res.setHeader('X-Export-Skipped', v);
      }
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
      } finally {
        // finally 不能漏：抛错时不减计数 = 闸门永久卡死，两次失败之后
        // 这个功能就再也用不了了，而且重启前查不出原因
        inflight -= 1;
        inflightByProject.delete(project.id);
      }
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}
