// 设置 → 账户：本地版 = 站点账号（身份卡 / 档位 / 今日额度 / 这台设备 / 退出）；hosted = 当前账号 + 设备页 + 登出
import { useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_KAI } from '../../lib/theme.js';
import { Local } from '../../lib/api.js';
import { Panel, Row, Block, Badge, Button, Progress, Mono, Note } from './ui.jsx';
import { TextInput } from '../local/primitives.jsx';
import { t } from '../../lib/i18n.js';

const TIER_LABEL = { basic: 'Basic', pro: 'Pro', trial: 'Trial', admin: 'Admin' };

/**
 * 身份卡：头像 + 用户名 + 档位标签 + 右侧动作。
 * 头像可换（09-07）：点头像选图，原图交给 put（hosted 直传 /api/me/avatar，本地版经 relay 到站点），站点缩成 128 webp。
 * avatar 是图片地址（hosted 的 /api/me/avatar?v= 或 whoami 里的 data URL）；没有就画首字。
 */
function Identity({ name, tier, sub, actions, avatar = null, onPut = null, onClear = null, showToast }) {
  const initial = (name || '?').trim().slice(0, 1).toUpperCase();
  const [busy, setBusy] = useState(false);
  const pick = () => {
    if (!onPut || busy) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      if (f.size > 2 * 1024 * 1024) { showToast?.(t('图片超过 2MB，请先缩小'), 'error'); return; }
      setBusy(true);
      try { await onPut(f); showToast?.(t('头像已更新'), 'info'); }
      catch (e) { showToast?.(e.message, 'error'); }
      finally { setBusy(false); }
    };
    input.click();
  };
  const circle = { width: 48, height: 48, borderRadius: '50%', background: COLOR.btn, color: COLOR.btnText, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_KAI, fontSize: 20, flexShrink: 0, overflow: 'hidden', padding: 0, border: 0, cursor: onPut ? 'pointer' : 'default', opacity: busy ? 0.6 : 1 };
  return (
    <Block first>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.xl }}>
        <button type="button" onClick={pick} title={onPut ? t('更换头像') : undefined} aria-label={t('更换头像')} style={circle}>
          {avatar ? <img src={avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : initial}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md }}>
            <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.h2, fontWeight: 600, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            {tier && <Badge tone={tier === 'pro' ? 'ink' : 'neutral'}>{TIER_LABEL[tier] || tier}</Badge>}
          </div>
          {sub && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4, marginTop: 2 }}>{sub}</div>}
          {onPut && (
            <div style={{ display: 'flex', gap: GAP.md, marginTop: 4, fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.text4 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); pick(); }} style={{ color: COLOR.text3 }}>{t('更换头像')}</a>
              {avatar && onClear && <a href="#" onClick={async (e) => { e.preventDefault(); try { await onClear(); } catch (err) { showToast?.(err.message, 'error'); } }} style={{ color: COLOR.text3 }}>{t('移除头像')}</a>}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: GAP.sm, flexShrink: 0 }}>{actions}</div>
      </div>
    </Block>
  );
}

/** 额度行：进度条 + 「$1.37 / $5.00 · 今日」 */
function QuotaRow({ quota }) {
  if (!quota) return <Row label={t('额度')}><Note>—</Note></Row>;
  if (quota.kind === 'unlimited') return <Row label={t('额度')} desc={t('当前档位不限额度')}><Badge tone="ok">{t('不限额')}</Badge></Row>;
  const used = Number(quota.used || 0); const limit = Number(quota.limit || 0);
  const ratio = limit > 0 ? used / limit : 0;
  const period = quota.kind === 'lifetime' ? t('试用总额') : t('今日');
  return (
    <Row label={t('额度')} desc={quota.kind === 'lifetime' ? t('试用额度用完后需升级档位') : t('每天按北京时间零点重置')}>
      <div style={{ width: 260 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text2, marginBottom: 4 }}>
          <span>${used.toFixed(2)} / ${limit.toFixed(2)}</span>
          <span style={{ color: COLOR.text4 }}>{period}</span>
        </div>
        <Progress value={used} max={limit} tone={ratio >= 0.95 ? 'bad' : ratio >= 0.75 ? 'warn' : 'ink'} />
      </div>
    </Row>
  );
}

export function LocalAccount({ relay, onChange, showToast }) {
  const logout = async () => {
    try { await Local.relayLogout(); window.location.href = '/'; }
    catch (e) { showToast?.(e.message, 'error'); }
  };
  const refresh = async () => { try { const r = await Local.relayRefresh(); onChange?.(r); showToast?.(t('已刷新'), 'info'); } catch (e) { showToast?.(e.message, 'error'); } };

  if (!relay?.configured) {
    return (
      <Panel title={t('登录站点账号')} desc={t('登录后，本机即可使用站点提供的模型与额度。')}>
        <Block first><RelayLoginForm relay={relay} onDone={onChange} showToast={showToast} /></Block>
      </Panel>
    );
  }
  const w = relay.whoami || {};
  const name = w.username || (relay.ok ? '?' : t('无法连接站点'));
  return (
    <>
      <Panel>
        <Identity name={name} tier={w.tier} sub={relay.ok ? t('已登录') : t('无法连接站点，以下为上次获取的信息')}
          avatar={w.avatar || null} showToast={showToast}
          onPut={async (f) => { const r = await Local.relayPutAvatar(f); onChange?.(r); }}
          onClear={async () => { const r = await Local.relayDeleteAvatar(); onChange?.(r); }}
          actions={<>
            <Button size="sm" onClick={refresh}>{t('刷新')}</Button>
            <Button size="sm" variant="danger" onClick={logout}>{t('退出登录')}</Button>
          </>} />
        {!relay.ok && <Block><Note tone="bad">{t('连接失败：{err}', { err: relay.error || '' })}</Note></Block>}
        <QuotaRow quota={w.quota} />
        <Row label={t('这台设备')} desc={w.device?.id ? t('设备 ID {id}', { id: w.device.id }) : t('登录时为本机签发的设备令牌')}>
          <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: COLOR.text2 }}>{w.device ? (w.device.label || t('未命名')) : '—'}</span>
          <Button size="sm" variant="ghost" onClick={() => window.open(`${relay.url}/devices`, '_blank')}>{t('管理设备')}</Button>
        </Row>
        <Row label={t('站点')} desc={t('本机连接的站点地址')}><Mono>{relay.url}</Mono></Row>
      </Panel>
    </>
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
    if (!username.trim() || !password) { setErr(t('请填写用户名和密码')); return; }
    setBusy(true); setErr('');
    try {
      const r = await Local.relayLogin({ username: username.trim(), password, ...(url.trim() ? { url: url.trim() } : {}) });
      onDone?.(r); setPassword(''); showToast?.(t('已登录'), 'info');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md, maxWidth: 420 }}>
      <TextInput value={username} onChange={setUsername} placeholder={t('用户名')} mono={false} />
      <TextInput value={password} onChange={setPassword} placeholder={t('密码')} type="password" mono={false} />
      <TextInput value={url} onChange={setUrl} placeholder={t('站点地址（可选，默认为官方站点）')} />
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md }}>
        <Button variant="primary" onClick={submit} disabled={busy}>{busy ? t('登录中…') : t('登录')}</Button>
        <Note>{t('没有账号？')} <a href={relay?.url || '#'} target="_blank" rel="noreferrer" style={{ color: COLOR.text }}>{t('去站点注册')}</a></Note>
      </div>
      {err && <Note tone="bad">{err}</Note>}
    </div>
  );
}

export function HostedAccount({ authUser, usage, showToast }) {
  const logout = async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* */ } window.location.reload(); };
  const quota = usage ? (usage.capped ? { kind: 'daily', used: usage.used ?? usage.usedToday ?? 0, limit: usage.limit || 0 } : { kind: 'unlimited' }) : null;
  // 头像版本戳：先信 usage 带来的，本页改过之后用本地的（顶栏 5 分钟一拉，自己会追上）
  const [avatarAt, setAvatarAt] = useState(null);
  const at = avatarAt ?? usage?.avatarAt ?? null;
  const putAvatar = async (f) => {
    const r = await fetch('/api/me/avatar', { method: 'PUT', headers: { 'content-type': f.type || 'image/png' }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setAvatarAt(j.avatarAt || String(Date.now()));
    window.dispatchEvent(new Event('nd-usage-refresh'));
  };
  const clearAvatar = async () => { await fetch('/api/me/avatar', { method: 'DELETE' }); setAvatarAt(''); window.dispatchEvent(new Event('nd-usage-refresh')); };
  return (
    <Panel>
      <Identity name={authUser?.username || '—'} tier={usage?.tier} showToast={showToast}
        avatar={at ? `/api/me/avatar?v=${encodeURIComponent(at)}` : null} onPut={putAvatar} onClear={clearAvatar}
        actions={<Button size="sm" variant="danger" onClick={logout}>{t('登出')}</Button>} />
      <QuotaRow quota={quota} />
      <Row label={t('桌面版设备')} desc={t('此处列出使用本账号登录过桌面版的设备')}>
        <Button size="sm" variant="ghost" onClick={() => { window.location.href = '/devices'; }}>{t('管理设备')}</Button>
      </Row>
    </Panel>
  );
}
