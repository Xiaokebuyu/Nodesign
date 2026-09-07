// web/src/routes/Settings.jsx — 设置（09-07 二次重做：按 C 端 SaaS 的信息结构与样式打磨）
//
//   账户   头像 / 用户名 / 档位 / 今日额度 / 这台设备 / 退出         hosted 也有
//   用量   近 30 天摘要 + 每日曲线                                  hosted 也有
//   外观   语言 / 字体 / 缩放                                        hosted 也有
//   模型   清单：默认（单选）+ 是否显示（开关）；「自己的 API Key」折叠   本地版
//   组件   外部程序：装 / 卸 / 进度。能力表 09-07 下架（站主：装完就够了）   本地版
//   关于   版本 / 检查更新 / 数据目录 / 重启；「开发者选项」折叠（钥匙、插槽问题）  本地版
//
// 零件在 components/settings/ui.jsx；各块在 components/settings/*Section.jsx。
import { useState, useEffect, useCallback } from 'react';
import { User, BarChart3, Palette, Cpu, Package, Info } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_KAI, RADIUS } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { t } from '../lib/i18n.js';
import { LocalAccount, HostedAccount } from '../components/settings/AccountSection.jsx';
import UsageSection from '../components/settings/UsageSection.jsx';
import AppearanceSection from '../components/settings/AppearanceSection.jsx';
import ModelsSection from '../components/settings/ModelsSection.jsx';
import ComponentsSection from '../components/settings/ComponentsSection.jsx';
import AboutSection from '../components/settings/AboutSection.jsx';

const SECTIONS = [
  { id: 'account', label: '账户', desc: '你的站点账号、档位和这台设备', Icon: User, local: true, hosted: true },
  { id: 'usage', label: '用量', desc: '近 30 天花了多少、花在哪个模型上', Icon: BarChart3, local: true, hosted: true },
  { id: 'appearance', label: '外观', desc: '语言、字体和界面缩放，改了立刻生效', Icon: Palette, local: true, hosted: true },
  { id: 'models', label: '模型', desc: '新会话默认用哪个、选择器里列哪些', Icon: Cpu, local: true, hosted: false },
  { id: 'components', label: '组件', desc: '截图、导出、抠图这些功能要用到的外部程序', Icon: Package, local: true, hosted: false },
  { id: 'about', label: '关于', desc: '版本、更新、数据存放位置', Icon: Info, local: true, hosted: false },
];
// 旧链接 #advanced 仍指到关于页（重启 / 钥匙都在那里的「开发者选项」）
const ALIAS = { advanced: 'about' };

export default function Settings() {
  const showToast = useGlobalStore((s) => s.showToast);
  const isLocal = useGlobalStore((s) => s.authProfile) === 'local';
  const authUser = useGlobalStore((s) => s.authUser);
  const [section, setSection] = useState(() => { const h = (typeof location !== 'undefined' && location.hash.slice(1)) || 'account'; return ALIAS[h] || h; });
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [usage, setUsage] = useState(null);   // hosted：/api/me/usage（档位 / 额度）

  const reload = useCallback(() => {
    if (!isLocal) { fetch('/api/me/usage').then((r) => (r.ok ? r.json() : null)).then(setUsage).catch(() => {}); return; }
    Promise.all([Local.status(), Local.config()])
      .then(([s, c]) => { setStatus(s); setCfg(c); setDraft(c.raw); })
      .catch((e) => showToast?.(e.message, 'error'));
  }, [isLocal, showToast]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { try { history.replaceState(null, '', `#${section}`); } catch { /* */ } }, [section]);
  // 别处链接过来（选择器里的「设置」指 #account、组件页指 #components）：同页只改 hash 不重载，得听着
  useEffect(() => {
    const onHash = () => { const h = ALIAS[location.hash.slice(1)] || location.hash.slice(1); if (SECTIONS.some((s) => s.id === h)) setSection(h); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await Local.saveConfig(draft);
      setCfg((c) => ({ ...c, errors: r.errors, raw: draft, exists: true }));
      setNeedsRestart(true);
      showToast?.(r.errors.length ? t('已保存，但有 {n} 处问题（见红字），对应行不会生效', { n: r.errors.length }) : t('已保存，重启后生效'), r.errors.length ? 'warn' : 'info');
    } catch (e) { showToast?.(t('保存失败：{err}', { err: e.message }), 'error'); } finally { setSaving(false); }
  };

  const restart = async () => {
    setRestarting(true);
    try { await Local.restart(); } catch { /* 进程正在退，请求可能断 */ }
    const deadline = Date.now() + 30_000;
    const tick = async () => {
      try {
        const r = await fetch('/api/local/status');
        if (r.ok) { const s = await r.json(); if (s.pid !== status?.pid) { window.location.reload(); return; } }
      } catch { /* 还没起来 */ }
      if (Date.now() < deadline) setTimeout(tick, 700); else { setRestarting(false); showToast?.(t('重启超时，手动刷新看看'), 'error'); }
    };
    setTimeout(tick, 1200);
  };

  const patchStatus = (patch) => setStatus((s) => (s ? { ...s, ...patch } : s));
  const onRelayChange = (r) => { if (r?.relay) patchStatus({ relay: r.relay }); reload(); };

  const visible = SECTIONS.filter((s) => (isLocal ? s.local : s.hosted));
  const cur = visible.find((s) => s.id === section) || visible[0];
  const crumbs = [{ label: t('设置') }];   // 字标本身就是「Nodesign」那一级，别重复

  return (
    <AppShell breadcrumb={crumbs}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: `${GAP.page}px ${GAP.xxl}px 96px`, display: 'grid', gridTemplateColumns: '188px minmax(0, 1fr)', gap: GAP.page }}>
        <nav aria-label={t('设置')} style={{ position: 'sticky', top: 24, alignSelf: 'start', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.map(({ id, label, Icon }) => {
            const on = cur.id === id;
            return (
              <button key={id} onClick={() => setSection(id)} aria-current={on ? 'page' : undefined} style={{
                display: 'flex', alignItems: 'center', gap: GAP.base, textAlign: 'left',
                padding: `${GAP.md}px ${GAP.lg}px`, borderRadius: RADIUS.md, border: 0, cursor: 'pointer',
                fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg,
                background: on ? 'rgba(43,33,23,0.08)' : 'transparent', color: on ? COLOR.text : COLOR.text4,
              }}>
                <Icon size={15} strokeWidth={1.8} style={{ flexShrink: 0, opacity: on ? 1 : 0.75 }} />
                {t(label)}
              </button>
            );
          })}
        </nav>
        <div style={{ minWidth: 0 }}>
          <header style={{ marginBottom: GAP.xxl }}>
            <h1 style={{ margin: 0, fontFamily: FONT_KAI, fontSize: 22, fontWeight: 600, color: COLOR.text }}>{t(cur.label)}</h1>
            <p style={{ margin: `${GAP.xs}px 0 0`, fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: COLOR.text4 }}>{t(cur.desc)}</p>
          </header>
          {cur.id === 'account' && (isLocal
            ? <LocalAccount relay={status?.relay} onChange={onRelayChange} showToast={showToast} />
            : <HostedAccount authUser={authUser} usage={usage} />)}
          {cur.id === 'usage' && <UsageSection isLocal={isLocal} />}
          {cur.id === 'appearance' && <AppearanceSection />}
          {cur.id === 'models' && isLocal && (
            <ModelsSection status={status} cfg={cfg} draft={draft} setDraft={setDraft} save={save} saving={saving} needsRestart={needsRestart}
              onStatus={() => Local.status().then(setStatus).catch(() => {})} showToast={showToast} />
          )}
          {cur.id === 'components' && isLocal && <ComponentsSection status={status} onStatus={patchStatus} />}
          {cur.id === 'about' && isLocal && (
            <AboutSection status={status} onStatus={patchStatus} restart={restart} restarting={restarting} showToast={showToast} />
          )}
        </div>
      </div>
    </AppShell>
  );
}
