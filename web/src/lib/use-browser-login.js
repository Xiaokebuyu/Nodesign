/**
 * use-browser-login.js — 本地版（桌面 / npx）「在浏览器中登录」的页面半（09-13 auth-v2 第四批）
 *
 * 本地服务端生成 state 与 PKCE，回一个站点确认页地址（server/api/local-relay-login.js）；
 * 这里把地址交给系统浏览器（open-url.js：桌面走壳的桥，npx 开新标签页），然后每 1.2 秒问一次结果。
 * 用户在浏览器里登录、点「允许」，浏览器跳回本机回调，本地服务端换好令牌 → 状态变 done → onDone。
 *
 * 首启门（login-wall/DesktopLoginCard.jsx）与设置页（settings/AccountSection.jsx）共用。
 */

import { useEffect, useRef, useState } from 'react';
import { openUrl } from './open-url.js';
import { t } from './i18n.js';

const POLL_MS = 1200;

async function request(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

/**
 * @param {{ onDone: () => void }} opts
 * @returns {{ waiting: boolean, authorizeUrl: string, error: string, attemptError: string,
 *   start: (url?: string) => Promise<void>, reopen: () => void, cancel: () => void }}
 */
export function useBrowserLogin({ onDone }) {
  const [loginState, setLoginState] = useState(null);   // 本地服务端给的 state；非空 = 正在等浏览器那边
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [error, setError] = useState('');
  const [attemptError, setAttemptError] = useState('');   // 还在等，但上一次回调没换成（码过期之类）
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!loginState) return undefined;
    let stopped = false;
    const tick = async () => {
      let r;
      try { r = await request('GET', `/api/local/relay/browser-login/${encodeURIComponent(loginState)}`); }
      catch { return; }   // 本地服务暂时连不上（重启中）：下一拍再问
      if (stopped) return;
      if (r.status === 'pending') { setAttemptError(r.error || ''); return; }
      setLoginState(null);
      setAttemptError('');
      // superseded：别的一条等待先成功了（比如刷新前发起的那次在浏览器里点了允许），本机已经登录，一样算完成
      if (r.status === 'done' || r.status === 'superseded') {
        window.nodesignDesktop?.focusWindow?.()?.catch?.(() => {});
        doneRef.current?.();
      } else if (r.status === 'failed') {
        setError(r.error || t('登录没有完成'));
      } else if (r.status === 'expired') {
        setError(t('登录请求已过期，请重新发起'));
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [loginState]);

  const start = async (url) => {
    setError('');
    setAttemptError('');
    // npx 版在普通浏览器里：window.open 要在点击的同一拍里调，等 fetch 回来再开会被弹窗拦截（Safari 尤其）。
    // 先开一个空白窗口占住，地址回来再填进去。桌面版走壳的桥，不需要用户手势
    const pre = window.nodesignDesktop?.openExternal ? null : window.open('about:blank', '_blank');
    if (pre) { try { pre.opener = null; } catch { /* 跨源后不可写，无妨 */ } }
    try {
      const r = await request('POST', '/api/local/relay/browser-login', url ? { url } : {});
      setAuthorizeUrl(r.authorizeUrl);
      setLoginState(r.state);
      if (pre && !pre.closed) pre.location.href = r.authorizeUrl;
      else openUrl(r.authorizeUrl);
    } catch (err) {
      if (pre && !pre.closed) pre.close();
      setError(err.status ? err.message : t('网络错误，请重试'));
    }
  };

  const reopen = () => { if (authorizeUrl) openUrl(authorizeUrl); };

  const cancel = () => {
    const s = loginState;
    setLoginState(null);
    setAttemptError('');
    if (!s) return;
    // 取消晚了一步（浏览器那边正在换令牌，或已经换完）：接着等结果，别让令牌落了盘界面却停在登录门
    request('DELETE', `/api/local/relay/browser-login/${encodeURIComponent(s)}`)
      .then((r) => { if (r?.busy || r?.status === 'done' || r?.status === 'superseded') setLoginState(s); })
      .catch(() => {});
  };

  return { waiting: !!loginState, authorizeUrl, error, attemptError, start, reopen, cancel };
}
