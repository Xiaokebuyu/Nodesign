/**
 * server/hosted/auth/turnstile-probe.js — Turnstile 测量期（先量后定，站主 09-13 定）
 *
 * Cloudflare 官方说 Turnstile「在中国大陆不受支持，全球区域的大陆访客也可能遇到问题」，但没给失败率。
 * 人机验证是注册的必经关卡，加载不出来等于注册不了，所以先量：登录页静默跑一次不可见的 Turnstile，
 * 不拦任何人，只把结果按访客国家记下来（Cloudflare 转发的 cf-ipcountry）。不记账号、不记 IP。
 *
 *   GET  /api/auth/turnstile/config   → { siteKey | null }（没配就整段不跑）
 *   POST /api/auth/turnstile/probe    { page, outcome, token?, loadMs?, totalMs?, errorCode? }
 *
 * 环境变量：NODESIGN_TURNSTILE_SITE_KEY / NODESIGN_TURNSTILE_SECRET_KEY（Cloudflare 控制台建组件时选 Invisible）
 * 看结果：node server/scripts/turnstile-report.mjs
 *
 * 判定口径见设计方案 §6.1：大陆访客通过率 ≥ 98% 才开强制；结果交站主确认后再切。
 */

import db from '../../engine/runs/store.js';
import { makeRateWindow } from '../../lib/rate-window.js';
import { clientIp } from './client-ip.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS turnstile_probes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    country TEXT,
    page TEXT,
    outcome TEXT NOT NULL,
    verify_ok INTEGER,
    verify_error TEXT,
    error_code TEXT,
    load_ms INTEGER,
    total_ms INTEGER,
    mobile INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_turnstile_probes_time ON turnstile_probes(created_at);
`);

const OUTCOMES = new Set(['passed', 'error', 'script_error', 'script_timeout', 'challenge_timeout', 'interaction_required', 'unsupported']);
const PAGES = new Set(['login', 'register']);
const probeWindow = makeRateWindow({ limit: 10, windowMs: 60 * 60 * 1000 });

const int = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.round(Number(v)), 600_000) : null);

/** 服务端核验令牌（证明浏览器那头不是自己编了个 passed） */
async function siteverify(token, ip) {
  const secret = process.env.NODESIGN_TURNSTILE_SECRET_KEY;
  if (!secret || typeof token !== 'string' || token.length > 4096) return { ok: null, error: secret ? 'no-token' : 'no-secret' };
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    return { ok: !!j.success, error: j.success ? null : (j['error-codes'] || []).join(',').slice(0, 100) };
  } catch (err) {
    return { ok: null, error: `siteverify-unreachable:${err.name}` };
  }
}

export function mountTurnstileProbe(router) {
  router.get('/turnstile/config', (_req, res) => {
    res.json({ siteKey: process.env.NODESIGN_TURNSTILE_SITE_KEY || null });
  });

  router.post('/turnstile/probe', async (req, res) => {
    if (!process.env.NODESIGN_TURNSTILE_SITE_KEY) return res.status(404).json({ error: 'not configured' });
    const ip = clientIp(req);
    if (!probeWindow.take(ip).ok) return res.status(204).end();   // 超频直接丢，不回错（前端不在乎）
    const b = req.body || {};
    const outcome = OUTCOMES.has(b.outcome) ? b.outcome : null;
    if (!outcome) return res.status(400).json({ error: 'bad outcome' });
    const verify = outcome === 'passed' ? await siteverify(b.token, ip) : { ok: null, error: null };
    const country = String(req.headers['cf-ipcountry'] || '').slice(0, 2).toUpperCase() || null;
    const mobile = /Mobi|Android|iPhone/i.test(String(req.headers['user-agent'] || '')) ? 1 : 0;
    db.prepare(`INSERT INTO turnstile_probes (created_at, country, page, outcome, verify_ok, verify_error, error_code, load_ms, total_ms, mobile)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), country, PAGES.has(b.page) ? b.page : null, outcome, verify.ok == null ? null : (verify.ok ? 1 : 0),
        verify.error, typeof b.errorCode === 'string' ? b.errorCode.slice(0, 40) : null, int(b.loadMs), int(b.totalMs), mobile);
    res.status(204).end();
  });
}
