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
import { getProject, countProjects, createProject } from '../projects/store.js';
import { getSharedDir, ensureProjectWorkspace } from '../projects/workspace.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getEntry as getShowcaseEntry } from '../lib/showcase-store.js';
import { getArtifactCover } from '../lib/cover.js';
import { validateSkillUpload, LIMITS } from '../lib/plugin-validator.js';
import { installPluginToRoot } from '../lib/plugin-install.js';
import { writePluginOrigin } from '../lib/plugin-origin.js';
import { packPluginDir, findUserPluginDir } from '../lib/plugin-pack.js';
import { getUserPluginsRoot } from '../engine/agent/plugin-loader.js';
import {
  createPublication, updatePublication, findOwnActive, getPublication, listApproved, listByUser, listFeatured, featuredSlotsFor,
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
 * 从"用户 + skill 名或字节 + 图片字节 + 标题说明"落一条发布。路由（multipart）和 agent 的注册口（lib/market-bridge）共用。
 * 图片是原图字节（这里 normalize）。返回 { status, body }，不碰 res。
 */
export async function publishForUser({ me, skillBuffer = null, skillName = '', kind = null, images, title, note, source, showcaseId = null }) {
  if (!can(me, 'publishSkill')) return { status: 403, body: { error: '当前档位不能发布到市场', code: 'TIER_DENIED' } };
  title = String(title || '').trim(); note = String(note || '').trim();
  if (!title) return { status: 400, body: { error: '标题不能为空', code: 'BAD_INPUT' } };
  if (title.length > TITLE_MAX) return { status: 400, body: { error: `标题最长 ${TITLE_MAX} 字`, code: 'BAD_INPUT' } };
  if (note.length > NOTE_MAX) return { status: 400, body: { error: `说明最长 ${NOTE_MAX} 字`, code: 'BAD_INPUT' } };
  skillName = String(skillName || '').trim();
  const isWork = kind === 'work' || (!skillBuffer && !skillName);
  let validation = null;
  if (!isWork) {
    if (!skillBuffer) {
      const hit = await findUserPluginDir(me.id, skillName);
      if (!hit) return { status: 404, body: { error: `你的 skill 库里没有「${skillName}」`, code: 'SKILL_NOT_FOUND' } };
      try { skillBuffer = (await packPluginDir(hit.dir)).buffer; }
      catch (err) { return { status: 400, body: { error: `打包失败：${err.message}`, code: 'PACK_FAILED' } }; }
    }
    validation = await validateSkillUpload(skillBuffer);
    if (!validation.ok) return { status: 400, body: { error: 'skill 没过校验', code: 'VALIDATION_FAILED', errors: validation.errors } };
    // 市场只收**一个 skill、只有 SKILL.md**（09-08 审出：审核台只看第一份 SKILL.md）
    const single = await onlyOneSkillMd(skillBuffer, validation);
    if (!single.ok) return { status: 400, body: { error: single.reason, code: 'MULTI_FILE_SKILL' } };
  } else skillBuffer = null;
  const normalized = [];
  for (const img of images || []) {
    if (img.buf.length > IMAGE_MAX_UPLOAD) return { status: 413, body: { error: `图片 ${img.name} 超过 8MB`, code: 'IMAGE_TOO_LARGE' } };
    try { normalized.push(await normalizeImage(img.buf)); }
    catch (err) { return { status: 400, body: { error: `图片 ${img.name} 无法处理：${err.message}`, code: 'BAD_IMAGE' } }; }
    if (normalized.length >= IMAGE_MAX_COUNT) break;
  }
  if (!normalized.length) return { status: 400, body: { error: '至少要一张参考图（截图或上传）', code: 'NO_IMAGE' } };
  const skillMd = isWork ? null : await extractFirstSkillMd(skillBuffer, validation);
  // 同一作者再发同一件东西 → 原地更新，不堆重复条目（v2）
  const existing = findOwnActive({ userId: me.id, skillName: isWork ? null : validation.manifest.name, showcaseId: isWork ? showcaseId : null });
  if (existing) {
    const publication = await updatePublication(existing.id, { skillBuffer, validation, skillMd, images: normalized, title, note: note || null });
    return { status: 200, body: { publication, updated: true, warnings: validation?.warnings || [] } };
  }
  const publication = await createPublication({ userId: me.id, skillBuffer, validation, skillMd, images: normalized, title, note: note || null, source, showcaseId });
  return { status: 201, body: { publication, warnings: validation?.warnings || [] } };
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
      const images = (req.files?.images || []).map((f) => ({ buf: f.buffer, type: f.mimetype || 'image/png', name: f.originalname || 'shot' }));
      // 没传图而带了 showcaseId：截那件作品的封面
      const showcaseId = String(req.body?.showcaseId || '').trim() || null;
      if (!images.length && showcaseId) {
        const entry = getShowcaseEntry(showcaseId);
        if (entry && entry.userId === me.id && entry.projectId && entry.artifactRel && getProject(entry.projectId)) {
          try {
            const shot = await getArtifactCover(entry.projectId, getSharedDir(entry.projectId), entry.artifactRel);
            if (shot?.buffer) images.push({ buf: shot.buffer, type: 'image/webp', name: 'cover.webp' });
          } catch (err) { console.warn('[market] 截封面失败:', err.message); }
        }
      }
      const r = await publishForUser({
        me, skillBuffer: req.files?.skill?.[0]?.buffer || null, skillName: req.body?.skillName, kind: String(req.body?.kind || '').trim() || null,
        images, title: req.body?.title, note: req.body?.note, source, showcaseId,
      });
      res.status(r.status).json(r.body);
    } catch (err) { next(err); }
  });

  // 照着来一个（v2，09-08 晚）：不复制别人的产物（09-08 早站主定的口径），而是给请求者开一个新项目：
  // 参考图落进 参考图/、有 skill 就装进他的库、回一句预填的开工提示词（先看参考、先对齐，不直接铺量）。
  // 只在网页（source=web）提供：桌面版的项目在用户本机，这里替他建服务器项目是错的；桌面走本地路由（待做）。
  router.post('/:id/fork', async (req, res, next) => {
    try {
      const me = req.marketUser;
      const pub = req.publication;
      if (source !== 'web') return fail(res, 409, 'WEB_ONLY', '桌面版暂不支持照着来一个，请在网页端操作');
      if (pub.state !== 'approved') return fail(res, 409, 'NOT_APPROVED', '这条发布还没通过审核');
      const project = createProject({ name: String(pub.title).slice(0, 40), mode: 'design', ownerId: me.id, skillId: 'site-craft' });
      await ensureProjectWorkspace(project.id);
      const refDir = path.join(getSharedDir(project.id), '参考图');
      await fsp.mkdir(refDir, { recursive: true });
      const copied = [];
      for (let i = 0; i < pub.imageCount; i++) {
        const buf = await readImage(pub.id, i);
        if (!buf) continue;
        const name = `ref-${pub.id.replace(/^pub_/, '')}-${i + 1}.webp`;
        await fsp.writeFile(path.join(refDir, name), buf);
        copied.push(`参考图/${name}`);
      }
      let skillInstalled = false;
      if (pub.hasSkill && can(me, 'installMarketSkill')) {
        const root = getUserPluginsRoot(me.id);
        if (root) {
          const r = await installPluginToRoot(await readSkillBuffer(pub.id), root, { force: false });
          if (r.status === 200 || r.status === 201) {
            await writePluginOrigin(r.body.installed.path, { publicationId: pub.id, skillSha256: pub.skillSha256 });
            recordInstall({ publicationId: pub.id, userId: me.id, skillSha256: pub.skillSha256, source });
            skillInstalled = true;
          } else if (r.status === 409) skillInstalled = true;   // 同名已装，照用
        }
      }
      const prompt = [
        `照着「${pub.title}」做一个我自己的版本。`,
        copied.length ? `参考图在 ${copied[0].replace(/\/[^/]+$/, '/')} 里（${copied.length} 张），先看过。` : '',
        pub.hasSkill ? `它的做法已经装成 skill「${pub.skillName}」，按那套方法来。` : '',
        pub.note ? `作者的说明：${String(pub.note).slice(0, 300)}` : '',
        '动手之前先跟我对齐：这次的内容和场合是什么、风格往哪个方向。',
      ].filter(Boolean).join('\n');
      res.status(201).json({ projectId: project.id, prompt, images: copied, skillInstalled });
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
      if (!pub.hasSkill) return fail(res, 409, 'NO_SKILL', '这是一件作品，没有可安装的 skill；用「照着来一个」');
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
      if (!pub.hasSkill) return fail(res, 409, 'NO_SKILL', '这是一件作品，没有 skill 可下载');
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
