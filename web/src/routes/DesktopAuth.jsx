// web/src/routes/DesktopAuth.jsx — 桌面版「在浏览器中登录」的确认页（09-13 auth-v2 第四批，方案 §5.7）
//
// 桌面版本地服务打开 /desktop-auth?port&state&challenge&device。没登录时 AuthGate 先在这个地址上显示登录墙
// （第三方登录会带着这个地址回来），登录后到这里：展示账号、设备名、本机端口，用户点「允许」。
//
// 几条规矩：
//   - 「允许」是 JSON POST（跨站页面代提交不了，服务端还有 Origin 闸），跳转地址由服务端按数字端口拼
//   - 被嵌进别人的框架里就什么按钮都不画（点击劫持）；服务端 nginx 另加 frame-ancestors 'none'
//   - 设备名是本机主机名，只当纯文本显示、截断
import { useMemo, useState } from 'react';
import AppShell from '../components/layout/AppShell.jsx';
import { Desk } from './desk.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../lib/theme.js';
import { Section, Card, Btn, Err, Hint } from '../components/local/primitives.jsx';
import { useGlobalStore } from '../stores/globalStore.js';
import { t } from '../lib/i18n.js';

/** 与 server/hosted/auth/desktop-auth.js 的 parseDesktopAuthParams 同一套规则 */
export function parseDesktopAuthQuery(search) {
  const q = new URLSearchParams(search);
  const port = Number(q.get('port'));
  const state = q.get('state') || '';
  const challenge = q.get('challenge') || '';
  if (!/^\d{1,5}$/.test(q.get('port') || '') || port < 1024 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const device = (q.get('device') || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 60);
  return { port, state, challenge, device };
}

function framed() {
  try { return window.top !== window.self; } catch { return true; }
}

export default function DesktopAuth() {
  const params = useMemo(() => parseDesktopAuthQuery(location.search), []);
  const user = useGlobalStore((s) => s.authUser);
  const [phase, setPhase] = useState('ask');   // ask | busy | redirected | cancelled
  const [err, setErr] = useState('');

  const allow = async () => {
    setPhase('busy'); setErr('');
    try {
      const res = await fetch('/api/me/desktop-auth/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.redirect !== 'string' || !data.redirect.startsWith('http://127.0.0.1:')) {
        setErr(data.error || t('操作失败 ({status})', { status: res.status }));
        setPhase('ask');
        return;
      }
      setPhase('redirected');
      location.assign(data.redirect);
    } catch {
      setErr(t('网络错误，请重试'));
      setPhase('ask');
    }
  };

  const cancel = () => {
    setPhase('cancelled');
    // 告诉桌面版不用再等了（它那边显示「已取消」）；桌面版没在运行的话浏览器会显示连不上，也无妨
    location.assign(`http://127.0.0.1:${params.port}/api/local/relay/callback?${new URLSearchParams({ error: 'access_denied', state: params.state })}`);
  };

  const switchAccount = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 下面刷新后 AuthGate 会重新判 */ }
    location.reload();
  };

  const row = (label, value, mono = false) => (
    <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: GAP.md, padding: `${GAP.xs}px 0`, fontSize: FONT_SIZE.sm }}>
      <span style={{ color: COLOR.sub }}>{label}</span>
      <span style={{ color: COLOR.text, fontFamily: mono ? FONT_MONO : FONT_SANS, wordBreak: 'break-all' }}>{value}</span>
    </div>
  );

  let content;
  if (framed()) {
    content = <Err>{t('出于安全原因，此页面不能在其他网页中打开。')}</Err>;
  } else if (!params) {
    content = <Err>{t('登录链接无效，请回到 NoDesign 桌面版重新发起')}</Err>;
  } else if (phase === 'redirected') {
    content = (<>
      <div style={{ fontSize: FONT_SIZE.base, color: COLOR.text }}>{t('正在返回 NoDesign 桌面版…')}</div>
      <Hint>{t('如果桌面版没有反应，请确认它仍在运行，然后在桌面版中重新点击「在浏览器中登录」。')}</Hint>
    </>);
  } else if (phase === 'cancelled') {
    content = <div style={{ fontSize: FONT_SIZE.base, color: COLOR.text }}>{t('已取消，可以关闭此页面。')}</div>;
  } else {
    const account = user ? (user.email ? `${user.username}（${user.email}）` : user.username) : '—';
    content = (<>
      {row(t('账号'), account)}
      {row(t('设备'), params.device || t('未命名设备'))}
      {row(t('本机端口'), String(params.port), true)}
      <div style={{ margin: `${GAP.md}px 0`, fontSize: FONT_SIZE.sm, color: COLOR.text2, lineHeight: 1.7 }}>
        {t('只有在你刚刚于 NoDesign 桌面版中点击了「在浏览器中登录」时才允许。允许后，这台设备将使用你的账号与额度，可以随时在设置中退出。')}
      </div>
      <Err>{err}</Err>
      <div style={{ display: 'flex', gap: GAP.sm, alignItems: 'center', flexWrap: 'wrap', marginTop: GAP.sm }}>
        <Btn primary onClick={allow} disabled={phase === 'busy'}>{phase === 'busy' ? t('正在处理') : t('允许')}</Btn>
        <Btn onClick={cancel} disabled={phase === 'busy'}>{t('取消')}</Btn>
        <span style={{ flex: 1 }} />
        <a href="#switch" onClick={(e) => { e.preventDefault(); switchAccount(); }} style={{ fontSize: FONT_SIZE.xs, color: COLOR.text2 }}>{t('不是这个账号？切换账号')}</a>
      </div>
    </>);
  }

  return (
    <AppShell breadcrumb={[{ label: t('桌面版登录') }]}>
      <Desk plain>
        <div style={{ maxWidth: 560, margin: '0 auto', padding: `${GAP.xl}px ${GAP.xl}px 80px`, fontFamily: FONT_SANS }}>
          <Section title={t('允许 NoDesign 桌面版登录？')}>
            <Card>{content}</Card>
          </Section>
        </div>
      </Desk>
    </AppShell>
  );
}
