/**
 * server/api/local-market.js — 桌面版 / npx 版的 skill 市场入口（2026-09-08）
 *
 * 货架、审核、发布记录都在站点上（server/hosted/market-*），本机不存市场数据。这里只做三件本机的事：
 *   - 发布前把本机装着的 skill 打成 zip、（有 chromium 时）截那件作品的封面，再整包转给站点
 *   - 安装时从站点拿字节，落进本机的 plugin 根（跟网页版装进用户根是同一个 installPluginToRoot）
 *   - 图片和列表原样转（浏览器没法带设备令牌直连站点，所以经本机一跳）
 *
 * 挂在 /api/local/market（见 local.js），只在 local profile 存在。请求者恒为 LOCAL_OWNER。
 * relay 没配（没登录站点）→ 409 RELAY_NOT_CONFIGURED，前端据此显示「先登录」。
 */

import express from 'express';
import multer from 'multer';

import { getProject } from '../projects/store.js';
import { getSharedDir } from '../projects/workspace.js';
import { getEntry as getShowcaseEntry } from '../lib/showcase-store.js';
import { getArtifactCover } from '../lib/cover.js';
import { installPluginToRoot } from '../lib/plugin-install.js';
import { writePluginOrigin } from '../lib/plugin-origin.js';
import { packPluginDir, findUserPluginDir } from '../lib/plugin-pack.js';
import { getUserPluginsRoot } from '../engine/agent/plugin-loader.js';
import {
  relayConfig, relayMarketList, relayMarketMine, relayMarketFeatured, relayMarketGet, relayMarketImage,
  relayMarketPublish, relayMarketWithdraw, relayMarketDownload, relayMarketInstalled,
} from '../runtime/relay-client.js';

const IMAGE_MAX_COUNT = 6;
const IMAGE_MAX_UPLOAD = 8 * 1024 * 1024;

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGE_MAX_UPLOAD, files: IMAGE_MAX_COUNT } });

/** relay 抛的错原样翻成 HTTP：状态、code、message，校验的 errors[] 也带回去 */
function relayFail(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : err?.code === 'RELAY_TIMEOUT' ? 504 : 502;
  res.status(status).json({ error: err?.message || 'relay 出错', code: err?.code || 'RELAY_ERROR', ...(err?.body?.errors ? { errors: err.body.errors } : {}) });
}

router.use((req, res, next) => {
  if (!relayConfig()) return res.status(409).json({ error: '还没登录站点账号：设置里先登录，市场才能用', code: 'RELAY_NOT_CONFIGURED' });
  next();
});

const passthrough = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) { relayFail(res, err); }
};

router.get('/', passthrough(() => relayMarketList()));
router.get('/mine', passthrough(() => relayMarketMine()));
router.get('/featured', passthrough(() => relayMarketFeatured()));

router.get('/:id', async (req, res) => {
  try {
    const data = await relayMarketGet(req.params.id);
    // 站点记的 installed 是「这个账号在哪台机器装过」；本机有没有装着才是这台机器上该显示的
    const local = data?.publication?.skillName ? await findUserPluginDir(req.user?.id, data.publication.skillName) : null;
    res.json({ ...data, installedLocally: !!local });
  } catch (err) { relayFail(res, err); }
});

router.get('/:id/images/:n', async (req, res) => {
  try {
    const { buffer, contentType } = await relayMarketImage(req.params.id, req.params.n);
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(contentType).send(buffer);
  } catch (err) { relayFail(res, err); }
});

// 发布：本机 skill → zip；图 = 上传的 / 没上传就截 showcaseId 那件作品（要装了 chromium 部件）
router.post('/', upload.array('images', IMAGE_MAX_COUNT), async (req, res) => {
  try {
    const skillName = String(req.body?.skillName || '').trim();
    if (!skillName) return res.status(400).json({ error: '要发布哪个 skill？', code: 'BAD_INPUT' });
    const hit = await findUserPluginDir(req.user?.id, skillName);
    if (!hit) return res.status(404).json({ error: `本机 skill 库里没有「${skillName}」`, code: 'SKILL_NOT_FOUND' });
    const { buffer: skillZip } = await packPluginDir(hit.dir);

    const images = (req.files || []).map((f) => ({ buf: f.buffer, type: f.mimetype || 'image/png', name: f.originalname || 'shot.png' }));
    const showcaseId = String(req.body?.showcaseId || '').trim();
    if (!images.length && showcaseId) {
      const entry = getShowcaseEntry(showcaseId);
      if (entry?.projectId && entry.artifactRel && getProject(entry.projectId)) {
        try {
          const shot = await getArtifactCover(entry.projectId, getSharedDir(entry.projectId), entry.artifactRel);
          if (shot?.buffer) images.push({ buf: shot.buffer, type: 'image/webp', name: 'cover.webp' });
        } catch (err) { console.warn('[local-market] 截封面失败:', err.message); }
      }
    }
    if (!images.length) return res.status(400).json({ error: '至少要一张参考图：截图没截到（这台机器可能没装 chromium 部件），请手动传一张', code: 'NO_IMAGE' });

    const form = new FormData();
    form.set('title', String(req.body?.title || ''));
    form.set('note', String(req.body?.note || ''));
    form.set('skill', new Blob([skillZip], { type: 'application/zip' }), `${skillName}.zip`);
    for (const img of images) form.append('images', new Blob([img.buf], { type: img.type }), img.name);
    res.status(201).json(await relayMarketPublish(form));
  } catch (err) { relayFail(res, err); }
});

router.delete('/:id', async (req, res) => {
  try { await relayMarketWithdraw(req.params.id); res.status(204).end(); } catch (err) { relayFail(res, err); }
});

// 安装：站点拿字节 → 本机 validator + staging 原子落盘 → 回报站点记一笔（回报失败不影响本机已装成）
router.post('/:id/install', async (req, res) => {
  try {
    const root = getUserPluginsRoot(req.user?.id);
    if (!root) return res.status(401).json({ error: 'unauthorized' });
    const { buffer, headers } = await relayMarketDownload(req.params.id);
    const force = req.query.force === '1' || req.query.force === 'true';
    const r = await installPluginToRoot(buffer, root, { force });
    if (r.status === 200 || r.status === 201) {
      await writePluginOrigin(r.body.installed.path, { publicationId: req.params.id, skillSha256: headers?.get?.('x-nd-skill-sha256') || null, site: relayConfig()?.url || null });
      relayMarketInstalled(req.params.id).catch((err) => console.warn('[local-market] 回报安装失败:', err.message));
    }
    res.status(r.status).json(r.body);
  } catch (err) { relayFail(res, err); }
});

router.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '图片超过 8MB', code: 'BODY_TOO_LARGE' });
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `最多 ${IMAGE_MAX_COUNT} 张图`, code: 'BAD_INPUT' });
  next(err);
});

export default router;
