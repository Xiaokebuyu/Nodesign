/**
 * server/lib/auto-relations.js — 自动落线层（2026-08-14，北极星路线 4）
 *
 * 有一类关系**不需要人或 agent 判断，机器可证**：html 里 `<img src>` 真实
 * 指向工作区里的一张图，就是铁打的「取材」。这层把它们落成 `by:'auto'` 的
 * ref 边 —— 关系密度从「靠自觉」变成「有底仓」，用户和 agent 的手画线在
 * 底仓之上做增量。
 *
 * 三条纪律：
 *   1. **只动自家的边**。自动边 id 恒为 `b:auto:ref:<hash>`（确定性 → 幂等），
 *      对账时新增缺的、删掉失效的，**其余 id 一根手指都不碰** —— 用户/agent
 *      画的线不归这层管。
 *   2. **引用得真实存在**才落线。悬空 src 是裂图体检的事，不是关系。
 *   3. **不画**。BindingLayer 对 auto+ref 不渲染 —— 一个站引三十张图，画出来
 *      是蜘蛛网不是版面。它们的消费方是 agent 上下文（digest 收拢成一行）和
 *      将来的主角判断（被 ref 指着的 = 素材，不该当 hero）。
 *
 * 触发：挂在 GET /artifacts 尾巴上 fire-and-forget（那里 manifests 现成），
 * 每项目 30s 节流。产物身份的拼法与 BoardCanvas 的物件 id 同构 ——
 * `deck:<file>` / `site:<root||''>` / 单页 `site:<entryRel>`。
 */

import fs from 'node:fs/promises';
import { cardIdOf } from './kinds/index.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBoard, patchBoard } from '../projects/board-store.js';

const MAX_HTML_BYTES = 512 * 1024;
const AUTO_REF_PREFIX = 'b:auto:ref:';
/** 每个项目对账节流（ms）—— /artifacts 是热接口，别把它变成扫盘器 */
const THROTTLE_MS = 30_000;
const lastRun = new Map();

const hashId = (from, to) =>
  AUTO_REF_PREFIX + crypto.createHash('sha1').update(`${from}|${to}`).digest('hex').slice(0, 12);

/**
 * 从一段 html 里抠出本地资源引用（src/href/poster + 内联 url()）。
 * 返回**相对 html 所在目录**的原始引用串（未归一）。
 */
export function extractRefs(html) {
  const out = new Set();
  const push = (raw) => {
    if (!raw) return;
    const v = raw.trim().replace(/^['"]|['"]$/g, '').split(/[?#]/)[0];
    if (!v || /^(https?:|data:|blob:|mailto:|javascript:|\/\/)/i.test(v)) return;
    out.add(v);
  };
  for (const m of html.matchAll(/<(?:img|video|audio|source|embed)\b[^>]*?\s(?:src|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) push(m[1]);
  for (const m of html.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) push(m[1]);
  return [...out];
}

/** 引用串 → 工作区相对路径（越界/绝对路径丢弃）。baseDir 是 html 所在目录（工作区相对）。 */
export function resolveRef(raw, baseDir) {
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('/')) return null;               // 站内绝对路径按约定不出现，出现也不猜
    const joined = path.posix.normalize(path.posix.join(baseDir || '.', decoded));
    if (joined.startsWith('..') || path.posix.isAbsolute(joined)) return null;
    return joined === '.' ? null : joined;
  } catch { return null; }
}

/**
 * 对账一个项目的自动 ref 边。
 *
 * @param {string} pid
 * @param {string} workspaceRoot  绝对路径
 * @param {Array} tasks           /artifacts 已算好的 tasks（id/artifacts 同构前端）
 */
export async function reconcileAutoRefs(pid, workspaceRoot, tasks) {
  // 期望集：{ bid: { from, to } }
  const desired = new Map();
  for (const t of tasks || []) {
    for (const a of t.artifacts || []) {
      // 产物身份（与 BoardCanvas 的物件 id 同一拼法）。
      // 2026-08-31 收编：这里原来是那条规则的第二份手抄（08-18 修过一次 docx 前缀），
      // 现在跟 pin_to_board 一起走 kinds/index.js 的 cardIdOf —— 一份表 N 个读者。
      const fromId = cardIdOf(t.id, a);
      // 这件产物的 html 们（deck 一份；站点 = 各页，路径相对站根）
      const pages = a.kind === 'deck'
        ? [a.file]
        : (a.single ? [a.entryRel] : (a.pages || []).map(p => (a.root ? `${a.root}/${p}` : p)));
      for (const rel of pages) {
        if (!rel || !/\.html?$/i.test(rel)) continue;
        let html;
        try {
          const abs = path.join(workspaceRoot, rel);
          const st = await fs.stat(abs);
          if (st.size > MAX_HTML_BYTES) continue;
          html = await fs.readFile(abs, 'utf8');
        } catch { continue; }
        const baseDir = path.posix.dirname(rel.replace(/\\/g, '/'));
        for (const raw of extractRefs(html)) {
          const to = resolveRef(raw, baseDir === '.' ? '' : baseDir);
          if (!to || to === rel) continue;
          try { await fs.access(path.join(workspaceRoot, to)); } catch { continue; }   // 悬空不落线
          desired.set(hashId(fromId, to), { from: fromId, to });
        }
      }
    }
  }

  // 现状 → diff。只碰 b:auto:ref:* 的条目。
  const board = await readBoard(pid);
  const patch = {};
  for (const [bid, b] of Object.entries(board.bindings || {})) {
    if (bid.startsWith(AUTO_REF_PREFIX) && !desired.has(bid)) patch[bid] = null;
  }
  for (const [bid, { from, to }] of desired) {
    const cur = board.bindings?.[bid];
    if (cur && cur.from === from && cur.to === to) continue;
    patch[bid] = { type: 'ref', from, to, by: 'auto' };
  }
  if (Object.keys(patch).length) await patchBoard(pid, { bindings: patch });
  return { desired: desired.size, changed: Object.keys(patch).length };
}

/** 节流版：/artifacts 尾巴上 fire-and-forget 用 */
export function reconcileAutoRefsThrottled(pid, workspaceRoot, tasks) {
  const now = Date.now();
  if (now - (lastRun.get(pid) || 0) < THROTTLE_MS) return;
  lastRun.set(pid, now);
  reconcileAutoRefs(pid, workspaceRoot, tasks).catch(() => { /* fail-soft：对账绝不拖累清单接口 */ });
}
