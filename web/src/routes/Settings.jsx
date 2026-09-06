// web/src/routes/Settings.jsx — 设置（09-06 重做：按普通用户的心智分六块，左侧导航）
//
//   账户   站点账号 / 档位 / 额度 / 设备 / 退出         hosted 也有
//   用量   近 30 天花费曲线                             hosted 也有
//   外观   语言 / 字体 / 缩放                           hosted 也有
//   模型   清单 + 开关 + 默认；"用自己的 API Key"折叠      本地版
//   组件   本机外部程序的状态与安装                       本地版
//   高级   路径 / 其他钥匙与开关 / 重启                   本地版
//
// 旧的 LocalSettings 是给开发者看的一整页；它的零件（EnvKeys / SlotEditor / CapabilityTable）都留着，
// 只是收进了对应的块里。
import { useState, useEffect, useCallback } from 'react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_KAI, RADIUS } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { t } from '../lib/i18n.js';
import { LocalAccount, HostedAccount } from '../components/settings/AccountSection.jsx';
import UsageSection from '../components/settings/UsageSection.jsx';
import AppearanceSection from '../components/settings/AppearanceSection.jsx';
import ModelsSection from '../components/settings/ModelsSection.jsx';
import ComponentsSection from '../components/settings/ComponentsSection.jsx';
import AdvancedSection from '../components/settings/AdvancedSection.jsx';

const SECTIONS = [
  { id: 'account', label: '账户', local: true, hosted: true },
  { id: 'usage', label: '用量', local: true, hosted: true },
  { id: 'appearance', label: '外观', local: true, hosted: true },
  { id: 'models', label: '模型', local: true, hosted: false },
  { id: 'components', label: '组件', local: true, hosted: false },
  { id: 'advanced', label: '高级', local: true, hosted: false },
];

export default function Settings() {
  const showToast = useGlobalStore((s) => s.showToast);
  const isLocal = useGlobalStore((s) => s.authProfile) === 'local';
  const authUser = useGlobalStore((s) => s.authUser);
  const [section, setSection] = useState(() => (typeof location !== 'undefined' && location.hash.slice(1)) || 'account');
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
    const onHash = () => { const h = location.hash.slice(1); if (SECTIONS.some((s) => s.id === h)) setSection(h); };
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
  const crumbs = [{ label: 'Nodesign', to: '/' }, { label: t('设置') }];

  return (
    <AppShell breadcrumb={crumbs}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: `${GAP.xl}px ${GAP.xl}px 80px`, display: 'grid', gridTemplateColumns: '160px 1fr', gap: GAP.xl }}>
        <nav style={{ position: 'sticky', top: 16, alignSelf: 'start', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.map((s) => (
            <button key={s.id} onClick={() => setSection(s.id)} style={{
              textAlign: 'left', padding: `${GAP.sm}px ${GAP.md}px`, borderRadius: RADIUS.md, border: 0, cursor: 'pointer',
              fontFamily: FONT_KAI, fontSize: FONT_SIZE.md,
              background: section === s.id ? 'rgba(43,33,23,0.07)' : 'transparent', color: section === s.id ? COLOR.text : COLOR.text3,
            }}>{t(s.label)}</button>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: `0 0 ${GAP.md}px`, fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{t(visible.find((s) => s.id === section)?.label || '账户')}</h2>
          {section === 'account' && (isLocal
            ? <LocalAccount relay={status?.relay} onChange={onRelayChange} showToast={showToast} />
            : <HostedAccount authUser={authUser} usage={usage} />)}
          {section === 'usage' && <UsageSection isLocal={isLocal} />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'models' && isLocal && (
            <ModelsSection status={status} cfg={cfg} draft={draft} setDraft={setDraft} save={save} saving={saving} needsRestart={needsRestart}
              onStatus={() => Local.status().then(setStatus).catch(() => {})} showToast={showToast} />
          )}
          {section === 'components' && isLocal && <ComponentsSection status={status} />}
          {section === 'advanced' && isLocal && (
            <AdvancedSection status={status} onStatus={patchStatus} restart={restart} restarting={restarting} showToast={showToast} />
          )}
          {!isLocal && section !== 'account' && section !== 'usage' && section !== 'appearance' && (
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>{t('线上多用户站没有这一块。')}</div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
