import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, LayoutDashboard, Settings, Monitor } from 'lucide-react';
import { COLOR, CHROME, GAP, RADIUS, SHADOW, FONT_SIZE, FONT_MONO, FONT_KAI } from '../../lib/theme.js';
import { GRAIN } from '../../lib/paper.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { useMedia, NARROW } from '../../lib/use-media.js';

/**
 * 用户角标（2026-07-30 多用户内测；07-30 晚收成头像）
 *
 * 原来是「用户名 + 今日用量 + ⚠ + 登出」四件横排，顶栏本来就挤。收成一个头像点开菜单。
 *
 * 但**用量警告不能一起收进去**：内测有日限额，撞上了是硬失败（429 + 白话 toast），
 * 收进 popover 等于毫无预警。所以头像平时安静，接近限额时加一圈警告色描边——
 * 常驻的只剩"要不要紧"这一个比特，细节点开看。
 *
 * 轮询也因此不能改成"打开才拉"（那样描边永远不会亮），只是从 90s 放慢到 5 分钟。
 */
/** 本地分发版：账号徽记的位置换成设置入口（钥匙 / 模型插槽 / 本机能力） */
function LocalSettingsEntry() {
  return (
    <Link to="/settings" title="设置：钥匙 · 模型插槽 · 本机能力" style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
      borderRadius: RADIUS.pill, color: CHROME.ink2, textDecoration: 'none',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    ><Settings size={16} /></Link>
  );
}

function UserBadge() {
  const authUser = useGlobalStore(s => s.authUser);
  const local = useGlobalStore(s => s.authProfile === 'local');   // 本地分发版：没有账号这回事，整块不渲染
  const [usage, setUsage] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!authUser || local) return undefined;
    let dead = false;
    const pull = () => {
      fetch('/api/me/usage').then(r => (r.ok ? r.json() : null))
        .then(u => { if (!dead && u) setUsage(u); })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 300_000);
    return () => { dead = true; clearInterval(t); };
  }, [authUser]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (local) return <LocalSettingsEntry />;
  if (!authUser) return null;
  // 警戒线 75%：跟配额横幅第一档对齐。07-31 起额度是一个总数且单位是钱，
  // 服务端直接给 pct（金额不下发给普通用户，见 api/me.js）
  const pct = usage?.capped ? (usage.pct || 0) : 0;
  const nearCap = pct >= 75;
  const initial = (authUser.username || '?').trim().slice(0, 1).toUpperCase();
  // 档位标识（08-21，/api/me/usage.tier）：pro/admin 头像右下角一个朱砂点（盖过章的语法，不用金环——
  // 纸+暖墨的版面里金色是唯一会发光的东西）；basic 无点，hover 给一句解锁提示当转化入口。
  const tier = usage?.tier || null;
  const sealed = tier === 'pro' || tier === 'admin';
  const title = tier === 'basic'
    ? `${authUser.username} · basic 档 —— Claude 与站点发布仅限 Pro 档，暂未对外开放`
    : authUser.username;

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        title={title}
        style={{
          position: 'relative',
          width: 26, height: 26, borderRadius: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, fontWeight: 700,
          color: CHROME.ink2,
          background: 'rgba(43,33,23,0.06)',
          border: nearCap ? `1.5px solid ${COLOR.warn}` : '1.5px solid transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {initial}
        {sealed && (
          <span aria-label={tier} style={{
            position: 'absolute', right: -1, bottom: -1,
            width: 7, height: 7, borderRadius: 4,
            background: COLOR.error,                 // = PAPER.red（朱砂）
            boxShadow: `0 0 0 1.5px ${CHROME.bg}`,  // 跟底色隔一丝白，不是描边
          }} />
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: GAP.sm,
          minWidth: 176,
          background: CHROME.bg,
          backgroundImage: GRAIN,
          border: `1px solid ${CHROME.border}`,
          borderRadius: RADIUS.xl,
          boxShadow: SHADOW.menu,
          padding: GAP.xs,
          zIndex: 60,
        }}>
          <div style={{
            padding: `${GAP.sm}px ${GAP.md}px`,
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: CHROME.ink,
          }}>
            {authUser.username}
            {sealed && (
              <span style={{ marginLeft: 6, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.error, letterSpacing: 0.5 }}>
                {tier}
              </span>
            )}
            {usage && (
              <div style={{
                marginTop: 3, fontSize: FONT_SIZE.xs,
                color: pct >= 90 ? COLOR.error : nearCap ? COLOR.warn : COLOR.sub,
              }}>
                {usage.capped
                  ? `${usage.kind === 'lifetime' ? '试用' : '今日'} $${(usage.used ?? usage.usedToday ?? 0).toFixed(2)} / $${(usage.limit || 0).toFixed(2)} · ${Math.round(pct)}%`
                  : `今日 $${(usage.usedToday || 0).toFixed(2)} · 不限额`}
              </div>
            )}
          </div>
          <div style={{ height: 1, background: CHROME.border, margin: `${GAP.xs}px 0` }} />
          {authUser.role === 'admin' && (
            <Link to="/admin" onClick={() => setOpen(false)} style={menuItem}>
              <LayoutDashboard size={12} /> 控制台
            </Link>
          )}
          <Link to="/devices" onClick={() => setOpen(false)} style={menuItem}>
            <Monitor size={12} /> 桌面版设备
          </Link>
          <button
            onClick={async () => {
              try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* */ }
              window.location.reload();
            }}
            style={{ ...menuItem, width: '100%', border: 0, background: 'transparent', cursor: 'pointer' }}
          ><LogOut size={12} /> 登出</button>
        </div>
      )}
    </div>
  );
}

const menuItem = {
  display: 'flex', alignItems: 'center', gap: GAP.sm,
  padding: `${GAP.sm}px ${GAP.md}px`,
  fontFamily: FONT_KAI, fontSize: FONT_SIZE.base,
  color: CHROME.ink2, textDecoration: 'none',
  borderRadius: RADIUS.md,
  textAlign: 'left',
};

/**
 * TopBar — 顶栏（h: 56px）
 *
 * @param {object} props
 * @param {Array<{label, to?}>} [props.breadcrumb]  - 面包屑 [{label:'Nodesign', to:'/'}, {label:'项目名'}]
 * @param {ReactNode} [props.actions]               - 右侧操作区（按钮组）
 *
 * 注：原来还有个 status 药丸（运行中 / 上次失败 / 就绪），全仓没有任何路由传过它，
 * 2026-07-30 删掉。agent 在不在跑由聊天流尾部的占位行说，那儿才是用户看着的地方。
 */
/**
 * 面包屑单级。三种形态：
 *   to        路由跳转（Link）
 *   onClick   同页动作（比如画布从工作区退回项目区）
 *   都没有    当前位置，纯文本
 * 前两种带 hover 底色 + 手型，明确"这里可以按"。
 */
function Crumb({ item, last, maxW = 280 }) {
  const interactive = !!(item.to || item.onClick);
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: `3px ${GAP.md}px`,
    borderRadius: RADIUS.md,
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit', fontSize: 'inherit',
    color: interactive ? CHROME.ink2 : CHROME.ink,
    fontWeight: interactive ? 400 : 700,
    textDecoration: 'none',
    cursor: interactive ? 'pointer' : 'default',
    maxWidth: maxW,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    transition: 'background 0.15s, color 0.15s',
  };
  const hoverOn = (e) => {
    if (!interactive) return;
    e.currentTarget.style.background = CHROME.hover;
    e.currentTarget.style.color = CHROME.ink;
  };
  const hoverOff = (e) => {
    if (!interactive) return;
    e.currentTarget.style.background = 'transparent';
    e.currentTarget.style.color = CHROME.ink2;
  };
  const inner = (
    <>
      {item.icon}
      {item.label}
      {item.hint && <span style={{ color: CHROME.pencil, fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm }}>{item.hint}</span>}
    </>
  );
  if (item.to) {
    return (
      <Link to={item.to} title={item.title} style={base} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>{inner}</Link>
    );
  }
  if (item.onClick) {
    return (
      <button onClick={item.onClick} title={item.title} style={base} onMouseEnter={hoverOn} onMouseLeave={hoverOff}>{inner}</button>
    );
  }
  return <span title={item.title} style={{ ...base, ...(last ? {} : {}) }}>{inner}</span>;
}

/**
 * 顶栏右边那排动作的样式。Home 和 Showcase 各写过一份一模一样的，
 * 08-30 Skill 页也要用，第三份之前收成一份。
 * （ProjectWorkspace / FilesCard / InstructionsCard 里那几个同名常量是别的语境，不动。）
 */
export const TOP_ACTION_STYLE = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontSize: FONT_SIZE.lg, color: CHROME.ink2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: RADIUS.lg,
  background: 'transparent',
  textDecoration: 'none',
};

export default function TopBar({ breadcrumb = [], actions }) {
  /**
   * 窄屏收紧（2026-08-21）。顶栏全是内联样式 —— media query 够不着它，
   * 手机上照着 1440 的 padding/gap 排，「新建项目」会被挤成两行还切掉半截。
   */
  const narrow = useMedia(NARROW);
  return (
    <header data-top-bar style={{
      height: 56,
      flexShrink: 0,
      // 顶栏是纸不是白条：底色跟页面同族，下边界是墨色淡痕 + 一道极浅的落影，
      // 读起来像压在板子上的一条搁板，而不是贴上去的胶带
      background: CHROME.bg,
      backgroundImage: GRAIN,
      borderBottom: `1px solid ${CHROME.border}`,
      display: 'flex',
      alignItems: 'center',
      padding: `0 ${narrow ? 12 : GAP.xl}px`,
      gap: narrow ? 8 : GAP.lg,
      // 窄屏：一行排不下让各自缩，**不许折行** —— 折了就把 56px 的条撑爆（手机上真见过）。
      // 桌面本来就不会折，不加这条，免得动到已经好好的东西。
      // ⛔ 这里**绝对不能加 overflow: hidden**：顶栏上所有下拉（头像菜单、导出、⋯）
      //    都是绝对定位挂在这条 header 里的，一裁就整条看不见 —— 08-21 加过一次，
      //    手机上表现为"点了没反应"。宽度靠 nowrap + 各自 flexShrink 兜，量过 320/393 都不溢出。
      ...(narrow ? { whiteSpace: 'nowrap' } : null),
      boxShadow: '0 1px 4px rgba(93,74,44,0.10)',
      position: 'relative',
      zIndex: 3,
    }}>
      {/* Logo —— 跟登录墙上那个字标同一套写法（楷体 700 + 0.06em），
          原来的深色 N 方块撤掉：门口那面墙上没有它，进门之后也不该冒出来 */}
      <Link to="/" style={{
        display: 'flex',
        alignItems: 'center',
        fontFamily: FONT_KAI,
        fontSize: narrow ? 17 : 19,
        fontWeight: 700,
        ...(narrow ? { flexShrink: 0 } : null),
        color: CHROME.ink,
        letterSpacing: '0.06em',
      }}>
        Nodesign
      </Link>

      {/* Breadcrumb —— 可点的一级做成 hover 高亮的小块，一眼看出能按 */}
      {breadcrumb.length > 0 && (
        <>
          <span style={{ color: CHROME.pencil, fontSize: FONT_SIZE.lg, flexShrink: 0 }}>/</span>
          {/*
            ⚠️ 面包屑是这条上**唯一能缩的东西**：字标和动作区都写着 flexShrink: 0，
            而中间那根撑杆是 flex:1（basis 0，本来就没有可缩的量）。所以只要动作区
            比放得下的宽一点点，超出的部分**全部**由面包屑独自承担 —— 08-31 在
            360 的屏上量到 /skills 和 /gallery 的面包屑被压到 **16px**（「Skill」
            只剩一个残字），而条本身还是溢出 76px。
            真正的修法在动作区那边（窄屏一律只留图标，见各路由），这儿只做两件事：
            分隔线不参与压缩、窄屏把上限从 120 放宽到 160（腾出来的地方给它）。
          */}
          <nav style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: CHROME.ink2, minWidth: 0 }}>
            {breadcrumb.map((item, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.sm, minWidth: 0 }}>
                {i > 0 && <span style={{ color: COLOR.dim }}>/</span>}
                <Crumb item={item} last={i === breadcrumb.length - 1} maxW={narrow ? 160 : 280} />
              </span>
            ))}
          </nav>
        </>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Actions */}
      {/* 字体挂在容器上：各路由自己拼 actions，逐个去改必然漏一个。
          按钮只要不显式指定 fontFamily 就跟着顶栏走 */}
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? 6 : GAP.md, fontFamily: FONT_KAI, ...(narrow ? { flexShrink: 0 } : null) }}>{actions}</div>}

      {/* 用户角标（用户名 · 今日用量 · 登出）*/}
      <UserBadge />
    </header>
  );
}
