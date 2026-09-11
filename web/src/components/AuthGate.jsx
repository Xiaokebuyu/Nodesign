/**
 * AuthGate — 登录墙（2026-07-30 多用户版；2026-08-03 线索墙改版；2026-08-17 拆场景 + 定格轮播）
 *
 * 挂载时查 /api/auth/status：
 *   - required=false（dev 模式）或已有有效身份 → 渲染 app，并把 user 挂到
 *     globalStore（顶栏显示用户名 / 登出、admin 判定都从那读）
 *   - 否则渲染登录页；「邀请码注册」tab 给内测新用户自助开号
 *
 * 全局 401：api.js jsonRequest 收到 401 时派发 `nd:unauthorized` window 事件，
 * 这里监听 → 回登录态（解决 cookie 过期后散落报错、WS 4401 停止重连后卡死）。
 *
 * cookie 是 HttpOnly + 30 天，同源 fetch 自动携带。
 *
 * ## 这个文件现在只剩三件事
 *
 * 鉴权、**壳**（板面 / 标题 / 登记卡 / 缩放）、轮播的接线。墙上钉的那些纸不在这儿
 * —— 一套构图一个文件，住在 `login-wall/scenes/`，材质词汇在 `login-wall/wall-css.js`。
 * 切口是用户当初定的那句「能共用的是材质，不是坐标」。
 *
 * 壳里为什么留着标题和登记卡：它们是**跨场景不变的锚**。墙可以换故事，但访客得
 * 认得出这是哪儿、进门的门在哪；全都跟着换，这页就没有身份了。所以新场景设计时
 * 要绕开左上角标题区和右侧登记卡那两块地。
 *
 * 这个页面在鉴权之前，不能走 /api，也绝不引用真实用户数据，墙上内容全是写死的样例。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PAPER } from '../lib/paper.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { WALL_CSS, STEPS } from './login-wall/wall-css.js';
import { DESIGN_W, SAFE_H, NARROW_W, NAV_H } from './login-wall/geometry.js';
import nMark from '../assets/brand/n-mark.png';
import { SCENES } from './login-wall/scenes/index.js';
import { useSceneCarousel } from './login-wall/useSceneCarousel.js';
import Scene from './login-wall/Scene.jsx';
import { hasExplicitLocale, t } from '../lib/i18n.js';
import LanguageSwitcher from './ui/LanguageSwitcher.jsx';

export default function AuthGate({ children }) {
  // checking | login | ok
  const [phase, setPhase] = useState('checking');
  const [mode, setMode] = useState('login');   // login | register
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [openReg, setOpenReg] = useState(false);   // 服务端 /api/auth/status 的 openRegistration：没邀请码也能开号（08-21）
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // 本地分发版（桌面版 / npx）的首启门：站点账号没登录就先登录。账号密码交给本地服务端，它去站点换
  // 设备令牌（/api/local/relay/login），从此这台机器走站点的模型和额度。"我自己带钥匙"是那道门旁的小门。
  const [desktop, setDesktop] = useState(null);   // /api/auth/status 的 desktop 字段（只有 local 档位有）
  const [siteUrl, setSiteUrl] = useState('');       // 桌面登录：站点地址（空 = 官方站；自建实例 / exp 才填）
  const [showSite, setShowSite] = useState(false);
  const rootRef = useRef(null);

  const applyStatus = (s) => {
    setOpenReg(!!s.openRegistration);
    useGlobalStore.getState().setAuthProfile?.(s.profile);
    if (s.profile === 'local') {
      setDesktop(s.desktop || null);
      useGlobalStore.getState().setAuthUser?.(s.user || null);
      // 登录是必经的（站主 09-06 定的）：没令牌就是这道门，没有绕开的路。BYOK 是登录之后设置页里的事
      if (s.desktop?.loggedIn && !s.desktop.setupDone && location.pathname !== '/setup') { location.replace('/setup'); return; }
      setPhase(s.desktop?.loggedIn ? 'ok' : 'login');
      return;
    }
    // 账号上记的界面语言回填（2026-08-26 i18n）。explicit:false —— 这不是用户
    // 此刻的表态，只是把账号偏好搬过来，**不能盖掉本机已有的显式选择**：
    // 一个人在这台机器上切成英文，就该是英文，哪怕账号上记的是中文。
    if (s.user?.locale && !hasExplicitLocale()) {
      useGlobalStore.getState().setLocale?.(s.user.locale, { explicit: false });
    }
    if (!s.required || s.authed) {
      useGlobalStore.getState().setAuthUser?.(s.user || null);
      setPhase('ok');
    } else {
      // 没登录的访客在根路径看到的是官网（web/public/welcome/，09-09 起），登录墙挪到 /login。
      // nginx 已按 nd_auth cookie 在 / 分流；这里兜的是 cookie 还在但已失效的那种，
      // 走到 SPA 才知道没登录。别的路径（/login、/projects/…）照旧在原地显示墙。
      if (location.pathname === '/') { location.replace('/welcome/'); return; }
      setPhase('login');
    }
  };

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then(applyStatus)
      .catch(() => setPhase('login'));
  }, []);

  // 全局 401（api.js 派发）→ 回登录态。WS 4401 断连后接口一定跟着 401，同一条路收口
  useEffect(() => {
    const onUnauthorized = () => {
      useGlobalStore.getState().setAuthUser?.(null);
      setPhase((p) => (p === 'ok' ? 'login' : p));
    };
    window.addEventListener('nd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nd:unauthorized', onUnauthorized);
  }, []);

  // 墙按安全框 contain、顶边对齐：竖向富余留给底边，顶边永不裁
  useLayoutEffect(() => {
    if (phase !== 'login') return undefined;
    const fit = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setNarrow(w < NARROW_W);
      if (rootRef.current) {
        // 稿从顶栏下沿开始（09-12），竖向可用的是 h - NAV_H
        rootRef.current.style.setProperty('--s', String(Math.min(w / DESIGN_W, (h - NAV_H) / SAFE_H)));
      }
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phase]);
  // 墙轮着播：只在真正显示墙的时候转（窄屏只有登记卡，没有墙可换）
  const { scene, phase: scenePhase } = useSceneCarousel(SCENES, {
    enabled: phase === 'login' && !narrow,
    paperCount: STEPS,   // 每套 ①→⑥ 六步（09-12 印刷风）；不传的话按旧墙的 20 张算，进出场会等很久
  });

  async function submit(e) {
    e.preventDefault();
    if (busy || !username || !password) return;
    if (mode === 'register' && !inviteCode && !openReg) return;
    setBusy(true);
    setError('');
    if (desktop) {
      try {
        const res = await fetch('/api/local/relay/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, ...(siteUrl.trim() ? { url: siteUrl.trim() } : {}) }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) { if (!desktop.setupDone) { location.replace('/setup'); return; } setPhase('ok'); }
        else setError(data.error || t('登录失败 ({status})', { status: res.status }));
      } catch {
        setError(t('网络错误，请重试'));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register'
          ? { username, password, inviteCode }
          : { username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        useGlobalStore.getState().setAuthUser?.(data.user || null);
        setPhase('ok');
      } else {
        // t() 的 key 必须是字面量，lint 才看得见（见 i18n-catalog.lint.test.js）
        const fail = mode === 'register'
          ? t('注册失败 ({status})', { status: res.status })
          : t('登录失败 ({status})', { status: res.status });
        setError(data.error || fail);
      }
    } catch {
      setError(t('网络错误，请重试'));
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'ok') return children;
  if (phase === 'checking') return <div className="nd-shell" style={{ background: PAPER.wall }} />;

  const isRegister = mode === 'register';


  const form = desktop ? (
    <>
      <h2>{t('登录 NoDesign')}</h2>
      <div className="m">{t('使用站点账号登录后，本机即可使用站点提供的模型与额度')}</div>
      <div className="ndw-field">
        <label htmlFor="ndw-u">{t('用户名 · USERNAME')}</label>
        <input id="ndw-u" value={username} placeholder={t('请输入用户名')} autoFocus
          autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-p">{t('密码 · PASSWORD')}</label>
        <input id="ndw-p" type="password" value={password} placeholder={t('请输入密码')}
          autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
      </div>
      {showSite && (
        <div className="ndw-field">
          <label htmlFor="ndw-s">{t('站点地址 · SITE')}</label>
          <input id="ndw-s" value={siteUrl} placeholder={desktop.url || ''}
            onChange={(e) => setSiteUrl(e.target.value)} />
        </div>
      )}
      <p className="ndw-err">{error || (desktop.error ? t('连不上站点：{err}', { err: desktop.error }) : '')}</p>
      <button className="go" type="submit" disabled={busy}>
        {busy ? t('正在验证') : t('登录')}
      </button>
      <p className="foot">
        <a href={siteUrl.trim() || desktop.url || '#'} target="_blank" rel="noreferrer">{t('没有账号？前往站点注册')}</a>
        {' · '}
        <a href="#site" onClick={(e) => { e.preventDefault(); setShowSite((v) => !v); }}>{showSite ? t('用官方站') : t('换个站点')}</a>
      </p>
    </>
  ) : (
    <>
      <h2>{t('登录或注册')}</h2>
      <div className="m">{openReg ? t('开放注册') : t('内测阶段，仅限邀请')}</div>
      <div className="ndw-tabs">
        <button type="button" className={isRegister ? '' : 'on'}
          onClick={() => { setMode('login'); setError(''); }}>
          {t('登录')}
        </button>
        <button type="button" className={isRegister ? 'on' : ''}
          onClick={() => { setMode('register'); setError(''); }}>
          {t('注册')}
        </button>
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-u">{t('用户名 · USERNAME')}</label>
        <input id="ndw-u" value={username} placeholder={t('请输入用户名')} autoFocus
          autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="ndw-field">
        <label htmlFor="ndw-p">{t('密码 · PASSWORD')}</label>
        <input id="ndw-p" type="password" value={password}
          placeholder={isRegister ? t('设置密码，至少 8 位') : t('请输入密码')}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)} />
      </div>
      {/* 开放注册时不显示邀请码（09-08 站主：登录页别再挂邀请码字样）；后端仍收 inviteCode，关闭开放注册就回到受邀模式 */}
      {isRegister && !openReg && (
        <div className="ndw-field">
          <label htmlFor="ndw-i">{t('邀请码 · INVITE')}</label>
          <input id="ndw-i" value={inviteCode} placeholder="nd-xxxxxxxx"
            onChange={(e) => setInviteCode(e.target.value)} />
        </div>
      )}
      <p className="ndw-err">{error}</p>
      <button className="go" type="submit" disabled={busy}>
        {busy ? t('正在验证') : isRegister ? t('注册') : t('登录')}
      </button>
      <p className="foot">{openReg ? t('注册即可使用，免费模型对所有用户开放。') : t('当前仅接受邀请注册。')}</p>
      <div className="alt">
        <a href="https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe">{t('下载 Windows 桌面版')} →</a>
        <a href="/welcome/docs.html">{t('查看文档')} →</a>
      </div>
    </>
  );

  return (
    <div className={`ndw${narrow ? ' narrow' : ''}`} ref={rootRef}>
      <style>{WALL_CSS}</style>

      {/* 顶栏（09-12 印刷风）：不进 1500x800 那张设计稿（稿里的东西按 --s 缩放），横贯整个视口。
          语言切换器挂在这里 —— 门外必须能换语言，英文用户读不懂登录表单的话，站内做得再好也没机会被看到。 */}
      <header className="ndw-nav">
        <a className="brand" href="/welcome/"><img src={nMark} alt="" />Nodesign</a>
        <nav className="links">
          {!desktop && <a href="/welcome/">{t('官网')}</a>}
          {!desktop && <a href="/welcome/docs.html">{t('文档')}</a>}
          <LanguageSwitcher variant="wall" />
        </nav>
      </header>
      {!narrow && (
        <div className="ndw-proof" aria-hidden="true">
          <i className="tl" /><i className="tr" /><i className="bl" /><i className="br" />
          <div className="bar"><b /><b /><b /><b /></div>
          <div className="tag">PROOF · {new Date().getFullYear()}-{String(new Date().getMonth() + 1).padStart(2, '0')}</div>
        </div>
      )}
      {narrow ? (
        <form className="ndw-card ndw-solo" onSubmit={submit}>
          <span className="pin" />
          {form}
        </form>
      ) : (
        <div className="ndw-stage">
          {/* 跨场景不变的锚（一）：认得出这是哪儿 */}
          <div className="ndw-head">
            <span className="ndw-anno">{t('以画布为中心的 Agent 工作台')}</span>
            {/* 标题一个整句（2026-08-28 起不再拿几段 t() 拼一句：拼句在英文下是词序赌博） */}
            <h1>{t('与 Agent 共用一块画布')}</h1>
            <p className="ndw-sub">{t('产物、素材与推理过程集中在同一块画布上。你在画布上圈选、整理与修改，Agent 在画布上制作、检查与说明。')}</p>
          </div>

          {/* 会换的那一半：一套构图 = 一个场景文件 */}
          <Scene scene={scene} phase={scenePhase} />

          {/* 跨场景不变的锚（二）：线索的终点，门 */}
          <form className="ndw-card" onSubmit={submit}>
            <span className="pin" />
            <div className="ndw-stamp">{desktop ? t('桌面版') : t('公开测试')}</div>
            {form}
          </form>
        </div>
      )}
    </div>
  );
}
