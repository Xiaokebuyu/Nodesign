/**
 * AuthGate — 登录墙（2026-07-30 多用户版；2026-08-03 线索墙改版；2026-08-17 拆场景 + 定格轮播）
 *
 * 挂载时查 /api/auth/status：
 *   - required=false（dev 模式）或已有有效身份 → 渲染 app，并把 user 挂到
 *     globalStore（顶栏显示用户名 / 登出、admin 判定都从那读）
 *   - 否则渲染登录页：网页版的登记卡是 login-wall/AuthCard.jsx（邮箱 / 用户名 / Google / GitHub，09-13 auth-v2），
 *     桌面版首启门是 login-wall/DesktopLoginCard.jsx（在浏览器中登录 + 账号密码，09-13 第四批）
 *
 * 全局 401：api.js jsonRequest 收到 401 时派发 `nd:unauthorized` window 事件，
 * 这里监听 → 回登录态（解决 cookie 过期后散落报错、WS 4401 停止重连后卡死）。
 * 桌面版没有 401 这条路（本机接口恒放行）：站点吊销了设备令牌，本地服务端清掉令牌，这里每分钟和回到窗口时
 * 查一次 /api/auth/status，发现 loggedIn 变 false 就回登录门。
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
import { runTurnstileProbe } from '../lib/turnstile-probe.js';
import AuthCard from './login-wall/AuthCard.jsx';
import DesktopLoginCard from './login-wall/DesktopLoginCard.jsx';

export default function AuthGate({ children }) {
  // checking | login | ok
  const [phase, setPhase] = useState('checking');
  const [openReg, setOpenReg] = useState(false);   // 服务端 /api/auth/status 的 openRegistration：没邀请码也能开号（08-21）
  const [narrow, setNarrow] = useState(false);
  // 本地分发版（桌面版 / npx）的首启门：站点账号没登录就先登录（DesktopLoginCard），本地服务端去站点换
  // 设备令牌，从此这台机器走站点的模型和额度。
  const [desktop, setDesktop] = useState(null);   // /api/auth/status 的 desktop 字段（只有 local 档位有）
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

  const loadStatus = () => fetch('/api/auth/status')
    .then((r) => r.json())
    .then(applyStatus)
    .catch(() => setPhase('login'));

  useEffect(() => { loadStatus(); }, []);

  // 桌面版：登录状态可能在这个页面之外变（fable 09-13 审查中-1），定时和回到窗口时看一眼：
  //   在应用里 → 令牌被站点判失效、本地服务端清掉了（server/api/local-relay-login.js）→ 回登录门
  //   在登录门 → 另一次浏览器登录已经落了令牌（刷新前发起的那次、取消晚了一步、另一个窗口）→ 进应用
  const isDesktop = !!desktop;
  useEffect(() => {
    if (!isDesktop || (phase !== 'ok' && phase !== 'login')) return undefined;
    const check = () => fetch('/api/auth/status').then((r) => r.json()).then((s) => {
      if (s.profile !== 'local' || !s.desktop) return;
      if (phase === 'ok' && !s.desktop.loggedIn) { setDesktop(s.desktop); setPhase('login'); }
      if (phase === 'login' && s.desktop.loggedIn) applyStatus(s);
    }).catch(() => {});
    const id = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => { clearInterval(id); window.removeEventListener('focus', check); };
  }, [isDesktop, phase]);

  // Turnstile 测量期（09-13「先量后定」）：网页登录墙亮出来时静默量一次，不拦人；服务端没配 site key 时什么都不做
  useEffect(() => {
    if (phase === 'login' && !desktop) runTurnstileProbe('login');
  }, [phase, desktop]);

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

  // 网页登录卡（AuthCard）登录 / 注册成功后回调
  const authed = (user) => {
    useGlobalStore.getState().setAuthUser?.(user || null);
    setPhase('ok');
  };

  if (phase === 'ok') return children;
  if (phase === 'checking') return <div className="nd-shell" style={{ background: PAPER.wall }} />;


  return (
    <div className={`ndw${narrow ? ' narrow' : ''}`} ref={rootRef}>
      <style>{WALL_CSS}</style>

      {/* 顶栏（09-12 印刷风）：不进 1500x800 那张设计稿（稿里的东西按 --s 缩放），横贯整个视口。
          语言切换器挂在这里 —— 门外必须能换语言，英文用户读不懂登录表单的话，站内做得再好也没机会被看到。 */}
      <header className="ndw-nav">
        {/* 桌面版里字标不做链接：桌面窗口里点一个裸 <a> 是顶层导航，会把整个应用换成官网静态页 */}
        {desktop
          ? <span className="brand"><img src={nMark} alt="" />Nodesign</span>
          : <a className="brand" href="/welcome/"><img src={nMark} alt="" />Nodesign</a>}
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
        desktop ? (
          <DesktopLoginCard className="ndw-card ndw-solo" desktop={desktop} onDone={loadStatus}>
            <span className="pin" />
          </DesktopLoginCard>
        ) : (
          <AuthCard className="ndw-card ndw-solo" openReg={openReg} onAuthed={authed}>
            <span className="pin" />
          </AuthCard>
        )
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
          {desktop ? (
            <DesktopLoginCard className="ndw-card" desktop={desktop} onDone={loadStatus}>
              <span className="pin" />
              <div className="ndw-stamp">{t('桌面版')}</div>
            </DesktopLoginCard>
          ) : (
            <AuthCard className="ndw-card" openReg={openReg} onAuthed={authed}>
              <span className="pin" />
              <div className="ndw-stamp">{t('公开测试')}</div>
            </AuthCard>
          )}
        </div>
      )}
    </div>
  );
}
