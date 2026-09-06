/**
 * server/hosted/relay/issues.js — 客户端上报中继（2026-09-07 站主拍板：桌面版的 report_issue 指向站点）
 *
 * 桌面版的 agent 上报原来只落本机 issues 表，站主永远看不到。现在客户端把它排进
 * outbox（runtime/issue-outbox.js），经设备令牌 POST 到这里，落站点的同一张 issues 表：
 *   source = 'client'   agent 在客户端 report_issue 的（同指纹跨设备聚合）
 *   source = 'desktop'  桌面壳自己的事件（更新失败 / 服务端起不来 / 崩溃）
 *
 * 三条纪律（站主认可）：
 *   1. 只收 agent 写的正文 + 版本 / 平台 / 模型，不收工作区内容和对话原文（长度封顶，超了截）
 *   2. 客户端本机留一份、离线排队，这里只是收件口
 *   3. 限频：每设备每天 MAX_PER_DEVICE_PER_DAY 条，正文 ≤ 16KB —— 这是所有客户端都能打的口
 */
import { recordIssue, signatureOf } from '../../lib/issues-store.js';

export const MAX_PER_DEVICE_PER_DAY = 40;
const KINDS = new Set(['bug', 'friction', 'idea']);
const SOURCES = new Set(['agent', 'desktop']);

/** 每设备每日计数（进程内；重启归零可以接受 —— 它挡的是刷屏不是配额） */
const counts = new Map();
const dayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 跟计量同一条日界（北京时间）
function bump(deviceId) {
  const key = `${deviceId}:${dayKey()}`;
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  if (counts.size > 5000) { for (const k of counts.keys()) { if (!k.endsWith(dayKey())) counts.delete(k); } }
  return n;
}
export function _resetIssueCounts() { counts.clear(); }

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * 校验一条上报。返回 { ok, error } 或 { ok, item }。
 * 摘要 8~200、正文 ≤ 3000、期望 ≤ 1500 —— 跟 report_issue 工具 schema 同一组上限。
 */
export function validateIssuePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求体不是对象' };
  const kind = str(body.kind, 16);
  const source = str(body.source, 16) || 'agent';
  const summary = str(body.summary, 200);
  if (!KINDS.has(kind)) return { ok: false, error: 'kind 只认 bug / friction / idea' };
  if (!SOURCES.has(source)) return { ok: false, error: 'source 只认 agent / desktop' };
  if (summary.length < 8) return { ok: false, error: 'summary 太短' };
  return {
    ok: true,
    item: {
      kind, source, summary,
      detail: str(body.detail, 3000) || null,
      expectation: str(body.expectation, 1500) || null,
      toolName: str(body.toolName, 80) || null,
      signature: str(body.signature, 64) || null,
      clientVersion: str(body.clientVersion, 32) || null,
      platform: str(body.platform, 32) || null,
      modelId: str(body.modelId, 80) || null,
    },
  };
}

/**
 * 挂到 relay router 上（deviceAuth 之后）。
 * @param {import('express').Router} router
 * @param {{ sendError: Function, readRawBody: Function, record?: Function }} deps
 */
export function mountRelayIssues(router, { sendError, readRawBody, record = recordIssue }) {
  router.post('/issues', async (req, res) => {
    let body;
    try { body = JSON.parse((await readRawBody(req, 16 * 1024)).toString('utf8') || '{}'); }
    catch (err) { return sendError(res, err.status === 413 ? 413 : 400, err.status === 413 ? 'BODY_TOO_LARGE' : 'BAD_JSON', err.status === 413 ? '上报正文超过 16KB' : '请求体不是 JSON'); }
    const v = validateIssuePayload(body);
    if (!v.ok) return sendError(res, 400, 'BAD_ISSUE', v.error);
    const n = bump(req.relayDevice.id);
    if (n > MAX_PER_DEVICE_PER_DAY) return sendError(res, 429, 'ISSUE_RATE_LIMITED', `这台设备今天已上报 ${MAX_PER_DEVICE_PER_DAY} 条，明天再发`);
    const it = v.item;
    const header = `[桌面版${it.clientVersion ? ' v' + it.clientVersion : ''}${it.platform ? ' ' + it.platform : ''} · 设备 ${req.relayDevice.label || req.relayDevice.id}${it.modelId ? ' · ' + it.modelId : ''}]`;
    const rec = record({
      source: it.source === 'desktop' ? 'desktop' : 'client',
      kind: it.kind,
      toolName: it.toolName,
      summary: it.summary,
      detail: `${header}\n${it.detail || ''}`.trim(),
      expectation: it.expectation,
      projectId: null, sessionId: null, runId: null,
      userId: req.relayUser.id,
      signature: it.signature || signatureOf(`${it.toolName || ''}|${it.summary}`),
    });
    if (!rec) return sendError(res, 500, 'ISSUE_WRITE_FAILED', '站点这边没写进去');
    res.status(201).json({ ok: true, id: rec.id, count: rec.count });
  });
}
