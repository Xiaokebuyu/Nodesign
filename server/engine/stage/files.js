/**
 * engine/stage/files.js —— 显示器对戏的文件夹的读改（2026-09-05 晚，从 manager.js 拆出）
 *
 * 用户在显示器里能改的只有白名单里的文件（台面 / 规则 / 角色卡 / 世界书 / 预设 / 记忆正文）。
 * 角色卡的机器块（记忆索引）以磁盘为准接回去；规则先过条件校验；改了进程正在用的来源文件，
 * 下一句话到时 manager 自己重开（这里只报 reopenOnNextLine）。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { runtimeOf, statRel } from './manager.js';
import { rewriteIndex } from './tools.js';
import { resolveCardPath, saveCardKeepingMachineBlock, cardHome, rewriteCardMemoryIndex, CARD_FILE, CARD_MEMORY_DIR } from './card.js';
import { RULES_FILE, SCENES_DIR, BACKDROPS_DIR, MEMORY_DIR, ASSETS_DIR, writeRules } from './play.js';
import { validateCondition } from './rules.js';
import { getProjectBus } from '../../ws/broker.js';

function fileUrl(pid, rel) {
  return `/api/projects/${pid}/artifact-file/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

const EDITABLE_RE = /^(台面\.md|规则\.json|角色\/[^/]+\/角色卡\.md|(世界书|预设)\/[^/]+(\/[^/]+)?\.md|记忆\/[a-z0-9-]+\.md|角色\/[^/]+\/记忆\/[a-z0-9-]+\.md)$/;

/** 用户在显示器里改文件（路径相对戏的文件夹）。角色卡的机器块以磁盘为准接回去。 */
export async function saveStageFile(pid, root, rel, text) {
  const rt = runtimeOf(pid, root);
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..') || !EDITABLE_RE.test(clean)) throw Object.assign(new Error('这个文件不能从显示器改'), { status: 400 });
  const abs = path.join(rt.playAbs, clean);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (clean === RULES_FILE) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (err) { throw Object.assign(new Error(`规则不是合法 JSON：${err.message}`), { status: 400 }); }
    for (const r of [...(parsed.achievements || []), ...(parsed.triggers || [])]) {
      const bad = validateCondition(r.when);
      if (bad) throw Object.assign(new Error(`规则「${r.id || '?'}」：${bad}`), { status: 400 });
    }
    await writeRules(rt.playAbs, parsed);
  } else if (/角色卡\.md$/.test(clean)) {
    await saveCardKeepingMachineBlock(rt.wsRoot, `${root}/${clean}`, text);
  } else {
    await fs.writeFile(abs, String(text).replace(/\s*$/, '') + '\n', 'utf8');
    if (clean.startsWith(`${MEMORY_DIR}/`)) await rewriteIndex(path.join(rt.playAbs, MEMORY_DIR));
    const cardMem = /^(角色\/[^/]+)\/记忆\//.exec(clean);
    if (cardMem) await rewriteCardMemoryIndex(rt.wsRoot, `${root}/${cardMem[1]}/${CARD_FILE}`);
  }
  getProjectBus(pid).publish({ type: 'run.file_changed', filePath: `${root}/${clean}`, event: 'change' });
  const full = `${root}/${clean}`;
  return { ok: true, path: full, reopenOnNextLine: !!(rt.running && rt.sources.some(s => s.rel === full)) };
}

/** 删一条记忆（这场戏的，或某个人卡上的） */
export async function deleteMemory(pid, root, { name, who = null }) {
  const rt = runtimeOf(pid, root);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(name || ''))) throw Object.assign(new Error('bad name'), { status: 400 });
  if (who) {
    const cardRel = await resolveCardPath(rt.wsRoot, who, { playRoot: root });
    if (!cardRel) throw Object.assign(new Error('没有这个人的卡'), { status: 404 });
    await fs.rm(path.join(rt.wsRoot, cardHome(cardRel), CARD_MEMORY_DIR, `${name}.md`), { force: true });
    await rewriteCardMemoryIndex(rt.wsRoot, cardRel);
    const src = rt.sources.find(x => x.rel === cardRel);
    if (src) src.mtimeMs = await statRel(rt.wsRoot, cardRel);
  } else {
    await fs.rm(path.join(rt.playAbs, MEMORY_DIR, `${name}.md`), { force: true });
    await rewriteIndex(path.join(rt.playAbs, MEMORY_DIR));
  }
  return { ok: true };
}

/** 显示器的素材清单：素材/ 与 场景/背景/ 里的图 */
export async function listStageImages(pid, root) {
  const rt = runtimeOf(pid, root);
  const out = [];
  for (const d of ['', ASSETS_DIR, `${SCENES_DIR}/${BACKDROPS_DIR}`]) {
    for (const f of await fs.readdir(path.join(rt.playAbs, d)).catch(() => [])) {
      if (/\.(png|jpe?g|webp|gif)$/i.test(f)) { const rel = d ? `${d}/${f}` : f; out.push({ rel, url: fileUrl(pid, `${root}/${rel}`) }); }
    }
  }
  return out;
}

/** 读一份戏里的文本文件给显示器编辑（路径相对戏的文件夹，白名单同 saveStageFile） */
export async function readStageFile(pid, root, rel) {
  const rt = runtimeOf(pid, root);
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..') || !EDITABLE_RE.test(clean)) throw Object.assign(new Error('这个文件不能从显示器读'), { status: 400 });
  try { return { path: `${root}/${clean}`, text: await fs.readFile(path.join(rt.playAbs, clean), 'utf8') }; } catch { return { path: `${root}/${clean}`, text: '' }; }
}

/** 列戏里能编辑的文件（世界书 / 预设 / 记忆 / 卡），显示器"上下文"页用 */
export async function listStageFiles(pid, root) {
  const rt = runtimeOf(pid, root);
  const out = [];
  const walk = async (rel, depth) => {
    for (const e of await fs.readdir(path.join(rt.playAbs, rel), { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 3 && !e.name.startsWith('.')) await walk(r, depth + 1);
      else if (e.isFile() && EDITABLE_RE.test(r)) out.push({ rel: r, size: (await fs.stat(path.join(rt.playAbs, r))).size });
    }
  };
  await walk('', 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

