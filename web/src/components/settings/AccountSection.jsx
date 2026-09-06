// 设置 → 账户：本地版 = 站点账号（登录 / 档位 / 额度 / 设备 / 退出）；hosted = 当前账号 + 设备页 + 登出
import { useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Card, Btn, Err, Dot, TextInput, Hint } from '../local/primitives.jsx';
import { t } from '../../lib/i18n.js';

const Row = ({ k, v }) => [
  <span key={k + 'k'} style={{ color: COLOR.sub }}>{k}</span>,
  <span key={k + 'v'} style={{ color: COLOR.text }}>{v}</span>,
];
const grid = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: `${GAP.xs}px ${GAP.lg}px`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm };

function quotaText(q) {
  if (!q) return '—';
  if (q.kind === 'unlimited') return t('不限额');
  return `$${Number(q.used || 0).toFixed(2)} / $${Number(q.limit || 0).toFixed(2)}${q.kind === 'lifetime' ? ` · ${t('试用总额')}` : ` · ${t('今日')}`}`;
}

export function LocalAccount({ relay, onChange, showToast }) {
  const logout = async () => {
    try { await Local.relayLogout(); window.location.href = '/'; }
    catch (e) { showToast?.(e.message, 'error'); }
  };
  if (!relay?.configured) {
    return (
      <Card>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, marginBottom: GAP.md }}>{t('没有登录站点账号。登录后这台电脑就能用站点提供的模型和额度。')}</div>
        <RelayLoginForm relay={relay} onDone={onChange} showToast={showToast} />
      </Card>
    );
  }
  const w = relay.whoami || {};
  return (
    <Card>
      <div style={grid}>
        <Row k={t('账号')} v={w.username || (relay.ok ? '?' : t('连不上站点'))} />
        <Row k={t('档位')} v={w.tier || '—'} />
        <Row k={t('额度')} v={quotaText(w.quota)} />
        <Row k={t('这台设备')} v={w.device ? `${w.device.label || t('未命名')} · ${w.device.id}` : '—'} />
        <Row k={t('站点')} v={<span style={{ fontFamily: FONT_MONO }}>{relay.url}</span>} />
      </div>
      {!relay.ok && <Err>{t('连不上：{err}', { err: relay.error || '' })}</Err>}
      <div style={{ display: 'flex', gap: GAP.sm, marginTop: GAP.md }}>
        <Btn small onClick={() => window.open(`${relay.url}/devices`, '_blank')}>{t('管理设备')}</Btn>
        <Btn small onClick={async () => { try { const r = await Local.relayRefresh(); onChange?.(r); } catch (e) { showToast?.(e.message, 'error'); } }}>{t('刷新')}</Btn>
        <span style={{ flex: 1 }} />
        <Btn small danger onClick={logout}>{t('退出登录')}</Btn>
      </div>
    </Card>
  );
}

/** 登录表单（设置页里那份；首启门在 AuthGate） */
export function RelayLoginForm({ relay, onDone, showToast }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!username.trim() || !password) { setErr(t('用户名和密码都要填')); return; }
    setBusy(true); setErr('');
    try {
      const r = await Local.relayLogin({ username: username.trim(), password, ...(url.trim() ? { url: url.trim() } : {}) });
      onDone?.(r); setPassword(''); showToast?.(t('已登录'), 'info');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
      <div style={{ display: 'flex', gap: GAP.sm, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextInput value={username} onChange={setUsername} placeholder={t('用户名')} mono={false} width={160} />
        <TextInput value={password} onChange={setPassword} placeholder={t('密码')} type="password" mono={false} width={160} />
        <TextInput value={url} onChange={setUrl} placeholder={t('站点地址（可选，默认官方站）')} width={260} />
        <Btn primary small onClick={submit} disabled={busy}>{busy ? t('登录中…') : t('登录')}</Btn>
      </div>
      {err && <Err>{err}</Err>}
      <Hint>{t('没有账号？')} <a href={relay?.url || '#'} target="_blank" rel="noreferrer">{t('去站点注册')}</a></Hint>
    </div>
  );
}

export function HostedAccount({ authUser, usage }) {
  const logout = async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* */ } window.location.reload(); };
  return (
    <Card>
      <div style={grid}>
        <Row k={t('账号')} v={authUser?.username || '—'} />
        <Row k={t('档位')} v={usage?.tier || '—'} />
        <Row k={t('额度')} v={usage ? (usage.capped ? `$${Number(usage.used ?? usage.usedToday ?? 0).toFixed(2)} / $${Number(usage.limit || 0).toFixed(2)}` : t('不限额')) : '—'} />
      </div>
      <div style={{ display: 'flex', gap: GAP.sm, marginTop: GAP.md }}>
        <Btn small onClick={() => { window.location.href = '/devices'; }}>{t('桌面版设备')}</Btn>
        <span style={{ flex: 1 }} />
        <Btn small danger onClick={logout}>{t('登出')}</Btn>
      </div>
    </Card>
  );
}

export { Dot };
