/**
 * engine/stage/lines.js —— 线路：回退与分叉（2026-09-06，站主要"侧边栏那种完整回退和分支切换"）
 *
 * 跟对话侧边栏同一套机制（api/sessions-rewind.js / sessions.js fork）：
 *
 *   回退到某一句之前   把这条线的 SDK 转录截到那句话的 uuid 之前（truncateJsonlAtMessage），再把记录文件
 *                      截到同一处。下一句话到时进程 resume 截短后的转录 —— 模型的记忆真的回到了那里。
 *   从某一句分叉       SDK forkSession(upToMessageId) 复制一份转录（uuid 全部重映射）并补一刀砍掉那句话本身
 *                      （fork 是含那条的），记录文件的前半段复制成新线路的文件，当前线切过去。原线一字不动。
 *   切线               停掉在跑的进程、改 currentLine；下一句话 resume 那条线自己的转录。
 *
 * 09-05 之前的记录行没有 uuid（那时用户消息没盖 uuid），回退 / 分叉到那种行时转录截不了：
 * 记录照截，但这条线的 sdkSid 清空 → 下次是新会话，模型只剩记忆索引。返回里 memory:'reset' 让显示器说明白。
 *
 * 成就不回退：达成过就是达成过（PS 奖杯也这样），rt.seen 里留着不会二次弹。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { runtimeOf, stopStage, loadConfig } from './manager.js';
import { readScenes } from './tools.js';
import { readPlayConfig, writePlayConfig, linesOf, currentLine, sceneFileOf, newLineId, MAIN_LINE } from './play.js';
import { truncateJsonlAtMessage, truncateJsonlAtLastUserMessage, jsonlExistsForSession } from '../../projects/session-jsonl.js';
import { withConfigDir } from '../../lib/sdk-session.js';
import { platform } from '../../runtime/platform.js';

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function writeRows(playAbs, rel, rows) {
  const abs = path.join(playAbs, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  await fs.rename(tmp, abs);
}

/** 找切点：rowId 那一行，以及从它起第一条带 uuid 的用户行（转录按它切） */
async function cutPoint(rt, rowId) {
  const rows = await readScenes(rt.playAbs, { limit: 1000000, rel: rt.scenesRel });
  const idx = rows.findIndex(r => r.id === rowId);
  if (idx < 0) throw fail('没有这一句', 404);
  const anchor = rows.slice(idx).find(r => (r.by === 'user' || r.by === 'system') && r.uuid);
  return { rows, idx, uuid: anchor?.uuid || null };
}

/** 每条线的清单：段数、是不是当前、有没有模型记忆 */
export async function listLines(pid, root) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  const out = [];
  for (const l of linesOf(cfg)) {
    const rows = await readScenes(rt.playAbs, { limit: 1000000, rel: sceneFileOf(l.id) });
    const { sdkSid, ...pub } = l;
    out.push({ ...pub, beats: rows.filter(r => r.by === 'stage').length, current: l.id === currentLine(cfg).id, hasMemory: !!sdkSid && await jsonlExistsForSession(rt.wsRoot, sdkSid) });
  }
  return out;
}

/** 回到这一句之前（这一句和之后的都不算数了） */
export async function rewindTo(pid, root, rowId) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  const line = currentLine(cfg);
  const { rows, idx, uuid } = await cutPoint(rt, rowId);
  if (rt.running) await stopStage(pid, root, 'rewind');
  let memory = 'kept';
  if (idx === 0) memory = 'fresh';
  else if (uuid && line.sdkSid) {
    const removed = await truncateJsonlAtMessage(rt.wsRoot, line.sdkSid, uuid);
    if (removed == null) memory = 'reset';
  } else memory = 'reset';
  await writeRows(rt.playAbs, rt.scenesRel, rows.slice(0, idx));
  const next = { ...cfg, updatedAt: new Date().toISOString() };
  if (memory !== 'kept') next.lines = linesOf(cfg).map(l => (l.id === line.id ? { ...l, sdkSid: null } : l));
  await writePlayConfig(rt.playAbs, next);
  rt.broadcast({ type: 'reload', reason: 'rewind', memory });
  return { ok: true, removed: rows.length - idx, memory };
}

/** 从这一句之前分出一条新线，并切过去。原线不动。 */
export async function forkAt(pid, root, rowId, { name = null } = {}) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  const line = currentLine(cfg);
  const { rows, idx, uuid } = await cutPoint(rt, rowId);
  if (rt.running) await stopStage(pid, root, 'fork');
  let sdkSid = null; let memory = 'reset';
  if (idx === 0) memory = 'fresh';
  else if (uuid && line.sdkSid && await jsonlExistsForSession(rt.wsRoot, line.sdkSid)) {
    try {
      const r = await withConfigDir(platform.claudeConfigDir, () => forkSession(line.sdkSid, { dir: rt.wsRoot, upToMessageId: uuid }));
      sdkSid = r.sessionId;
      await truncateJsonlAtLastUserMessage(rt.wsRoot, sdkSid);   // fork 是含那句的，补一刀砍掉它
      memory = 'kept';
    } catch (err) { console.warn(`[stage] ${pid}/${root} 转录分叉失败，新线不带记忆: ${err.message}`); }
  }
  const id = newLineId();
  const lines = linesOf(cfg);
  const newLine = { id, name: String(name || `分支 ${lines.length}`).slice(0, 30), sdkSid, createdAt: new Date().toISOString(), forkedFrom: { line: line.id, rowId, beats: rows.slice(0, idx).filter(r => r.by === 'stage').length } };
  await writeRows(rt.playAbs, sceneFileOf(id), rows.slice(0, idx));
  await writePlayConfig(rt.playAbs, { ...cfg, lines: [...lines, newLine], currentLine: id, updatedAt: new Date().toISOString() });
  rt.broadcast({ type: 'reload', reason: 'fork', memory, line: id });
  return { ok: true, line: id, memory };
}

/** 切到另一条线（在跑的进程停掉，下一句话 resume 那条线的转录） */
export async function switchLine(pid, root, lineId) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  if (!linesOf(cfg).some(l => l.id === lineId)) throw fail('没有这条线', 404);
  if (currentLine(cfg).id === lineId) return { ok: true, line: lineId };
  if (rt.running) await stopStage(pid, root, 'switch-line');
  await writePlayConfig(rt.playAbs, { ...cfg, currentLine: lineId, updatedAt: new Date().toISOString() });
  rt.broadcast({ type: 'reload', reason: 'switch', line: lineId });
  return { ok: true, line: lineId };
}

export async function renameLine(pid, root, lineId, name) {
  const rt = runtimeOf(pid, root);
  const cfg = await readPlayConfig(rt.playAbs);
  if (!cfg) throw fail('还没有这个故事', 404);
  const clean = String(name || '').trim().slice(0, 30);
  if (!clean) throw fail('名字不能空');
  await writePlayConfig(rt.playAbs, { ...cfg, lines: linesOf(cfg).map(l => (l.id === lineId ? { ...l, name: clean } : l)) });
  rt.broadcast({ type: 'reload', reason: 'rename' });
  return { ok: true };
}

/** 删一条线（主线不能删；删的是当前线就切回主线）。记录文件删掉，转录留在 SDK 那边不管。 */
export async function deleteLine(pid, root, lineId) {
  const rt = runtimeOf(pid, root);
  const cfg = await loadConfig(rt);
  if (lineId === MAIN_LINE) throw fail('主线不能删');
  if (!linesOf(cfg).some(l => l.id === lineId)) throw fail('没有这条线', 404);
  if (currentLine(cfg).id === lineId && rt.running) await stopStage(pid, root, 'delete-line');
  await fs.rm(path.join(rt.playAbs, sceneFileOf(lineId)), { force: true });
  await writePlayConfig(rt.playAbs, { ...cfg, lines: linesOf(cfg).filter(l => l.id !== lineId), currentLine: currentLine(cfg).id === lineId ? MAIN_LINE : cfg.currentLine, updatedAt: new Date().toISOString() });
  rt.broadcast({ type: 'reload', reason: 'delete-line' });
  return { ok: true };
}
