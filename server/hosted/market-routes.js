/**
 * server/hosted/market-routes.js — skill 市场的 HTTP 面（2026-09-08 开线）
 *
 * 同一个路由器挂两处，处理函数一份：
 *   - /api/market         网页：cookie 登录墙之后，req.user
 *   - /api/relay/market   桌面版：设备令牌（relay 的 deviceAuth），req.relayUser
 * 谁在说话由 userOf(req) 回答，其余一个字不差。错误一律 { error, code }：网页端直接读 error，
 * relay-client.call() 也认这个形状（json.error）。
 *
 *   GET    /                  货架（approved；精选靠前）+ 我装过哪些
 *   GET    /mine              我发布过的（任何状态）
 *   GET    /featured          首页项目区要混入的精选：数量 = max(0, 6 - 我的项目数)，排掉我自己的
 *   GET    /:id               详情（含 SKILL.md 全文）。非 approved 只给作者和 admin
 *   GET    /:id/images/:n     参考图（webp）
 *   POST   /                  发布（multipart）：title, note, images[]≤6；skill 二选一 —— 文件字段 skill（桌面版打好的 zip）
 *                             或 skillName（网页：从我装着的 plugin 打包）。没传图而给了 showcaseId 就用那件作品截封面
 *   DELETE /:id               作者撤回
 *   POST   /:id/install       网页：装进我的 plugin 根（?force=1 覆盖同名），并记一笔
 *   GET    /:id/download      桌面版：拿 skill 原字节回本机装
 *   POST   /:id/installed     桌面版：本机装成了，记一笔
 *
 * 发布不看档位（09-08 站主：所有档位都能发，我来审）。能力位留在 tier.js 的 CAPABILITIES 里
 * （publishSkill / installMarketSkill），今天全 true，要收紧改那张表。
 */

import express from 'express';
import multer from 'multer';
import JSZip from 'jszip';

import { can } from '../auth/tier.js';
import { getProject, countProjects } from '../projects/store.js';
import { getSharedDir } from '../projects/workspace.js';
import { getEntry as getShowcaseEntry } from '../lib/showcase-store.js';
import { getArtifactCover } from '../lib/cover.js';
import { validateSkillUpload, LIMITS } from '../lib/plugin-validator.js';
import { installPluginToRoot } from '../lib/plugin-install.js';
import { writePluginOrigin } from '../lib/plugin-origin.js';
import { packPluginDir, findUserPluginDir } from '../lib/plugin-pack.js';
import { getUserPluginsRoot } from '../engine/agent/plugin-loader.js';
import {
  createPublication, getPublication, listApproved, listByUser, listFeatured, featuredSlotsFor,
  withdrawPublication, readSkillBuffer, readSkillMd, readImage, recordInstall, installedIdsFor,
  normalizeImage, IMAGE_MAX_COUNT, IMAGE_MAX_UPLOAD, TITLE_MAX, NOTE_MAX,
} from './market-store.js';

const ID_RE = /^pub_[a-z0-9]+_[a-f0-9]{6}$/;

function fail(res, status, code, error) { return res.status(status).json({ error, code }); }

/**
 * 市场只收单 skill、只有 SKILL.md 的包（+ .claude-plugin/plugin.json）。多一个文件就拒 —— 审核台只展示 SKILL.md，
 * 别的文件站主看不到，看不到的不能发。单文件模式天然满足。
 */
async function onlyOneSkillMd(buffer, validation) {
  if (validation.mode === 'single-md') return { ok: true };
  const zip = await JSZip.loadAsync(buffer);
  const prefix = validation.rootPrefix || '';
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).map((n) => n.slice(prefix.length));
  const skillMds = names.filter((n) => /^skills\/[^/]+\/SKILL\.md$/.test(n));
  const others = names.filter((n) => !/^skills\/[^/]+\/SKILL\.md$/.test(n) && n !== '.claude-plugin/plugin.json');
  if (skillMds.length !== 1) return { ok: false, reason: `市场只收单个 skill（包里有 ${skillMds.length} 个 SKILL.md）` };
  if (others.length) return { ok: false, reason: `市场只收 SKILL.md 本身，包里多了：${others.slice(0, 5).join('、')}${others.length > 5 ? '…' : ''}` };
  return { ok: true };
}

/** 第一份 SKILL.md 的正文：给详情页看。单文件模式就是上传内容本身；zip 找第一个 SKILL.md */
async function extractFirstSkillMd(buffer, validation) {
  if (validation.mode === 'single-md') return buffer.toString('utf8');
  const zip = await JSZip.loadAsync(buffer);
  const prefix = validation.rootPrefix || '';
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const pick = names.find((n) => n.startsWith(prefix) && /^skills\/[^/]+\/SKILL\.md$/.test(n.slice(prefix.length)))
    || names.find((n) => /(^|\/)SKILL\.md$/.test(n));
  return pick ? zip.file(pick).async('string') : '';
}

/** 详情页给的形状：去掉作者 id 以外的内部字段，补上 installed */
function publicView(pub, installed) {
  // reviewNote / reviewedAt 是站主的内部批注（09-08 审出漏到货架上）
  const { userId, skillSha256, skillMode, reviewedBy, reviewNote, reviewedAt, ...rest } = pub;
  return { ...rest, installed: installed?.has(pub.id) || false };
}

/**
 * @param {object} opts
 * @param {(req) => object|null} opts.userOf   这次请求的用户（网页 req.user / relay req.relayUser）
 * @param {'web'|'desktop'} opts.source        记在发布和安装上的来源
 */
export function createMarketRouter({ userOf, source }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(LIMITS.ZIP_MAX_BYTES, IMAGE_MAX_UPLOAD), files: IMAGE_MAX_COUNT + 1 },
  });

  router.use((req, res, next) => {
    req.marketUser = userOf(req);
    if (!req.marketUser?.id) return fail(res, 401, 'UNAUTHENTICATED', '需要登录');
    next();
  });

  router.get('/', (req, res) => {
    const installed = installedIdsFor(req.marketUser.id);
    res.json({ items: listApproved().map((p) => publicView(p, installed)) });
  });

  router.get('/mine', (req, res) => {
    res.json({ items: listByUser(req.marketUser.id) });
  });

  router.get('/featured', (req, res) => {
    const own = countProjects({ kind: 'project', owner: req.marketUser.id });
    const slots = featuredSlotsFor(own);
    const installed = installedIdsFor(req.marketUser.id);
    res.json({ slots, ownProjects: own, items: listFeatured({ excludeUserId: req.marketUser.id, limit: slots }).map((p) => publicView(p, installed)) });
  });

  router.param('id', (req, res, next, id) => {
    if (!ID_RE.test(id)) return fail(res, 404, 'NOT_FOUND', '没有这条发布');
    const pub = getPublication(id);
    if (!pub) return fail(res, 404, 'NOT_FOUND', '没有这条发布');
    const me = req.marketUser;
    req.isOwner = pub.userId === me.id;
    req.isAdmin = me.role === 'admin';
    // 非 approved 的只有作者和站主看得见；对外一律 404（别让人枚举待审队列）
    if (pub.state !== 'approved' && !req.isOwner && !req.isAdmin) return fail(res, 404, 'NOT_FOUND', '没有这条发布');
    req.publication = pub;
    next();
  });

  router.get('/:id', async (req, res) => {
    const pub = req.publication;
    const installed = installedIdsFor(req.marketUser.id);
    const view = req.isOwner || req.isAdmin ? { ...pub, installed: installed.has(pub.id) } : publicView(pub, installed);
    res.json({ publication: view, skillMd: await readSkillMd(pub.id) });
  });

  router.get('/:id/images/:n', async (req, res) => {
    const buf = await readImage(req.publication.id, req.params.n);
    if (!buf) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/webp').send(buf);
  });

  router.post('/', upload.fields([{ name: 'images', maxCount: IMAGE_MAX_COUNT }, { name: 'skill', maxCount: 1 }]), async (req, res, next) => {
    try {
      const me = req.marketUser;
      if (!can(me, 'publishSkill')) return fail(res, 403, 'TIER_DENIED', '当前档位不能发布到市场');
      const title = String(req.body?.title || '').trim();
      const note = String(req.body?.note || '').trim();
      if (!title) return fail(res, 400, 'BAD_INPUT', '标题不能为空');
      if (title.length > TITLE_MAX) return fail(res, 400, 'BAD_INPUT', `标题最长 ${TITLE_MAX} 字`);
      if (note.length > NOTE_MAX) return fail(res, 400, 'BAD_INPUT', `说明最长 ${NOTE_MAX} 字`);

      // skill 字节：桌面版直接给文件；网页给名字、这边从他装着的那份打包
      let skillBuffer = req.files?.skill?.[0]?.buffer || null;
      if (!skillBuffer) {
        const skillName = String(req.body?.skillName || '').trim();
        if (!skillName) return fail(res, 400, 'BAD_INPUT', '要发布哪个 skill？给 skillName 或上传 skill 文件');
        const hit = await findUserPluginDir(me.id, skillName);
        if (!hit) return fail(res, 404, 'SKILL_NOT_FOUND', `你的 skill 库里没有「${skillName}」`);
        try { skillBuffer = (await packPluginDir(hit.dir)).buffer; }
        catch (err) { return fail(res, 400, 'PACK_FAILED', `打包失败：${err.message}`); }
      }
      const validation = await validateSkillUpload(skillBuffer);
      if (!validation.ok) return res.status(400).json({ error: 'skill 没过校验', code: 'VALIDATION_FAILED', errors: validation.errors });
      // 市场 v1 只收**一个 skill、只有 SKILL.md**（09-08 审出：审核台只看第一份 SKILL.md，多 skill / 附件里的东西站主看不到就过审了）。
      // 「站主逐条看过全文」这句承诺要成立，包里就只能有站主看得到的那一份。
      const single = await onlyOneSkillMd(skillBuffer, validation);
      if (!single.ok) return fail(res, 400, 'MULTI_FILE_SKILL', single.reason);

      // 参考图：上传的优先；没传而带了 showcaseId 就截那件作品的封面
      const images = [];
      for (const f of req.files?.images || []) {
        if (f.size > IMAGE_MAX_UPLOAD) return fail(res, 413, 'IMAGE_TOO_LARGE', `图片 ${f.originalname} 超过 8MB`);
        try { images.push(await normalizeImage(f.buffer)); }
        catch (err) { return fail(res, 400, 'BAD_IMAGE', `图片 ${f.originalname} 无法处理：${err.message}`); }
      }
      const showcaseId = String(req.body?.showcaseId || '').trim() || null;
      if (!images.length && showcaseId) {
        const entry = getShowcaseEntry(showcaseId);
        if (entry && entry.userId === me.id && entry.projectId && entry.artifactRel && getProject(entry.projectId)) {
          try {
            const shot = await getArtifactCover(entry.projectId, getSharedDir(entry.projectId), entry.artifactRel);
            if (shot?.buffer) images.push(await normalizeImage(shot.buffer));
          } catch (err) { console.warn('[market] 截封面失败:', err.message); }
        }
      }
      if (!images.length) return fail(res, 400, 'NO_IMAGE', '至少要一张参考图（截图或上传）');

      const skillMd = await extractFirstSkillMd(skillBuffer, validation);
      const publication = await createPublication({ userId: me.id, skillBuffer, validation, skillMd, images, title, note: note || null, source, showcaseId });
      res.status(201).json({ publication, warnings: validation.warnings || [] });
    } catch (err) { next(err); }
  });

  router.delete('/:id', (req, res) => {
    if (!withdrawPublication(req.publication.id, req.marketUser.id)) return fail(res, 409, 'NOT_WITHDRAWABLE', '只能撤回自己的、还挂着的发布');
    res.status(204).end();
  });

  // 网页：装进请求者自己的 plugin 根。同名已装 → 409 带 existing/incoming（跟 /api/plugins/install 同形）
  router.post('/:id/install', async (req, res, next) => {
    try {
      const me = req.marketUser;
      if (!can(me, 'installMarketSkill')) return fail(res, 403, 'TIER_DENIED', '当前档位不能安装市场里的 skill');
      const pub = req.publication;
      if (pub.state !== 'approved') return fail(res, 409, 'NOT_APPROVED', '这条发布还没通过审核');
      const root = getUserPluginsRoot(me.id);
      if (!root) return fail(res, 401, 'UNAUTHENTICATED', '需要登录');
      const force = req.query.force === '1' || req.query.force === 'true';
      const r = await installPluginToRoot(await readSkillBuffer(pub.id), root, { force });
      if (r.status === 200 || r.status === 201) {
        await writePluginOrigin(r.body.installed.path, { publicationId: pub.id, skillSha256: pub.skillSha256 });
        recordInstall({ publicationId: pub.id, userId: me.id, skillSha256: pub.skillSha256, source });
      }
      res.status(r.status).json(r.body);
    } catch (err) { next(err); }
  });

  router.get('/:id/download', async (req, res, next) => {
    try {
      const pub = req.publication;
      // 站主要能下待审的包看原件（09-08）；别人只能下 approved 的
      if (pub.state !== 'approved' && !req.isOwner && !req.isAdmin) return fail(res, 409, 'NOT_APPROVED', '这条发布还没通过审核');
      const buf = await readSkillBuffer(pub.id);
      res.set('X-ND-Skill-Sha256', pub.skillSha256);
      res.type(pub.skillMode === 'single-md' ? 'text/markdown' : 'application/zip').send(buf);
    } catch (err) { next(err); }
  });

  router.post('/:id/installed', (req, res) => {
    const pub = req.publication;
    // 跟 /install 同一道闸（09-08）：没过审的不能记装机，档位不许装的也不能记
    if (!can(req.marketUser, 'installMarketSkill')) return fail(res, 403, 'TIER_DENIED', '当前档位不能安装市场里的 skill');
    if (pub.state !== 'approved') return fail(res, 409, 'NOT_APPROVED', '这条发布还没通过审核');
    recordInstall({ publicationId: pub.id, userId: req.marketUser.id, skillSha256: pub.skillSha256, source });
    res.json({ ok: true });
  });

  router.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'BODY_TOO_LARGE', '文件太大');
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') return fail(res, 400, 'BAD_INPUT', `最多 ${IMAGE_MAX_COUNT} 张图 + 1 个 skill 文件`);
    next(err);
  });

  return router;
}
