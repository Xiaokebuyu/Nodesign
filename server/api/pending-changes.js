/**
 * server/api/pending-changes.js — 用户直接编辑 + 评论 buffer（C4）
 *
 * 用户在 canvas 上做的"直接改文本"和"写评论"在前端 push 到这里。下次发 chat
 * 消息时，turn.js 在 composeUserMessage 里 prepend 一个 system 提示告诉 agent
 * "有 N 处变更"，agent 主动调 mcp__nodesign__get_pending_changes 拉详情。
 *
 * 路径（2026-08-13 起**项目级**，会话级留作 alias）：
 *   POST   /api/projects/:pid/pending-changes  append item
 *   GET    /api/projects/:pid/pending-changes  返 { items, count }
 *   DELETE /api/projects/:pid/pending-changes  全清（也接 ?ids=）
 *   （/:pid/sessions/:sid/... 同 handler 双挂载 —— 老前端和 jsonl 里的
 *     历史引用还打得通；sid 在扁平化后本来就只是路由上的仪式，
 *     sessionRoot === 工作区根，这份 buffer 从来就是每项目一份）
 *
 * 文件：<工作区根>/pending-changes.json
 *   { items: [{ id, kind, anchor, aiContext?, diff?, text?, linkedToEditId?, move?, styleDelta?, reactMount?, ts }] }
 *
 * 2026-05-12 起新增 kind:
 *   - 'pending-move'      用户在 canvas 上拖动元素（前端虚拟改 DOM，agent run 时落源码）
 *                          带 move: { container: anchor, before: anchor|null }
 *   - 'pending-style'     用户拖动 / nudge 改样式（位移、对齐等）
 *                          带 styleDelta: { left?, top?, marginLeft?, ... }
 *                          可选 constraint: { x, y } (Figma 风格 anchor — 决定父 resize 时跟哪边)
 *   - 'pending-duplicate' 用户 alt-drag 复制元素
 *                          带 move: { container, before }
 *   - 'pending-delete'    用户按 Del 删除元素
 *   全部可选带 reactMount: true 表示要改 JSX 源码不是 HTML。
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { mutex } from 'async-mutex-lite';
import { validateProjectId, getProject } from '../projects/store.js';
import { guardProject } from './_guard.js';
import {
  ensureSessionWorkspace, getWorkspaceRoot, ensureProjectWorkspace, validateSessionId, getSharedDir,
} from '../projects/workspace.js';
import { renderRegionShot, saveRegionShot, PADDING, OUT_LONG_EDGE } from '../lib/region-shot.js';
import { regionShotFromPage } from '../lib/docx-pages.js';

const router = express.Router();

const FILE_NAME = 'pending-changes.json';
const MAX_ITEMS = 200;

function guard(req, res) {
  // sid 只在走老 alias 时存在 —— 有就校验形状，没有就是项目级路由
  if (req.params.sid !== undefined) {
    try {
      validateSessionId(req.params.sid);
    } catch (err) {
      res.status(400).json({ error: err.message || 'invalid pid/sid' });
      return null;
    }
  }
  // pid 校验 + 存在性 + 归属（2026-07-30 多用户）统一走 guardProject
  return guardProject(req, res);
}

/** 两条挂载共用：alias 带 sid 走原路，项目级直接 ensure 工作区 */
async function rootOf(req) {
  // pending-changes.json 住画布根（agent 读工作区根才看得见）。ensureSessionWorkspace 自
  // 2026-09-07 起返回 cwd，文件夹项目里那是用户仓库，所以只借它的副作用、根另问。
  if (req.params.sid !== undefined) await ensureSessionWorkspace(req.params.pid, req.params.sid);
  else await ensureProjectWorkspace(req.params.pid);
  return getWorkspaceRoot(req.params.pid);
}

async function readBuf(sessionRoot) {
  const file = path.join(sessionRoot, FILE_NAME);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.items)) return { items: parsed.items, file };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { items: [], file };
}

async function writeBuf(file, items) {
  await fs.writeFile(file, JSON.stringify({ items }, null, 2), 'utf8');
}

router.get(['/:pid/pending-changes', '/:pid/sessions/:sid/pending-changes'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await rootOf(req);
    const { items } = await readBuf(sessionRoot);
    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

/**
 * 这次编辑是不是"把内容清空了"。`<br>`、`&nbsp;`、空白都算空 ——
 * contenteditable 清空后浏览器常留一个 `<br>` 占位。
 */
function isBecameEmpty(diff) {
  if (!diff || typeof diff.newText !== 'string') return false;
  if (typeof diff.oldText === 'string' && diff.oldText.replace(/<[^>]*>|&nbsp;|\s+/g, '') === '') return false;
  return diff.newText.replace(/<br\s*\/?>|&nbsp;|<[^>]*>|\s+/gi, '') === '';
}

router.post(['/:pid/pending-changes', '/:pid/sessions/:sid/pending-changes'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const { kind, anchor } = body;
    // applied-*（2026-07-29）：站点窗拖拽已直接落盘的 FYI 记录，agent 不再应用
    const VALID_KINDS = ['edit', 'comment', 'pending-move', 'pending-style', 'pending-duplicate', 'pending-delete',
      'applied-move', 'applied-style', 'applied-duplicate'];
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${VALID_KINDS.join(' / ')}` });
    }
    if (!anchor || typeof anchor !== 'object') {
      return res.status(400).json({ error: 'anchor object required' });
    }
    if (kind === 'edit') {
      const { diff } = body;
      if (!diff || typeof diff !== 'object'
          || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') {
        return res.status(400).json({ error: 'edit kind requires diff: { oldText, newText }' });
      }
    } else if (kind === 'comment') {
      const { text } = body;
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'comment kind requires non-empty text' });
      }
      // linkedToEditId (optional) —— 把评论挂到某条 pending edit 上，作为该次操作的补充指令
      if (body.linkedToEditId !== undefined && typeof body.linkedToEditId !== 'string') {
        return res.status(400).json({ error: 'linkedToEditId must be string if present' });
      }
    } else if (kind === 'pending-move' || kind === 'pending-duplicate') {
      const { move } = body;
      if (!move || typeof move !== 'object' || !move.container || typeof move.container !== 'object') {
        return res.status(400).json({
          error: `${kind} requires move: { container: anchor, before: anchor|null }`,
        });
      }
    } else if (kind === 'pending-style') {
      const { styleDelta } = body;
      if (!styleDelta || typeof styleDelta !== 'object') {
        return res.status(400).json({ error: 'pending-style requires styleDelta object' });
      }
    }
    // pending-delete 只需 anchor

    const sessionRoot = await rootOf(req);

    // 接受 body.id（前端 newId('cmt') 等）以让前后端 id 统一——agent 调
    // clear_pending_changes 时 event 带 clearedIds，前端 comments state 用同一
    // id filter 出橙色 overlay。无传入则后端 randomUUID 兜底。
    const itemId = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : randomUUID();
    const item = {
      id: itemId,
      kind,
      anchor,
      // 这条改动是对**哪个文件**做的（2026-07-28）。一个任务可以有多份 deck，
      // 站点更是天然多页 —— 不记路径的话 agent 只能把所有改动都套到它当前打开的
      // 那一份上，改错了还看不出来（anchor 在别的文件里根本找不到，静默 no-op）。
      ...(typeof body.path === 'string' && body.path ? { path: body.path } : {}),
      ...(body.aiContext ? { aiContext: body.aiContext } : {}),
      ...(body.reactMount === true ? { reactMount: true } : {}),
      ...(kind === 'edit' ? {
        diff: body.diff,
        // 用户把一段文字**清空**了（2026-08-18）。源码里留下的是个空壳
        // `<p class="foot-line"></p>` —— 它仍然有 margin/line-height，在页面上
        // 撑出一道空隙，用户看到的是"字没了但地方还空着"。以前 agent 只能从
        // `diff.newText === ''` 自己推断，而且第一次基本都漏，等用户下次截图
        // 才发现（问题库 iss_msc46ion_ydr8：同一个坑一个会话踩两次）。
        // 只打标记不自动删元素：用户也可能是清空重打，误删不可逆。
        ...(isBecameEmpty(body.diff) ? { becameEmpty: true } : {}),
      } : {}),
      ...(kind === 'comment' ? {
        text: body.text,
        ...(body.linkedToEditId ? { linkedToEditId: body.linkedToEditId } : {}),
      } : {}),
      ...((kind === 'pending-move' || kind === 'pending-duplicate'
           || kind === 'applied-move' || kind === 'applied-duplicate') ? { move: body.move } : {}),
      ...((kind === 'pending-style' || kind === 'applied-style') ? {
        styleDelta: body.styleDelta,
        ...(body.constraint && typeof body.constraint === 'object'
          ? { constraint: body.constraint }  // { x: 'left'|'right'|'center'|'stretch', y: 'top'|'bottom'|'center'|'stretch' }
          : {}),
      } : {}),
      // applied-*：站点窗已落盘的 FYI 记录特有标记（applied=事实已写盘；
      // serializedFrom=落盘走了运行时序列化兜底，文件可能带脚本运行时产物）
      ...(body.applied === true ? { applied: true } : {}),
      ...(typeof body.serializedFrom === 'string' && body.serializedFrom
        ? { serializedFrom: body.serializedFrom } : {}),
      ts: new Date().toISOString(),
    };

    // 串行 read-modify-write 防多点击 race（用户连点 5 次评论 → 5 个 POST 几乎同时
    // 到达，原版 readBuf→push→writeBuf 无锁，后写者覆盖前写者 → 用户感"评论凭空消失"。
    // per-sessionRoot mutex 串行所有 pending-changes 写。
    const trimmedCount = await mutex(`pending:${sessionRoot}`, async () => {
      const { items, file } = await readBuf(sessionRoot);
      items.push(item);
      const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
      await writeBuf(file, trimmed);
      return trimmed.length;
    });

    res.json({ ok: true, item, count: trimmedCount });
  } catch (err) { next(err); }
});

/**
 * 圈选评论（2026-08-07）—— 用户在预览上框一块，连同框里涉及的元素、一张
 * 该区域的截图、以及一句话交给 agent。
 *
 * 单独一条路由而不是复用上面那个 POST，因为它要做两件那边不做的事：
 * 跑一次 chromium 把区域截下来落盘，以及**不带 anchor**（圈的是一块地方
 * 不是一个元素，硬塞一个 anchor 只会让 agent 以为用户点的是某一个）。
 *
 * 截图失败不挡下单：元素清单和那句话本身就够 agent 干活了，为了一张图把
 * 用户刚圈完的东西整个丢掉是最差的选择。
 */
router.post(['/:pid/region-comment', '/:pid/sessions/:sid/region-comment'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const body = req.body || {};
    const { region, viewport } = body;
    const relPath = typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';

    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!region || !num(region.x) || !num(region.y) || !(region.w > 0) || !(region.h > 0)) {
      return res.status(400).json({ error: 'region: { x, y, w, h } required' });
    }
    if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)) {
      return res.status(400).json({ error: 'viewport: { width, height } required' });
    }
    // 页面路径相对项目工作区根。扁平化之前这里硬要求 `tasks/<任务>/<文件>`
    // 三段起步，现在根上的 `index.html` 只有一段，那条判据会把它全拒掉。
    const parts = relPath.split('/');
    if (!parts.length || parts.includes('..') || parts.some(p => !p || p.startsWith('.'))) {
      return res.status(400).json({ error: 'invalid page path' });
    }
    const sharedDir = path.resolve(getSharedDir(req.params.pid));
    const absPath = path.resolve(sharedDir, ...parts);
    if (!absPath.startsWith(sharedDir + path.sep)) {
      return res.status(400).json({ error: 'path escapes the workspace' });
    }
    try { await fs.access(absPath); } catch {
      return res.status(404).json({ error: `page not found: ${relPath}` });
    }

    const elements = Array.isArray(body.elements) ? body.elements.slice(0, 12) : [];
    const itemId = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim() : randomUUID();
    const sessionRoot = await rootOf(req);

    let shot = null;
    let shotError = null;
    let shotNote = null;   // 截图成功但通道退化（file:// 回退）时的提醒
    let docxPage = null;   // docx 圈选：圈的是第几页（页图坐标系没有"整页文档"这回事）
    try {
      if (/\.docx$/i.test(relPath)) {
        // docx 没有 DOM 也进不了 chromium —— "用户所见"就是 LO 渲的页图，
        // 直接从页图缓存裁（region 坐标基准 = 页图原始像素，前端换算好再送）
        const r = await regionShotFromPage(absPath, body.docxPage, region,
          { pad: PADDING, longEdge: OUT_LONG_EDGE });
        shot = await saveRegionShot(sessionRoot, itemId, r.buf);
        docxPage = r.page;
      } else {
        const { buffer, degraded } = await renderRegionShot({
          absPath,
          projectId: req.params.pid,
          workspaceRoot: sharedDir,
          region: { x: region.x, y: region.y, w: region.w, h: region.h },
          viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
        });
        shot = await saveRegionShot(sessionRoot, itemId, buffer);
        // 没走成 http 的话这张图不能当"用户所见"用，得让 agent 知道
        if (degraded) shotNote = degraded;
      }
    } catch (err) {
      shotError = err?.message || String(err);
      console.warn('[region-comment] 截图失败，只带元素清单下单:', shotError);
    }

    const item = {
      id: itemId,
      kind: 'region-comment',
      path: relPath,
      text,
      region: { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w), h: Math.round(region.h) },
      ...(docxPage ? { docxPage } : {}),
      ...(body.container && typeof body.container === 'object' ? { container: body.container } : {}),
      viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
      elements,
      ...(shot ? { shot } : {}),
      ...(shotError ? { shotError } : {}),
      ...(shotNote ? { shotNote } : {}),
      ts: new Date().toISOString(),
    };

    const count = await mutex(`pending:${sessionRoot}`, async () => {
      const { items, file } = await readBuf(sessionRoot);
      items.push(item);
      const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
      await writeBuf(file, trimmed);
      return trimmed.length;
    });

    res.json({ ok: true, item, count });
  } catch (err) { next(err); }
});

router.delete(['/:pid/pending-changes', '/:pid/sessions/:sid/pending-changes'], async (req, res, next) => {
  try {
    if (!guard(req, res)) return;
    const sessionRoot = await rootOf(req);

    // 同 POST：mutex 串行避免 DELETE / POST 并发互踩
    const idsParam = req.query?.ids;
    const idsSet = idsParam
      ? new Set(String(idsParam).split(',').map(s => s.trim()).filter(Boolean))
      : null;
    const result = await mutex(`pending:${sessionRoot}`, async () => {
      const { items, file } = await readBuf(sessionRoot);
      const filtered = idsSet ? items.filter(it => !idsSet.has(it.id)) : [];
      await writeBuf(file, filtered);
      return { removed: items.length - filtered.length, count: filtered.length };
    });

    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

export default router;

/**
 * Helper for turn.js / agent loop — 同步检查 buffer 是否非空（不加路由）。
 * @returns {Promise<{ count, summary }>}
 *    summary 形如 "用户在过去时段做了 3 处变更（2 编辑 + 1 评论）"
 */
export async function readPendingSummary(sessionRoot) {
  try {
    const { items } = await readBuf(sessionRoot);
    if (items.length === 0) return { count: 0, summary: '' };
    const edits = items.filter(it => it.kind === 'edit').length;
    const comments = items.filter(it => it.kind === 'comment').length;
    const moves = items.filter(it => it.kind === 'pending-move').length;
    const duplicates = items.filter(it => it.kind === 'pending-duplicate').length;
    const styles = items.filter(it => it.kind === 'pending-style').length;
    const deletes = items.filter(it => it.kind === 'pending-delete').length;
    const regions = items.filter(it => it.kind === 'region-comment').length;
    const parts = [];
    if (edits > 0) parts.push(`${edits} 编辑`);
    if (comments > 0) parts.push(`${comments} 评论`);
    if (regions > 0) parts.push(`${regions} 圈选`);
    if (moves > 0) parts.push(`${moves} 拖动`);
    if (duplicates > 0) parts.push(`${duplicates} 复制`);
    if (styles > 0) parts.push(`${styles} 样式`);
    if (deletes > 0) parts.push(`${deletes} 删除`);
    return {
      count: items.length,
      summary: `用户在过去时段做了 ${items.length} 处变更（${parts.join(' + ')}）`,
    };
  } catch {
    return { count: 0, summary: '' };
  }
}
