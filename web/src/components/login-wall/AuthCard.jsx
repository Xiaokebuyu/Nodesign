/**
 * AuthCard — 网页登录墙里那张登记卡的内容（09-13 auth-v2 第三批）
 *
 * 先输邮箱或用户名、再按账号状态分流（设计方案 §5.1）。步骤：
 *   start           第三方登录按钮 + 「邮箱或用户名」
 *   password        输密码（邮箱账号另有「忘记密码」「改用邮箱验证码登录」）
 *   code            邮箱验证码登录
 *   register        注册：emailAuth 开着走邮箱 + 验证码，关着走老的用户名注册
 *   register-code   注册验证码
 *   name            注册完起名字（预填派生出来的用户名，可跳过）
 *   forgot / forgot-code / reset   找回密码三步
 *   pending         第三方登录的邮箱撞上已有账号：输发到该邮箱的验证码确认关联
 *
 * emailAuth（/api/auth/methods）：SES 还没脱离沙盒时真实邮箱收不到信，关着时一切依赖邮件的入口都不露。
 * 服务端回的 error 已经按语言本地化，直接显示；这里只翻前端自己的话。
 *
 * 放在 login-wall/ 下：首屏字集脚本（web/scripts/gen-font-subset.py）按目录扫，改了文案要重跑它。
 */

import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n.js';

const GOOGLE_ICON = (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
const GITHUB_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/** 第三方登录回跳时带回来的错误码 → 给人看的话（码表与 server/hosted/auth/oauth-routes.js 的 ERROR_CODES 对应） */
export function oauthErrorText(code) {
  switch (code) {
    case 'access_denied': return t('已取消第三方授权');
    case 'state_mismatch': return t('登录已过期，请重新发起');
    case 'no_verified_email': return t('这个第三方账号没有已验证的邮箱，请先在对方平台验证邮箱');
    case 'registration_closed': return t('目前不开放注册');
    case 'register_rate_limited': return t('这个网络今天注册的账号过多，请明天再试');
    case 'rate_limited': return t('操作过于频繁，请稍后再试');
    case 'identity_taken': return t('这个第三方账号已关联其他账号');
    case 'login_failed': return t('登录失败');
    case 'mail_failed': return t('验证码邮件发送失败，请稍后再试');
    case 'email_taken': return t('这个邮箱已经注册');
    case 'provider_unavailable': return t('暂不支持这种登录方式');
    default: return t('第三方登录未完成，请重试');
  }
}

async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: t('网络错误，请重试') } };
  }
}

const PROVIDER_LABEL = { google: 'Google', github: 'GitHub' };

/** 第三方登录的起点：不在首页 / 登录页上发起时带上当前页，登录完回到这里（桌面版登录确认页 /desktop-auth 靠它） */
export function oauthStartHref(provider, here = `${location.pathname}${location.search}`) {
  const back = here === '/' || here.startsWith('/login') ? '' : `?return=${encodeURIComponent(here)}`;
  return `/api/auth/oauth/${provider}/start${back}`;
}

/**
 * @param {{ openReg: boolean, onAuthed: (user) => void, className: string, children?: any }} props
 *   className / children：外层表单的样式与装饰（钉子、印章），由 AuthGate 按宽窄屏给
 */
export default function AuthCard({ openReg, onAuthed, className, children }) {
  const [methods, setMethods] = useState({ providers: [], emailAuth: false, supportEmail: null });
  const [step, setStep] = useState('start');
  const [identifier, setIdentifier] = useState('');
  const [kind, setKind] = useState('username');          // identify 的结论：username | email
  const [account, setAccount] = useState(null);           // 邮箱账号的 methods（有没有密码、关联了哪几家）
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  const [username, setUsername] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [pending, setPending] = useState(null);           // { token, provider, email }
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const authedUser = useRef(null);

  useEffect(() => {
    fetch('/api/auth/methods').then((r) => r.json()).then((m) => setMethods({ providers: m.providers || [], emailAuth: !!m.emailAuth, supportEmail: m.supportEmail || null })).catch(() => {});
    // 第三方登录回跳：?oauth_error=… 或 #oauth_pending=…（令牌放片段里，不进服务器日志）
    const q = new URLSearchParams(location.search);
    const oauthError = q.get('oauth_error');
    const pendingToken = /(?:^#|&)oauth_pending=([^&]+)/.exec(location.hash)?.[1];
    // 只摘掉回跳带来的那两样：从 /desktop-auth?port=… 这类页面发起的登录，原页参数要留着
    if (oauthError || pendingToken) {
      q.delete('oauth_error');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    }
    if (oauthError) setError(oauthErrorText(oauthError));
    if (pendingToken) {
      // 令牌只放 body：放进请求路径就会进 nginx / Cloudflare 的访问日志
      post('/api/auth/oauth/pending/lookup', { token: pendingToken }).then(({ ok, data }) => {
        if (!ok) { setError(data.error || t('登录已过期，请重新发起')); return; }
        setPending({ token: pendingToken, provider: data.provider, email: data.email });
        setStep('pending');
      });
    }
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const go = (next) => { setStep(next); setError(''); setInfo(''); setCode(''); };
  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } finally { setBusy(false); }
  };
  const fail = (r) => setError(r.data?.error || t('操作失败 ({status})', { status: r.status }));
  const done = (user) => onAuthed(user || null);

  const email = kind === 'email' ? identifier.trim() : '';

  async function identify() {
    const value = identifier.trim();
    if (!value) return;
    const r = await post('/api/auth/identify', { identifier: value });
    if (!r.ok) return fail(r);
    setKind(r.data.kind);
    if (r.data.kind === 'username') return go('password');
    if (!r.data.exists) {
      if (methods.emailAuth) { go('register'); setInfo(t('这个邮箱还没有注册，设置密码即可创建账号')); return undefined; }
      return setError(t('这个邮箱还没有注册。可以使用第三方账号继续，或用用户名注册'));
    }
    setAccount(r.data.methods || null);
    return go(r.data.methods?.password ? 'password' : 'code-choice');
  }

  async function sendCode(path, body, next) {
    const r = await post(path, body);
    if (!r.ok) return fail(r);
    go(next);
    setInfo(t('验证码已发送至 {email}，10 分钟内有效', { email: body.email }));
    setCooldown(60);
    return undefined;
  }

  const submitters = {
    start: identify,
    password: async () => {
      if (!password) return;
      const r = await post('/api/auth/login', { identifier: identifier.trim(), password });
      if (!r.ok) return fail(r);
      done(r.data.user);
    },
    'code-choice': () => sendCode('/api/auth/login/code/start', { email }, 'code'),
    code: async () => {
      const r = await post('/api/auth/login/code/verify', { email, code });
      if (!r.ok) return fail(r);
      done(r.data.user);
    },
    register: async () => {
      if (!methods.emailAuth) {
        const r = await post('/api/auth/register', { username: username.trim(), password, inviteCode });
        if (!r.ok) return fail(r);
        return done(r.data.user);
      }
      return sendCode('/api/auth/register/start', { email: identifier.trim(), password, inviteCode }, 'register-code');
    },
    'register-code': async () => {
      const r = await post('/api/auth/register/verify', { email: identifier.trim(), code });
      if (!r.ok) return fail(r);
      authedUser.current = r.data.user;
      setUsername(r.data.user?.username || '');
      go('name');
    },
    name: async () => {
      const current = authedUser.current;
      const wanted = username.trim();
      if (wanted && current && wanted !== current.username) {
        const r = await fetch('/api/me/account/username', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: wanted }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return setError(d.error || t('操作失败 ({status})', { status: r.status }));
        return done(d.user);
      }
      done(current);
    },
    forgot: () => sendCode('/api/auth/password/forgot/start', { email: identifier.trim() }, 'forgot-code'),
    'forgot-code': async () => {
      const r = await post('/api/auth/password/forgot/verify', { email: identifier.trim(), code });
      if (!r.ok) return fail(r);
      setResetToken(r.data.resetToken);
      setPassword('');
      go('reset');
    },
    reset: async () => {
      const r = await post('/api/auth/password/reset', { resetToken, password });
      if (!r.ok) return fail(r);
      done(r.data.user);
    },
    pending: async () => {
      const r = await post('/api/auth/oauth/pending/verify', { token: pending.token, code });
      if (!r.ok) return fail(r);
      if (r.data.returnTo && r.data.returnTo !== '/' && r.data.returnTo !== location.pathname) { location.assign(r.data.returnTo); return; }
      done(r.data.user);
    },
  };

  const onSubmit = (e) => { e.preventDefault(); run(submitters[step]); };

  const resend = (path, body) => (
    <a href="#resend" className={cooldown > 0 ? 'off' : ''} onClick={(e) => { e.preventDefault(); if (cooldown <= 0) run(() => sendCode(path, body, step)); }}>
      {cooldown > 0 ? t('{sec} 秒后可重新发送', { sec: cooldown }) : t('重新发送验证码')}
    </a>
  );

  const who = (
    <div className="ndw-who">
      <span>{identifier.trim()}</span>
      <a href="#change" onClick={(e) => { e.preventDefault(); setPassword(''); go('start'); }}>{t('更换')}</a>
    </div>
  );

  const field = (id, label, props) => (
    <div className="ndw-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
    </div>
  );
  const codeField = field('ndw-code', t('验证码 · CODE'), {
    value: code, inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 6, autoFocus: true, placeholder: t('6 位数字'),
    onChange: (e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6)),
  });
  const passwordField = (label, placeholder, autoComplete) => field('ndw-p', label, {
    type: 'password', value: password, placeholder, autoComplete, autoFocus: true, onChange: (e) => setPassword(e.target.value),
  });
  const submitButton = (label) => <button className="go" type="submit" disabled={busy}>{busy ? t('正在处理') : label}</button>;
  const providerButtons = (list) => list.length > 0 && (
    <div className="ndw-oauth">
      {list.map((p) => (
        <a key={p} className="ndw-provider" href={oauthStartHref(p)}>
          <i>{p === 'google' ? GOOGLE_ICON : GITHUB_ICON}</i>
          {p === 'google' ? t('使用 Google 继续') : t('使用 GitHub 继续')}
        </a>
      ))}
    </div>
  );
  const legal = (
    <p className="ndw-legal">
      {t('继续即表示你同意')}<a href="/welcome/terms.html">{t('《服务条款》')}</a>{t('与')}<a href="/welcome/privacy.html">{t('《隐私政策》')}</a>
    </p>
  );

  let body;
  switch (step) {
    case 'password':
      body = (<>
        <h2>{t('输入密码')}</h2>
        {who}
        {/* 给密码管理器认登录名用：先输邮箱再输密码的页面上，这一步没有可见的用户名框 */}
        <input type="text" name="username" autoComplete="username" value={identifier.trim()} readOnly tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
        {passwordField(t('密码 · PASSWORD'), t('请输入密码'), 'current-password')}
        <p className="ndw-err">{error}</p>
        {submitButton(t('登录'))}
        {kind === 'email' && methods.emailAuth && (
          <p className="ndw-links">
            <a href="#forgot" onClick={(e) => { e.preventDefault(); go('forgot'); }}>{t('忘记密码')}</a>
            <a href="#code" onClick={(e) => { e.preventDefault(); run(submitters['code-choice']); }}>{t('改用邮箱验证码登录')}</a>
          </p>
        )}
        {kind === 'username' && methods.supportEmail && (
          <>
            <p className="ndw-links"><a href="#forgot" onClick={(e) => { e.preventDefault(); setShowSupport((v) => !v); }}>{t('忘记密码')}</a></p>
            {showSupport && (
              <p className="ndw-note">
                {methods.emailAuth
                  ? t('如果账号绑定过邮箱，请改为输入邮箱找回密码；没有绑定邮箱的账号，请发送邮件至 {email} 处理。', { email: methods.supportEmail })
                  : t('用户名账号暂不支持自助找回密码，请发送邮件至 {email} 处理。', { email: methods.supportEmail })}
              </p>
            )}
          </>
        )}
      </>);
      break;
    case 'code-choice':
      body = (<>
        <h2>{t('选择登录方式')}</h2>
        {who}
        <p className="ndw-note">
          {account?.providers?.length
            ? t('这个账号通过 {providers} 登录', { providers: account.providers.map((p) => PROVIDER_LABEL[p] || p).join(' / ') })
            : t('这个账号没有设置密码')}
        </p>
        {/* 只给站点现在开着的那几家（关掉的服务商点了也只会跳回 provider_unavailable） */}
        {providerButtons((account?.providers || []).filter((p) => methods.providers.includes(p)))}
        <p className="ndw-err">{error}</p>
        {methods.emailAuth && submitButton(t('发送邮箱验证码'))}
      </>);
      break;
    case 'code':
      body = (<>
        <h2>{t('邮箱验证码登录')}</h2>
        {who}
        {codeField}
        <p className="ndw-info">{info}</p>
        <p className="ndw-err">{error}</p>
        {submitButton(t('登录'))}
        <p className="ndw-links">{resend('/api/auth/login/code/start', { email })}</p>
      </>);
      break;
    case 'register':
      body = methods.emailAuth ? (<>
        <h2>{t('创建账号')}</h2>
        {field('ndw-e', t('邮箱 · EMAIL'), { type: 'email', value: identifier, autoComplete: 'email', placeholder: t('请输入邮箱'), onChange: (e) => setIdentifier(e.target.value) })}
        {passwordField(t('密码 · PASSWORD'), t('设置密码，至少 8 位'), 'new-password')}
        {(showInvite || !openReg) && field('ndw-i', t('邀请码 · INVITE'), { value: inviteCode, placeholder: 'nd-xxxxxxxx', onChange: (e) => setInviteCode(e.target.value) })}
        <p className="ndw-info">{info}</p>
        <p className="ndw-err">{error}</p>
        {submitButton(t('发送验证码'))}
        <p className="ndw-links">
          <a href="#back" onClick={(e) => { e.preventDefault(); go('start'); }}>{t('已有账号，去登录')}</a>
          {openReg && !showInvite && <a href="#invite" onClick={(e) => { e.preventDefault(); setShowInvite(true); }}>{t('有邀请码')}</a>}
        </p>
      </>) : (<>
        <h2>{t('创建账号')}</h2>
        {field('ndw-u', t('用户名 · USERNAME'), { value: username, autoComplete: 'username', autoFocus: true, placeholder: t('2 到 32 位'), onChange: (e) => setUsername(e.target.value) })}
        {passwordField(t('密码 · PASSWORD'), t('设置密码，至少 8 位'), 'new-password')}
        {!openReg && field('ndw-i', t('邀请码 · INVITE'), { value: inviteCode, placeholder: 'nd-xxxxxxxx', onChange: (e) => setInviteCode(e.target.value) })}
        <p className="ndw-err">{error}</p>
        {submitButton(t('创建账号'))}
        <p className="ndw-links"><a href="#back" onClick={(e) => { e.preventDefault(); go('start'); }}>{t('已有账号，去登录')}</a></p>
      </>);
      break;
    case 'register-code':
      body = (<>
        <h2>{t('验证邮箱')}</h2>
        {who}
        {codeField}
        <p className="ndw-info">{info}</p>
        <p className="ndw-err">{error}</p>
        {submitButton(t('创建账号'))}
        <p className="ndw-links">{resend('/api/auth/register/start', { email: identifier.trim(), password, inviteCode })}</p>
      </>);
      break;
    case 'name':
      body = (<>
        <h2>{t('设置用户名')}</h2>
        <div className="m">{t('发布的内容会署这个名字，之后可以修改')}</div>
        {field('ndw-u', t('用户名 · USERNAME'), { value: username, autoFocus: true, onChange: (e) => setUsername(e.target.value) })}
        <p className="ndw-err">{error}</p>
        {submitButton(t('开始使用'))}
      </>);
      break;
    case 'forgot':
      body = (<>
        <h2>{t('找回密码')}</h2>
        <div className="m">{t('验证码将发送到账号绑定的邮箱')}</div>
        {field('ndw-e', t('邮箱 · EMAIL'), { type: 'email', value: identifier, autoFocus: true, autoComplete: 'email', onChange: (e) => setIdentifier(e.target.value) })}
        <p className="ndw-err">{error}</p>
        {submitButton(t('发送验证码'))}
        <p className="ndw-links"><a href="#back" onClick={(e) => { e.preventDefault(); go('start'); }}>{t('返回登录')}</a></p>
      </>);
      break;
    case 'forgot-code':
      body = (<>
        <h2>{t('找回密码')}</h2>
        {who}
        {codeField}
        <p className="ndw-info">{info}</p>
        <p className="ndw-err">{error}</p>
        {submitButton(t('下一步'))}
        <p className="ndw-links">{resend('/api/auth/password/forgot/start', { email: identifier.trim() })}</p>
      </>);
      break;
    case 'reset':
      body = (<>
        <h2>{t('设置新密码')}</h2>
        <div className="m">{t('保存后，所有设备上的登录（包括桌面版）都会退出')}</div>
        {passwordField(t('新密码 · NEW PASSWORD'), t('至少 8 位'), 'new-password')}
        <p className="ndw-err">{error}</p>
        {submitButton(t('保存并登录'))}
      </>);
      break;
    case 'pending':
      body = (<>
        <h2>{t('确认关联')}</h2>
        <div className="m">
          {t('邮箱 {email} 已注册 NoDesign。输入发送到该邮箱的验证码，将 {provider} 关联到这个账号并登录。', { email: pending?.email || '', provider: PROVIDER_LABEL[pending?.provider] || '' })}
        </div>
        {codeField}
        <p className="ndw-err">{error}</p>
        {submitButton(t('确认并登录'))}
        <p className="ndw-links"><a href="#back" onClick={(e) => { e.preventDefault(); setPending(null); go('start'); }}>{t('返回登录')}</a></p>
      </>);
      break;
    default:
      body = (<>
        <h2>{t('登录 NoDesign')}</h2>
        <div className="m">{openReg ? t('开放注册') : t('内测阶段，仅限邀请')}</div>
        {providerButtons(methods.providers)}
        {methods.providers.length > 0 && <div className="ndw-or"><span>{t('或')}</span></div>}
        {field('ndw-id', t('邮箱或用户名 · EMAIL / USERNAME'), {
          value: identifier, autoFocus: true, autoComplete: 'username', placeholder: t('请输入邮箱或用户名'),
          onChange: (e) => setIdentifier(e.target.value),
        })}
        <p className="ndw-err">{error}</p>
        {submitButton(t('继续'))}
        <p className="ndw-links">
          <span>{t('还没有账号？')}<a href="#register" onClick={(e) => { e.preventDefault(); setPassword(''); go('register'); }}>{t('注册')}</a></span>
        </p>
        {methods.providers.length > 0 && <p className="ndw-note">{t('用户名注册的老账号，直接输入用户名即可登录')}</p>}
        {legal}
        <div className="alt">
          <a href="https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe">{t('下载 Windows 桌面版')} →</a>
          <a href="/welcome/docs.html">{t('查看文档')} →</a>
        </div>
      </>);
  }

  return <form className={className} onSubmit={onSubmit}>{children}{body}</form>;
}
