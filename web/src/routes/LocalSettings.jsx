// web/src/routes/LocalSettings.jsx — 本地分发版设置页（/settings，08-22）。
//
// 四块：状态（数据目录 / 版本 / 重启）、模型（「Claude 官方」与「自定义接入」两张并列的卡）、本机能力（一张表）、其他钥匙与开关（.env 白名单）。
// 全部数据来自 /api/local/*（只在 NODESIGN_PROFILE=local 下存在）；hosted 下进来只会看到空态说明。
import { useState, useEffect, useCallback } from 'react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Section, Card, Btn, Err, Dot } from '../components/local/primitives.jsx';
import CapabilityTable from '../components/local/CapabilityTable.jsx';
import EnvKeys from '../components/local/EnvKeys.jsx';
import SlotEditor from '../components/local/SlotEditor.jsx';
import { t } from '../lib/i18n.js';

export default function LocalSettings() {
  const showToast = useGlobalStore((s) => s.showToast);
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);          // { raw, errors, enums, activeExternalModels, path }
  const [draft, setDraft] = useState(null);      // 正在编辑的 raw
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const reload = useCallback(() => {
    Promise.all([Local.status(), Local.config()])
      .then(([s, c]) => { setStatus(s); setCfg(c); setDraft(c.raw); setLoadErr(''); })
      .catch((e) => setLoadErr(e.message));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await Local.saveConfig(draft);
      setCfg((c) => ({ ...c, errors: r.errors, raw: draft, exists: true }));
      setNeedsRestart(true);
      showToast(r.errors.length ? t('已保存，但有 {n} 处问题（见红字），对应行不会生效', { n: r.errors.length }) : t('已保存，重启后生效'), r.errors.length ? 'warn' : 'info');
    } catch (e) { showToast(t('保存失败：{err}', { err: e.message }), 'error'); } finally { setSaving(false); }
  };

  const restart = async () => {
    setRestarting(true);
    try { await Local.restart(); } catch { /* 进程正在退，请求可能断 */ }
    // 轮询 health 直到新进程起来再刷新
    const deadline = Date.now() + 30_000;
    const tick = async () => {
      try {
        const r = await fetch('/api/local/status');
        if (r.ok) { const s = await r.json(); if (s.pid !== status?.pid) { window.location.reload(); return; } }
      } catch { /* 还没起来 */ }
      if (Date.now() < deadline) setTimeout(tick, 700); else { setRestarting(false); showToast(t('重启超时，手动刷新看看'), 'error'); }
    };
    setTimeout(tick, 1200);
  };

  const crumbs = [{ label: t('设置') }];

  if (loadErr) {
    return (
      <AppShell breadcrumb={crumbs}>
        <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: FONT_SANS, color: COLOR.text3 }}>
          <Err>{loadErr}</Err>
          <p style={{ fontSize: FONT_SIZE.sm }}>{t('这一页只在本地分发版（NODESIGN_PROFILE=local）可用；线上多用户站没有 /api/local。')}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumb={crumbs} actions={
      <Btn onClick={restart} disabled={restarting || !status}>{restarting ? t('重启中…') : t('重启')}</Btn>
    }>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.xl}px ${GAP.xl}px 80px` }}>
        <Section title={t('状态')}>
          <Card>
            {!status ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span> : (
              <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, display: 'grid', gridTemplateColumns: '120px 1fr', gap: `${GAP.xs}px ${GAP.lg}px` }}>
                <span>{t('版本')}</span><span style={{ fontFamily: FONT_MONO }}>nodesign {status.version} · pid {status.pid}</span>
                <span>{t('数据目录')}</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.dataRoot}</span>
                <span>{t('配置文件')}</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.configPath}</span>
                <span>{t('插槽问题')}</span><span>{status.modelConfigErrors?.length ? status.modelConfigErrors.map((e, i) => <div key={i} style={{ color: COLOR.error }}>{e.where}: {e.message}</div>) : t('无')}</span>
              </div>
            )}
          </Card>
        </Section>

        <Section title={t('模型')} desc={t('两种接入方式并列，配好任一种，模型选择器里就有可选项')}>
          <Card style={{ marginBottom: GAP.md }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.sm }}>
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{t('Claude 官方')}</span>
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('Anthropic 的 Sonnet / Opus。填 API Key，或在终端 claude login 用订阅')}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: status?.claudeAuth ? COLOR.success : COLOR.sub }}>
                <Dot ok={status?.claudeAuth ? true : false} />
                {status?.claudeAuth === 'api_key' ? t('已配（API Key）') : status?.claudeAuth === 'login' ? t('已配（本机 claude login 登录态）') : t('未配')}
              </span>
            </div>
            <EnvKeys only={[t('模型')]} bare showToast={showToast} onSaved={() => Local.status().then(setStatus).catch(() => {})}
              onCapabilities={(caps) => setStatus((s) => (s ? { ...s, capabilities: caps.map((c) => ({ ...c, tools: s.capabilities.find((x) => x.id === c.id)?.tools || [] })) } : s))} />
          </Card>
          <Card>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.md }}>
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{t('自定义接入')}</span>
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('任何服务商：DeepSeek、OpenAI、智谱、通义、OpenRouter、中转站、本机 Ollama…（OpenAI 格式或 Anthropic 格式都行）')}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: cfg?.activeExternalModels?.length ? COLOR.success : COLOR.sub }}>
                <Dot ok={cfg?.activeExternalModels?.length ? true : false} />
                {cfg?.activeExternalModels?.length ? t('已配 {n} 个模型', { n: cfg.activeExternalModels.length, count: cfg.activeExternalModels.length }) : t('未配')}
              </span>
            </div>
            {cfg && draft ? (
              <SlotEditor config={draft} setConfig={setDraft} errors={cfg.errors} enums={cfg.enums} active={cfg.activeExternalModels}
                needsRestart={needsRestart} onSave={save} saving={saving} showToast={showToast} />
            ) : <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span>}
          </Card>
        </Section>

        <Section title={t('本机能力')} desc={t('启动时探的；装好东西后「重启」重探')}>
          <CapabilityTable capabilities={status?.capabilities} />
        </Section>

        <Section title={t('其他钥匙与开关')} desc={t('写进 {path}/.env，钥匙类保存即生效', { path: status?.dataRoot || '~/.nodesign' })}>
          <EnvKeys exclude={[t('模型')]} showToast={showToast} onCapabilities={(caps) => setStatus((s) => (s ? { ...s, capabilities: caps.map((c) => ({ ...c, tools: s.capabilities.find((x) => x.id === c.id)?.tools || [] })) } : s))} />
        </Section>
      </div>
    </AppShell>
  );
}
