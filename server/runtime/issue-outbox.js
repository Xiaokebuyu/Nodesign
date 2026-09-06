/**
 * server/runtime/issue-outbox.js — 客户端上报的发件箱（本地版专用，2026-09-07）
 *
 * report_issue 在桌面版原来只落本机 issues 表，站主永远看不到。现在每条上报先照旧落本机
 * （本机审计不变），再排进 <dataRoot>/issue-outbox.jsonl，尽快经设备令牌 POST 到站点的
 * /api/relay/issues（hosted/relay/issues.js）。网络不通就留在文件里，启动时和每 10 分钟补发。
 *
 * 桌面壳（desktop/main.js）也往同一个文件追加行：它在服务端起不来 / 更新失败时最有话说，
 * 而那时候本地 HTTP 未必在。文件就是两边共用的队列 —— 服务端下次起来顺手发掉。
 *
 * 只发 agent 写的正文 + 版本 / 平台 / 模型，不带工作区内容和对话原文（站主三条纪律之一）。
 * 发失败绝不影响 agent 回合：所有出错都吞成日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { profile } from './profile.js';
import { relayConfig, relayReportIssue } from './relay-client.js';

export const OUTBOX_FILE = 'issue-outbox.jsonl';
const FLUSH_EVERY_MS = 10 * 60 * 1000;
const MAX_LINES = 200;   // 发件箱封顶：离线一个月也别把盘写满；老的丢

let flushing = false;
let timer = null;

export function outboxPath() {
  return path.join(profile.dataRoot, OUTBOX_FILE);
}

/** 追加一条到发件箱并尽快发。任何失败只记日志。 */
export function enqueueIssueUpload(item) {
  if (!profile.isLocal) return;
  try {
    const line = JSON.stringify({ ...item, at: new Date().toISOString() });
    fs.appendFileSync(outboxPath(), line + '\n');
  } catch (err) {
    console.warn('[issue-outbox] 写发件箱失败:', err.message);
    return;
  }
  setTimeout(() => { flushIssueOutbox().catch(() => {}); }, 50).unref?.();
}

function readOutbox() {
  let text = '';
  try { text = fs.readFileSync(outboxPath(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 坏行丢掉 */ }
  }
  return out.slice(-MAX_LINES);
}

function writeOutbox(items) {
  const p = outboxPath();
  try {
    if (!items.length) { fs.rmSync(p, { force: true }); return; }
    fs.writeFileSync(p, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch (err) { console.warn('[issue-outbox] 回写发件箱失败:', err.message); }
}

/**
 * 把发件箱里的东西发出去。返回 { sent, left }。
 * - 没令牌：什么都不做（东西留着，登录后再发）
 * - 4xx（正文被拒 / 令牌失效以外）：这条丢掉，别永远重试一条坏货
 * - 429 / 网络错 / 5xx：停下，剩下的留到下次
 */
export async function flushIssueOutbox({ send = relayReportIssue } = {}) {
  if (!profile.isLocal || flushing) return { sent: 0, left: 0 };
  if (!relayConfig()) return { sent: 0, left: readOutbox().length };
  flushing = true;
  const items = readOutbox();
  let sent = 0;
  const left = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        await send(it);
        sent++;
      } catch (err) {
        const st = Number(err?.status) || 0;
        if (st >= 400 && st < 500 && st !== 429 && st !== 401) { console.warn('[issue-outbox] 站点拒收一条，丢弃:', err.message); continue; }
        // 其余：这条和后面的都留着
        left.push(...items.slice(i));
        console.warn('[issue-outbox] 暂时发不出去，留到下次:', err.message);
        break;
      }
    }
  } finally {
    writeOutbox(left);
    flushing = false;
  }
  return { sent, left: left.length };
}

/** 启动时叫一次：发一遍积压，之后定时补发 */
export function startIssueOutbox() {
  if (!profile.isLocal || timer) return;
  setTimeout(() => { flushIssueOutbox().catch(() => {}); }, 5000).unref?.();
  timer = setInterval(() => { flushIssueOutbox().catch(() => {}); }, FLUSH_EVERY_MS);
  timer.unref?.();
}
