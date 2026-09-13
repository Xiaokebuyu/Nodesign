/**
 * turnstile-probe.js — Turnstile 测量期：登录页静默跑一次不可见验证，只上报结果，不拦任何人（09-13 站主定「先量后定」）
 *
 * 服务端没配 site key 时 /api/auth/turnstile/config 回 null，这里什么都不做。
 * 同一个浏览器标签页只量一次（sessionStorage），免得来回切页面刷样本。
 * 上报的 outcome 与服务端 hosted/auth/turnstile-probe.js 的 OUTCOMES 一一对应。
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 30_000;
const FLAG = 'nd-turnstile-probed';

function alreadyProbed() {
  try { return sessionStorage.getItem(FLAG) === '1'; } catch { return false; }
}
function markProbed() {
  try { sessionStorage.setItem(FLAG, '1'); } catch { /* 隐私模式：量两次也无妨 */ }
}

function report(body) {
  fetch('/api/auth/turnstile/probe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
  }).catch(() => {});
}

function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    const timer = setTimeout(() => reject(new Error('script_timeout')), SCRIPT_TIMEOUT_MS);
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('script_error')); };
    document.head.appendChild(s);
  });
}

/** @param {'login'|'register'} page */
export async function runTurnstileProbe(page) {
  if (alreadyProbed()) return;
  let siteKey = null;
  try { siteKey = (await (await fetch('/api/auth/turnstile/config')).json())?.siteKey; } catch { return; }
  if (!siteKey) return;
  markProbed();

  const t0 = performance.now();
  try {
    await loadScript();
  } catch (err) {
    report({ page, outcome: err.message === 'script_timeout' ? 'script_timeout' : 'script_error', totalMs: performance.now() - t0 });
    return;
  }
  const loadMs = performance.now() - t0;
  if (!window.turnstile?.render) { report({ page, outcome: 'unsupported', loadMs }); return; }

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(box);
  let done = false;
  const finish = (body) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    report({ page, loadMs, totalMs: performance.now() - t0, ...body });
    try { box.remove(); } catch { /* 已经不在了 */ }
  };
  const timer = setTimeout(() => finish({ outcome: 'challenge_timeout' }), CHALLENGE_TIMEOUT_MS);
  try {
    window.turnstile.render(box, {
      sitekey: siteKey,
      action: 'turnstile-spin-v2',   // Cloudflare Spin 的统计标记（只做账号级聚合，不含用户信息）
      // 需要用户手动点一下才能过：测量期不把组件亮给用户，单独记一种结果，别跟「网络不通」混在超时里
      'before-interactive-callback': () => finish({ outcome: 'interaction_required' }),
      callback: (token) => finish({ outcome: 'passed', token }),
      'error-callback': (code) => { finish({ outcome: 'error', errorCode: String(code ?? '') }); return true; },
      'timeout-callback': () => finish({ outcome: 'challenge_timeout' }),
    });
  } catch {
    finish({ outcome: 'unsupported' });
  }
}
