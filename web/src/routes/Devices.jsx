// web/src/routes/Devices.jsx — 桌面版 / npx 版的设备令牌（hosted 用户自己签发、查看、吊销）。
// 令牌明文只在新建那一刻显示一次：复制走之后这页再也拿不到它，丢了就吊销再签。
import { useState, useEffect } from 'react';
import AppShell from '../components/layout/AppShell.jsx';
import { Desk } from './desk.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { Me } from '../lib/api.js';
import { Section, Card, Btn, Err, TextInput, Hint } from '../components/local/primitives.jsx';
import { t } from '../lib/i18n.js';

export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [err, setErr] = useState('');
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null);   // { device, token } 刚签的那枚，只在内存里
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = () => Me.devices().then((r) => setDevices(r.devices)).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, []);

  const create = async () => {
    setBusy(true); setErr(''); setCopied(false);
    try {
      const r = await Me.createDevice(label.trim());
      setFresh(r); setLabel('');
      await reload();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const revoke = async (d) => {
    setBusy(true); setErr('');
    try { await Me.revokeDevice(d.id); if (fresh?.device?.id === d.id) setFresh(null); await reload(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(fresh.token); setCopied(true); } catch { /* 剪贴板不可用就让用户手选 */ }
  };

  const crumbs = [{ label: t('桌面版设备') }];
  const active = (devices || []).filter((d) => !d.revoked);
  const revoked = (devices || []).filter((d) => d.revoked);

  return (
    <AppShell breadcrumb={crumbs}>
      {/* 只要光，不要台面 —— 见 desk.jsx 的 .ndd-plain。
          这页的页面级文字只有 Section 的标题，那个零件自己带 --desk-* 和兜底 */}
      <Desk plain>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: `${GAP.xl}px ${GAP.xl}px 80px`, fontFamily: FONT_SANS }}>
        <Section title={t('桌面版设备')} desc={t('若您在电脑上安装了 NoDesign 桌面版（或通过 npx 运行），可签发一枚令牌填入其设置页的「NoDesign 服务」。该设备的推理将使用本账号，并按本账号计量')}>
          <Card>
            {err && <Err>{err}</Err>}
            <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <TextInput value={label} onChange={setLabel} placeholder={t('为该设备命名（可选），例如「家中台式机」')} mono={false} width={320} />
              <Btn primary onClick={create} disabled={busy}>{t('签发新令牌')}</Btn>
            </div>
            {fresh && (
              <div style={{ marginTop: GAP.md, padding: GAP.md, background: 'rgba(43,33,23,0.04)', borderRadius: 8 }}>
                <div style={{ fontSize: FONT_SIZE.sm, color: COLOR.text2, marginBottom: GAP.xs }}>
                  {t('该令牌仅显示一次，请立即复制保存：')}
                </div>
                <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                  <code style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, wordBreak: 'break-all', userSelect: 'all', flex: 1, minWidth: 240 }}>{fresh.token}</code>
                  <Btn small onClick={copy}>{copied ? t('已复制') : t('复制')}</Btn>
                </div>
                <Hint>{t('填入桌面版：设置 → NoDesign 服务 → 设备令牌。令牌遗失时，请在下方吊销该令牌并重新签发。')}</Hint>
              </div>
            )}
          </Card>
        </Section>

        <Section title={t('在用的设备')}>
          <Card>
            {devices === null ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span>
              : active.length === 0 ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('暂未签发过令牌')}</span>
                : <DeviceRows rows={active} onRevoke={revoke} busy={busy} />}
          </Card>
        </Section>

        {revoked.length > 0 && (
          <Section title={t('已吊销')}>
            <Card><DeviceRows rows={revoked} /></Card>
          </Section>
        )}
      </div>
      </Desk>
    </AppShell>
  );
}

function DeviceRows({ rows, onRevoke, busy }) {
  const fmt = (s) => (s ? new Date(s.endsWith('Z') ? s : s + 'Z').toLocaleString() : '—');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: `${GAP.sm}px ${GAP.lg}px`, alignItems: 'center', fontSize: FONT_SIZE.sm }}>
      {rows.map((d) => [
        <div key={d.id + 'a'} style={{ color: COLOR.text }}>
          {d.label || t('未命名设备')}
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>ndk_{d.id}.…</div>
        </div>,
        <div key={d.id + 'b'} style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs }}>{t('签发')} {fmt(d.createdAt)}</div>,
        <div key={d.id + 'c'} style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs }}>{t('上次使用')} {fmt(d.lastSeenAt)}</div>,
        <div key={d.id + 'd'}>{onRevoke ? <Btn small danger onClick={() => onRevoke(d)} disabled={busy}>{t('吊销')}</Btn> : <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.xs }}>{t('已吊销')}</span>}</div>,
      ])}
    </div>
  );
}
