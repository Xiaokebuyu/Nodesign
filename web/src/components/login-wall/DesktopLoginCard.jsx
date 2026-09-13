/**
 * DesktopLoginCard — 本地版（桌面 / npx）首启门的登记卡内容（09-13 auth-v2 第四批从 AuthGate 拆出）
 *
 * 两条路：
 *   在浏览器中登录（主）  系统浏览器打开站点确认页，邮箱 / Google / GitHub 任选，点「允许」后自动回来（lib/use-browser-login.js）
 *   账号密码（备选）      老路：账号密码经本地服务端去站点换设备令牌（/api/local/relay/login）。只用第三方登录的账号没有密码，走不了这条
 *
 * desktop.expired：令牌是被站点判失效清掉的（设备被退出、重设过密码），开门先说明原因，免得用户以为是软件坏了。
 *
 * 放在 login-wall/ 下：首屏字集脚本（web/scripts/gen-font-subset.py）按目录扫，改了文案要重跑它。
 */

import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { openUrl } from '../../lib/open-url.js';
import { useBrowserLogin } from '../../lib/use-browser-login.js';

/**
 * @param {{ desktop: object, onDone: () => void, className: string, children?: any }} props
 *   desktop：/api/auth/status 的 desktop 字段；className / children：外层表单的样式与装饰（钉子、印章），由 AuthGate 给
 */
export default function DesktopLoginCard({ desktop, onDone, className, children }) {
  const [mode, setMode] = useState('browser');   // browser | password
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [siteUrl, setSiteUrl] = useState('');     // 空 = 官方站；自建实例 / exp 才填
  const [showSite, setShowSite] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const browser = useBrowserLogin({ onDone });

  const site = siteUrl.trim();

  async function submitPassword() {
    if (busy || !identifier.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/local/relay/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier.trim(), password, ...(site ? { url: site } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onDone();
      else setError(data.error || t('登录失败 ({status})', { status: res.status }));
    } catch {
      setError(t('网络错误，请重试'));
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e) => {
    e.preventDefault();
    if (mode === 'password') submitPassword();
    else if (!browser.waiting) browser.start(site || undefined);
  };

  const siteField = showSite && (
    <div className="ndw-field">
      <label htmlFor="ndw-s">{t('站点地址 · SITE')}</label>
      <input id="ndw-s" value={siteUrl} placeholder={desktop.url || ''} onChange={(e) => setSiteUrl(e.target.value)} />
    </div>
  );
  const siteToggle = (
    <a href="#site" onClick={(e) => { e.preventDefault(); setShowSite((v) => !v); }}>{showSite ? t('用官方站') : t('换个站点')}</a>
  );
  const connectError = desktop.error && !desktop.expired ? t('连不上站点：{err}', { err: desktop.error }) : '';

  let body;
  if (browser.waiting) {
    body = (<>
      <h2>{t('在浏览器中完成登录')}</h2>
      <div className="m">{t('已在浏览器中打开 NoDesign 站点。登录并点击「允许」后，这里会自动继续。')}</div>
      <p className="ndw-info">{browser.attemptError ? t('上一次尝试没有完成：{err}', { err: browser.attemptError }) : ''}</p>
      <button className="go" type="button" onClick={browser.reopen}>{t('重新打开浏览器')}</button>
      <p className="ndw-links">
        <a href="#copy" onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(browser.authorizeUrl).catch(() => {}); }}>{t('复制登录链接')}</a>
        <a href="#cancel" onClick={(e) => { e.preventDefault(); browser.cancel(); }}>{t('取消')}</a>
      </p>
    </>);
  } else if (mode === 'password') {
    body = (<>
      <h2>{t('登录 NoDesign')}</h2>
      <div className="m">{t('使用站点账号登录后，本机即可使用站点提供的模型与额度')}</div>
      <div className="ndw-field">
        <label htmlFor="ndw-u">{t('邮箱或用户名 · EMAIL / USERNAME')}</label>
        <input id="ndw-u" value={identifier} placeholder={t('请输入邮箱或用户名')} autoFocus
          autoComplete="username" onChange={(e) => setIdentifier(e.target.value)} />
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-p">{t('密码 · PASSWORD')}</label>
        <input id="ndw-p" type="password" value={password} placeholder={t('请输入密码')}
          autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      </div>
      {siteField}
      <p className="ndw-err">{error || connectError}</p>
      <button className="go" type="submit" disabled={busy}>{busy ? t('正在验证') : t('登录')}</button>
      <p className="ndw-links">
        <a href="#browser" onClick={(e) => { e.preventDefault(); setError(''); setMode('browser'); }}>{t('改用浏览器登录')}</a>
        {siteToggle}
      </p>
    </>);
  } else {
    body = (<>
      <h2>{t('登录 NoDesign')}</h2>
      <div className="m">{t('使用站点账号登录后，本机即可使用站点提供的模型与额度')}</div>
      {desktop.expired && <p className="ndw-note">{t('这台设备的登录已失效（可能已在站点退出此设备，或账号重设了密码），请重新登录。')}</p>}
      {siteField}
      <p className="ndw-err">{browser.error || connectError}</p>
      <button className="go" type="submit">{t('在浏览器中登录')}</button>
      <p className="ndw-note">{t('将在系统浏览器中打开 NoDesign 站点，可以使用邮箱、Google 或 GitHub 登录。')}</p>
      <p className="ndw-links">
        <a href="#password" onClick={(e) => { e.preventDefault(); setMode('password'); }}>{t('使用账号密码登录')}</a>
        {siteToggle}
      </p>
    </>);
  }

  return (
    <form className={className} onSubmit={onSubmit}>
      {children}
      {body}
      <p className="foot">
        <a href={site || desktop.url || '#'} onClick={(e) => { e.preventDefault(); openUrl(site || desktop.url); }}>{t('没有账号？前往站点注册')}</a>
      </p>
    </form>
  );
}
