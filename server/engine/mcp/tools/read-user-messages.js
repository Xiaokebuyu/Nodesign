/**
 * mcp/tools/read-user-messages.js —— read_user_messages：读用户在本项目发过的原话（2026-09-17）
 *
 * 数据丢失调查方案 1b（问题库 iss_mtxylgs4_xmmz、iss_mtvaq77w_xfa8）。「回到此处」会把那条消息
 * 连同之后的对话从 jsonl 里删掉，中断、失败的回合在上下文里也常常只剩半截；用户随后要
 * 「整合我说过的话」时，agent 手里没有原文。原文一直在 runs.brief（engine/runs/user-messages.js
 * 文件头讲了为什么），这里给一个只读入口。
 *
 * 项目限定：projectId 取自工具构造时的依赖，schema 里没有这个参数（模型多传的键会被 zod 剥掉），
 * sessionId / runId 只在本项目的行里查。
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listUserMessages, getUserMessage } from '../../runs/user-messages.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 列表里每条最多列这么多字；整批合计不超过 TOTAL_CHARS（MCP 返回太长会被 CLI 截掉） */
const PREVIEW_CHARS = 1500;
const TOTAL_CHARS = 24000;
/** 按 runId 读全文时一页的字数 */
const FULL_CHUNK = 12000;
const BJ_OFFSET_MS = 8 * 3600_000;   // 站点的时间口径是北京时间（lib/quota.js 同一个写死值）

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** 按码点切，emoji 不切成半个 */
const chars = (s) => Array.from(s || '');

const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * since 参数 → 与 runs.created_at 同格式的 UTC 串；认不出返回 null。
 * 不带时区的日期 / 时刻按北京时间读，跟输出里的时间同一个口径。
 */
export function parseSince(raw, now = Date.now()) {
  const s = String(raw || '').trim();
  let m = /^(\d+)\s*(m|min|h|d)$/i.exec(s);
  if (m) {
    const unit = { m: 60_000, min: 60_000, h: 3600_000, d: 86_400_000 }[m[2].toLowerCase()];
    return sqlUtc(now - Number(m[1]) * unit);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((v) => Number(v || 0));
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    return sqlUtc(Date.UTC(y, mo - 1, d, h, mi, se) - BJ_OFFSET_MS);
  }
  // 带时区的 ISO（…Z / …+08:00）按字面时刻
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? sqlUtc(ms) : null;
  }
  return null;
}

/** runs.created_at（UTC）→ 北京时间 'YYYY-MM-DD HH:MM' */
export function beijingTime(createdAt) {
  const ms = Date.parse(`${String(createdAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return String(createdAt);
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export function makeReadUserMessagesTool({ projectId, sessionId: currentSessionId = null }) {
  const sessionLabel = (sid, full = false) => {
    if (!sid) return '会话未记录';
    const name = full ? sid : sid.slice(0, 8);
    return `会话 ${name}${sid === currentSessionId ? '（本会话）' : ''}`;
  };
  const header = (it, fullSid) => `${beijingTime(it.createdAt)} · ${sessionLabel(it.sessionId, fullSid)} · ${it.outcome} · ${it.runId}`;
  const attachLine = (it) => (it.attachments > 0 ? `\n〔另附 ${it.attachments} 件附件，附件说明已略〕` : '');
  const emptyBody = '（只发了附件，没有文字）';

  function readOne(runId, offset = 0) {
    const it = getUserMessage({ projectId, runId });
    if (!it) return text(`本项目里没有 ${runId} 这条消息。runId 取自本工具列表里每条标题的最后一段，只能读本项目的。`, true);
    const all = chars(it.text);
    if (!all.length) return text(`${header(it, true)}\n${emptyBody}${attachLine(it)}`);
    if (offset >= all.length) return text(`offset ${offset} 超出范围：这条全文共 ${all.length} 字。`, true);
    const end = Math.min(all.length, offset + FULL_CHUNK);
    const range = (offset === 0 && end === all.length)
      ? `全文 ${all.length} 字`
      : `第 ${offset + 1}–${end} 字，共 ${all.length} 字${end < all.length ? `。接着读：read_user_messages { runId: "${it.runId}", offset: ${end} }` : '（到结尾）'}`;
    return text(`${header(it, true)}\n〔${range}〕\n${all.slice(offset, end).join('')}${end === all.length ? attachLine(it) : ''}`);
  }

  return tool(
    'read_user_messages',
    `Read what the user has typed to you in THIS project, verbatim, oldest first.
Use it when the user asks you to consolidate or recall what they said before
("整合我说过的话", "上次我提过什么"), or when earlier messages are gone from the
conversation (rolled back with "回到此处", interrupted, or failed turns) and you need
the original wording instead of guessing. Covers every message that started a turn in
this project, across all of its conversations, including interrupted and failed ones.
Other projects are never visible.

Each item: time (Beijing), conversation id, how that turn ended (成功 / 中断 / 失败 / 进行中),
run id, then the text. System notes and attachment listings are stripped (only a count of
attachments is kept). Long items are cut with a marker; pass runId (and offset) to read one
in full.

- sessionId: only that conversation (full ids are listed at the end of the output)
- since:     "2026-09-15", "2026-09-15 14:00" (Beijing time), ISO with offset, or "30m" / "6h" / "3d"
- query:     case-insensitive substring the text must contain
- limit:     how many of the most recent matches (default ${DEFAULT_LIMIT})
- runId:     read one message in full (other filters ignored); offset pages through very long ones`,
    {
      sessionId: z.string().min(1).max(80).optional()
        .describe('conversation id to restrict to (from this tool\'s output)'),
      since: z.string().min(1).max(40).optional()
        .describe('only messages at or after this time: "2026-09-15", "2026-09-15 14:00" (Beijing), ISO with offset, or "30m"/"6h"/"3d"'),
      query: z.string().min(1).max(100).optional()
        .describe('only messages whose text contains this (case-insensitive)'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional()
        .describe(`how many of the most recent matches to return (default ${DEFAULT_LIMIT})`),
      runId: z.string().min(1).max(80).optional()
        .describe('read this one message in full (the run id at the end of an item header)'),
      offset: z.number().int().min(0).optional()
        .describe('with runId: character offset to continue from'),
    },
    async ({ sessionId, since, query, limit = DEFAULT_LIMIT, runId, offset = 0 }) => {
      if (!projectId) return text('No project bound.', true);
      if (runId) return readOne(runId, offset);

      let sinceSql = null;
      if (since) {
        sinceSql = parseSince(since);
        if (!sinceSql) return text(`since 认不出「${since}」。可写 "2026-09-15"、"2026-09-15 14:00"（北京时间）、带时区的 ISO 时刻，或 "30m" / "6h" / "3d"。`, true);
      }
      const { items, hasMore } = listUserMessages({ projectId, sessionId, sinceSql, query, limit });

      const filters = [
        sessionId && `会话 ${sessionId}`,
        since && `${beijingTime(sinceSql)} 之后`,
        query && `包含「${query}」`,
      ].filter(Boolean);
      const scope = filters.length ? `（${filters.join('，')}）` : '';
      if (!items.length) {
        return text(sessionId
          ? `本项目里没有会话 ${sessionId} 的用户消息${scope}。sessionId 要用本工具输出末尾列出的全名，只能查本项目的会话。`
          : `本项目里没有符合条件的用户消息${scope}。`);
      }

      // 从最新的往回装，装到篇幅上限为止；输出按旧→新
      const blocks = [];
      let used = 0;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        const all = chars(it.text);
        let body = all.length ? all.slice(0, PREVIEW_CHARS).join('') : emptyBody;
        if (all.length > PREVIEW_CHARS) {
          body += `\n…〔原文共 ${all.length} 字，这里只列前 ${PREVIEW_CHARS} 字。读全文：read_user_messages { runId: "${it.runId}" }〕`;
        }
        const block = { it, body: `${body}${attachLine(it)}` };
        const size = block.body.length + 80;
        if (blocks.length && used + size > TOTAL_CHARS) break;
        used += size;
        blocks.unshift(block);
      }
      const dropped = items.length - blocks.length;

      const lines = [`本项目里用户发给你的消息${scope}，按时间从旧到新，时间为北京时间，共列 ${blocks.length} 条：`];
      blocks.forEach(({ it, body }, idx) => {
        lines.push('', `── ${idx + 1} · ${header(it, false)}`, body);
      });
      const notes = [];
      if (dropped > 0) notes.push(`更早的 ${dropped} 条因篇幅没有列出，调小 limit，或用 since / sessionId 分段读。`);
      if (hasMore) notes.push(`比这些更早的还有，用 since 或调大 limit（上限 ${MAX_LIMIT}）往前读。`);
      if (notes.length) lines.push('', ...notes);
      const sids = [...new Set(blocks.map(({ it }) => it.sessionId).filter(Boolean))];
      if (sids.length) lines.push('', `会话全名（传 sessionId 用）：${sids.map((s) => `${s}${s === currentSessionId ? '（本会话）' : ''}`).join('、')}`);
      return text(lines.join('\n'));
    },
  );
}
