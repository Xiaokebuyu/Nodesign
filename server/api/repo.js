/**
 * server/api/repo.js — 仓库卡的接口（2026-09-08 存量仓库道·第二段）。只在本地版挂载（index.js）。
 *
 *   GET /api/projects/:pid/repo                     分支 / 上次提交 / 改动计数；不是仓库项目 → 404
 *   GET /api/projects/:pid/repo/tree?path=<rel>     列一层，每条带 git 状态
 *   GET /api/projects/:pid/repo/file?path=<rel>     文本内容给代码阅读器（512KB 封顶）
 *   GET /api/projects/:pid/repo/raw?path=<rel>      pdf / 图 / 音视频原样送（CSP sandbox，不跑脚本）
 *   GET /api/projects/:pid/repo/pdf?path=<rel>      word 等转 PDF（要 LibreOffice，没有 501）
 *   GET /api/projects/:pid/repo/turns                最近几轮：每轮改了什么（09-08 改道安全网）
 *   POST /api/projects/:pid/repo/turns/:runId/revert 回到这一轮开工之前（只动工作树）
 *
 * 看是只读的；revert 是唯一会写工作树的动作，只还原快照里有的路径。
 */

import express from 'express';
import { guardProject } from './_guard.js';
import { repoSummary, repoTree, repoFile, listTurns, revertToTurn, repoRawFile, repoDocPdf } from '../projects/repo.js';

const router = express.Router();

function fail(res, err) {
  if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

router.get('/:pid/repo', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const summary = await repoSummary(req.params.pid);
    if (!summary) return res.status(404).json({ error: '这个项目没有仓库卡', code: 'NOT_REPO_PROJECT' });
    res.json(summary);
  } catch (err) { next(err); }
});

router.get('/:pid/repo/tree', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await repoTree(req.params.pid, typeof req.query.path === 'string' ? req.query.path : ''));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.get('/:pid/repo/file', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await repoFile(req.params.pid, typeof req.query.path === 'string' ? req.query.path : ''));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

// 原样预览一律 sandbox：文件是用户仓库里的，不能在本站 origin 下跑脚本（svg/html 本来就不在白名单里，这是第二道）
const RAW_HEADERS = { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'self'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

router.get('/:pid/repo/raw', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { abs, mime } = await repoRawFile(req.params.pid, typeof req.query.path === 'string' ? req.query.path : '');
    res.set({ ...RAW_HEADERS, 'Content-Type': mime, 'Content-Disposition': 'inline' });
    res.sendFile(abs);
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.get('/:pid/repo/pdf', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    const { buf } = await repoDocPdf(req.params.pid, typeof req.query.path === 'string' ? req.query.path : '');
    res.set({ ...RAW_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' });
    res.send(buf);
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

router.get('/:pid/repo/turns', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json({ turns: await listTurns(req.params.pid) });
  } catch (err) { next(err); }
});

router.post('/:pid/repo/turns/:runId/revert', async (req, res, next) => {
  try {
    if (!guardProject(req, res)) return;
    res.json(await revertToTurn(req.params.pid, req.params.runId));
  } catch (err) { try { fail(res, err); } catch (e) { next(e); } }
});

export default router;
