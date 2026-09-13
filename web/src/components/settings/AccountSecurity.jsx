// web/src/components/settings/AccountSecurity.jsx — 设置 → 账户 → 「账号与安全」（hosted 网页版，09-13 auth-v2 第三批）
//
//   账号与安全   用户名 / 邮箱 / 密码
//   第三方登录   Google / GitHub：关联（整页跳转）/ 解除关联
//   网页登录     会话列表，逐条退出；退出其他所有设备（含桌面版）
//
// 身份验证只有一份（ReauthBlock）：服务端对敏感动作回 403 REAUTH_REQUIRED 时，在触发它的那一行下面展开，
// 验证通过后自动重跑原动作。有密码 → 输密码；没密码但开了邮箱且绑了邮箱 → 发验证码；都没有 → 说明怎么办。
// emailAuth=false（SES 还在沙盒）时，一切依赖邮箱验证码的入口都不露。请求与纯函数在 account-api.js。
import { useState, useEffect, useCallback } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_KAI, RADIUS } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Panel, Row, Block, Badge, Button, Mono, Note } from './ui.jsx';
import { TextInput } from '../local/primitives.jsx';
import { t } from '../../lib/i18n.js';
import {
  AccountApi, isReauthError, linkStartUrl, providerLabel, sessionMethodLabel,
  summarizeUserAgent, formatLastSeen, oauthErrorMessage, readOAuthReturn,
} from './account-api.js';

const FORM = { display: 'flex', flexDirection: 'column', gap: GAP.md, maxWidth: 420 };
const ACTIONS = { display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' };
// 行下面展开的表单：跟上一行同一块，不再画发丝线
const UNDER_ROW = { borderTop: 0, paddingTop: 0 };
const VALUE = { fontFamily: FONT_KAI, fontSize: FONT_SIZE.base, color: COLOR.text2 };

/** 输入框里按回车 = 点主按钮（输入法选字时的回车不算） */
const onEnter = (fn) => (e) => {
  if (e.key !== 'Enter' || e.target?.tagName !== 'INPUT' || e.nativeEvent?.isComposing) return;
  e.preventDefault();
  fn();
};

const needReauth = () => Object.assign(new Error(''), { code: 'REAUTH_REQUIRED' });

/**
 * 一次动作的 busy / 出错。fn 里自己处理成功后的事；
 * 服务端要求先验证身份时交给 ask(key, retry)，验证通过后由 ReauthBlock 调 retry 重跑。
 */
function useAction(requestReauth, actionKey) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // 参数名故意不叫 ask / key：hook-order lint 按名字对账，会跟下面组件里同名的局部变量撞上
  const run = useCallback(async function go(fn) {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) {
      if (isReauthError(e)) requestReauth(actionKey, () => go(fn));
      else setErr(e);
    } finally { setBusy(false); }
  }, [requestReauth, actionKey]);
  return { busy, err, setErr, run };
}

/** 服务端给的 error 原样显示；会话刚换发时附「刷新页面」 */
function ErrorNote({ err }) {
  if (!err) return null;
  if (err.code === 'SESSION_REFRESH_REQUIRED') {
    return (
      <div style={ACTIONS}>
        <Note tone="bad">{err.message}</Note>
        <Button size="sm" onClick={() => window.location.reload()}>{t('刷新页面')}</Button>
      </div>
    );
  }
  return <Note tone="bad">{err.message}</Note>;
}

function ReauthBlock({ user, emailAuth, onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const mode = user?.hasPassword ? 'password' : (emailAuth && user?.email ? 'code' : 'none');
  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const submitPassword = () => {
    if (!password) { setErr(new Error(t('请输入密码'))); return; }
    act(async () => { await AccountApi.reauthPassword(password); onDone(); });
  };
  const sendCode = () => act(async () => { await AccountApi.reauthCodeStart(); setSent(true); });
  const submitCode = () => {
    if (!code.trim()) { setErr(new Error(t('请输入验证码'))); return; }
    act(async () => { await AccountApi.reauthCodeVerify(code.trim()); onDone(); });
  };

  let body;
  if (mode === 'password') {
    body = (
      <>
        <Note>{t('此操作涉及账号安全，请输入当前密码。')}</Note>
        <TextInput value={password} onChange={setPassword} placeholder={t('当前密码')} type="password" mono={false} />
        <div style={ACTIONS}>
          <Button variant="primary" size="sm" onClick={submitPassword} disabled={busy}>{busy ? t('验证中…') : t('验证')}</Button>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('取消')}</Button>
        </div>
      </>
    );
  } else if (mode === 'code') {
    body = (
      <>
        <Note>{sent ? t('验证码已发送至 {email}。', { email: user.email }) : t('此操作涉及账号安全，需要向 {email} 发送验证码。', { email: user.email })}</Note>
        {sent && <TextInput value={code} onChange={setCode} placeholder={t('6 位验证码')} mono={false} />}
        <div style={ACTIONS}>
          {sent
            ? <Button variant="primary" size="sm" onClick={submitCode} disabled={busy}>{busy ? t('验证中…') : t('验证')}</Button>
            : <Button variant="primary" size="sm" onClick={sendCode} disabled={busy}>{busy ? t('发送中…') : t('发送验证码')}</Button>}
          {sent && <Button size="sm" onClick={sendCode} disabled={busy}>{t('重新发送')}</Button>}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('取消')}</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Note>{t('当前账号未设置密码，暂时无法通过邮箱验证身份。请退出后使用第三方账号重新登录，并在 5 分钟内完成此操作。')}</Note>
        <div style={ACTIONS}><Button variant="ghost" size="sm" onClick={onCancel}>{t('取消')}</Button></div>
      </>
    );
  }
  return (
    <div onKeyDown={onEnter(mode === 'password' ? submitPassword : sent ? submitCode : () => {})}
      style={{ ...FORM, padding: `${GAP.lg}px ${GAP.xl}px`, background: COLOR.bgCard, borderRadius: RADIUS.sm }}>
      <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{t('验证身份')}</div>
      {body}
      <ErrorNote err={err} />
    </div>
  );
}

function UsernameRow({ user, gate, onUser, showToast }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const { busy, err, setErr, run } = useAction(gate.ask, 'username');
  const close = () => { setEditing(false); setErr(null); };
  const save = () => {
    if (busy) return;
    const name = value.trim();
    if (!name) { setErr(new Error(t('请输入用户名'))); return; }
    if (name === user.username) { close(); return; }
    run(async () => {
      const r = await AccountApi.setUsername(name);
      onUser(r.user); close();
      showToast?.(t('用户名已更新'), 'info');
    });
  };
  return (
    <>
      <Row first label={t('用户名')} desc={t('用于登录与对外展示')}>
        <span style={VALUE}>{user.username}</span>
        {!editing && <Button size="sm" onClick={() => { setValue(user.username || ''); setEditing(true); }}>{t('修改')}</Button>}
      </Row>
      {editing && (
        <Block style={UNDER_ROW}>
          <div style={FORM} onKeyDown={onEnter(save)}>
            <TextInput value={value} onChange={setValue} placeholder={t('新用户名')} mono={false} />
            <div style={ACTIONS}>
              <Button variant="primary" size="sm" onClick={save} disabled={busy}>{busy ? t('保存中…') : t('保存')}</Button>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>{t('取消')}</Button>
            </div>
            <ErrorNote err={err} />
          </div>
        </Block>
      )}
      {gate.slot('username')}
    </>
  );
}

function EmailRow({ user, emailAuth, gate, onUser, showToast }) {
  const [step, setStep] = useState(null);   // null | 'input' | 'code'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const { busy, err, setErr, run } = useAction(gate.ask, 'email');
  const bound = !!user.email;
  const close = () => { setStep(null); setEmail(''); setCode(''); setErr(null); };
  const send = () => {
    if (busy) return;
    const addr = email.trim();
    if (!addr) { setErr(new Error(t('请输入邮箱地址'))); return; }
    run(async () => { await AccountApi.emailStart(addr); setCode(''); setStep('code'); });
  };
  const resend = () => run(async () => { await AccountApi.emailStart(email.trim()); showToast?.(t('验证码已重新发送'), 'info'); });
  const verify = () => {
    if (busy) return;
    if (!code.trim()) { setErr(new Error(t('请输入验证码'))); return; }
    run(async () => {
      const r = await AccountApi.emailVerify(email.trim(), code.trim());
      onUser(r.user); close();
      showToast?.(bound ? t('邮箱已更换') : t('邮箱已绑定'), 'info');
    });
  };
  let desc;
  if (!emailAuth) desc = t('邮箱绑定将在稍后开放');
  else if (bound) desc = t('用于邮箱登录与找回密码');
  else desc = t('绑定邮箱后可以用邮箱登录，并在忘记密码时自助找回');
  return (
    <>
      <Row label={t('邮箱')} desc={desc}>
        {bound ? <Mono>{user.email}</Mono> : <Badge>{t('未绑定')}</Badge>}
        {emailAuth && !step && <Button size="sm" onClick={() => setStep('input')}>{bound ? t('更换') : t('绑定')}</Button>}
      </Row>
      {emailAuth && step === 'input' && (
        <Block style={UNDER_ROW}>
          <div style={FORM} onKeyDown={onEnter(send)}>
            <TextInput value={email} onChange={setEmail} placeholder={bound ? t('新邮箱地址') : t('邮箱地址')} type="email" mono={false} />
            <div style={ACTIONS}>
              <Button variant="primary" size="sm" onClick={send} disabled={busy}>{busy ? t('发送中…') : t('发送验证码')}</Button>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>{t('取消')}</Button>
            </div>
            <ErrorNote err={err} />
          </div>
        </Block>
      )}
      {emailAuth && step === 'code' && (
        <Block style={UNDER_ROW}>
          <div style={FORM} onKeyDown={onEnter(verify)}>
            <Note>{t('验证码已发送至 {email}。', { email: email.trim() })}</Note>
            <TextInput value={code} onChange={setCode} placeholder={t('6 位验证码')} mono={false} />
            <div style={ACTIONS}>
              <Button variant="primary" size="sm" onClick={verify} disabled={busy}>{busy ? t('处理中…') : t('确认')}</Button>
              <Button size="sm" onClick={resend} disabled={busy}>{t('重新发送')}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setStep('input'); setErr(null); }} disabled={busy}>{t('修改邮箱地址')}</Button>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>{t('取消')}</Button>
            </div>
            <ErrorNote err={err} />
          </div>
        </Block>
      )}
      {gate.slot('email')}
    </>
  );
}

function PasswordRow({ user, gate, onChanged, showToast }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const { busy, err, setErr, run } = useAction(gate.ask, 'password');
  const has = !!user.hasPassword;
  const close = () => { setOpen(false); setCurrent(''); setNext(''); setAgain(''); setErr(null); };
  // 没有密码的号设置密码要「刚验证过身份」：先验证再展开表单，免得填完才被拦
  const start = () => {
    if (has) { setOpen(true); return; }
    run(async () => {
      const a = await AccountApi.account();
      if (!a.recentAuth) throw needReauth();
      setOpen(true);
    });
  };
  const submit = () => {
    if (busy) return;
    if (has && !current) { setErr(new Error(t('请输入当前密码'))); return; }
    if (!next) { setErr(new Error(t('请输入新密码'))); return; }
    if (next !== again) { setErr(new Error(t('两次输入的新密码不一致'))); return; }
    const body = has ? { currentPassword: current, newPassword: next } : { newPassword: next };
    run(async () => {
      const r = await AccountApi.setPassword(body);
      close(); onChanged();
      const n = Number(r.sessionsRevoked) || 0;
      showToast?.(n > 0 ? t('密码已更新，其他 {n} 处网页登录已退出', { n }) : t('密码已更新'), 'info');
    });
  };
  return (
    <>
      <Row label={t('密码')} desc={has ? t('修改密码后，其他网页登录将全部退出') : t('设置密码后，可以使用密码登录')}>
        <Badge tone={has ? 'ok' : 'neutral'}>{has ? t('已设置') : t('未设置')}</Badge>
        {!open && <Button size="sm" onClick={start} disabled={busy}>{has ? t('修改密码') : t('设置密码')}</Button>}
      </Row>
      {open && (
        <Block style={UNDER_ROW}>
          <div style={FORM} onKeyDown={onEnter(submit)}>
            {has && <TextInput value={current} onChange={setCurrent} placeholder={t('当前密码')} type="password" mono={false} />}
            <TextInput value={next} onChange={setNext} placeholder={t('新密码')} type="password" mono={false} />
            <TextInput value={again} onChange={setAgain} placeholder={t('再次输入新密码')} type="password" mono={false} />
            <div style={ACTIONS}>
              <Button variant="primary" size="sm" onClick={submit} disabled={busy}>{busy ? t('保存中…') : t('保存')}</Button>
              <Button variant="ghost" size="sm" onClick={close} disabled={busy}>{t('取消')}</Button>
            </div>
            <ErrorNote err={err} />
          </div>
        </Block>
      )}
      {gate.slot('password')}
    </>
  );
}

function IdentityRow({ provider, identity, enabled, first, gate, onChanged, showToast }) {
  const key = `identity:${provider}`;
  const { busy, err, run } = useAction(gate.ask, key);
  const label = providerLabel(provider);
  // 服务端在跳转那一步才查「5 分钟内验证过身份」，不满足会带 reauth_required 跳回来；先在这边查一遍，免得白跑一趟
  const link = () => run(async () => {
    const a = await AccountApi.account();
    if (!a.recentAuth) throw needReauth();
    window.location.href = linkStartUrl(provider);
  });
  const unlink = () => run(async () => {
    await AccountApi.unlink(provider);
    onChanged();
    showToast?.(t('已解除与 {provider} 的关联', { provider: label }), 'info');
  });
  let desc;
  if (identity) desc = identity.email ? t('已关联：{email}', { email: identity.email }) : t('已关联');
  else desc = enabled ? t('未关联') : t('该登录方式暂未开放');
  return (
    <>
      <Row first={first} label={label} desc={desc}>
        {identity && <Button size="sm" variant="danger" onClick={unlink} disabled={busy}>{t('解除关联')}</Button>}
        {!identity && enabled && <Button size="sm" onClick={link} disabled={busy}>{t('关联')}</Button>}
      </Row>
      {err && <Block style={UNDER_ROW}><ErrorNote err={err} /></Block>}
      {gate.slot(key)}
    </>
  );
}

function IdentitiesPanel({ account, providers, gate, onChanged, showToast }) {
  const identities = account.identities || [];
  const list = [...new Set([...(providers || []), ...identities.map((i) => i.provider)])];
  if (!list.length) return null;
  return (
    <Panel title={t('第三方登录')} desc={t('关联后，可以使用对应服务的账号直接登录本站。')}>
      {list.map((p, i) => (
        <IdentityRow key={p} provider={p} first={i === 0} enabled={(providers || []).includes(p)}
          identity={identities.find((x) => x.provider === p) || null} gate={gate} onChanged={onChanged} showToast={showToast} />
      ))}
    </Panel>
  );
}

function SessionsPanel({ gate, reloadKey, showToast }) {
  const [sessions, setSessions] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const rowAct = useAction(gate.ask, 'sessions');
  const allAct = useAction(gate.ask, 'sessions');
  const load = useCallback(() => {
    setLoadErr(null);
    return AccountApi.sessions().then((r) => setSessions(r.sessions || [])).catch(setLoadErr);
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  const revoke = (s) => rowAct.run(async () => {
    await AccountApi.revokeSession(s.id);
    if (s.current) { window.location.reload(); return; }   // 退出的是这一条 = 本页已登出
    setSessions((list) => (list || []).filter((x) => x.id !== s.id));
    showToast?.(t('已退出该登录'), 'info');
  });
  const revokeOthers = () => allAct.run(async () => {
    const r = await AccountApi.revokeOthers();
    setConfirming(false);
    showToast?.(t('已退出 {sessions} 处网页登录与 {devices} 台桌面版设备', { sessions: r.sessionsRevoked ?? 0, devices: r.devicesRevoked ?? 0 }), 'info');
    load();
  });

  let list;
  if (loadErr) {
    list = (
      <Block first>
        <div style={ACTIONS}><Note tone="bad">{loadErr.message}</Note><Button size="sm" onClick={load}>{t('重试')}</Button></div>
      </Block>
    );
  } else if (!sessions) {
    list = <Block first><Note>{t('读取中…')}</Note></Block>;
  } else if (!sessions.length) {
    list = <Block first><Note>{t('暂无网页登录记录')}</Note></Block>;
  } else {
    list = sessions.map((s, i) => {
      const meta = [s.ip, s.lastSeenAt ? t('最近活动：{time}', { time: formatLastSeen(s.lastSeenAt) }) : '', sessionMethodLabel(s.method)].filter(Boolean).join(' · ');
      const name = (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.md }}>
          {summarizeUserAgent(s.userAgent) || t('未知设备')}
          {s.current && <Badge tone="ink">{t('当前')}</Badge>}
        </span>
      );
      return (
        <Row key={s.id} first={i === 0} label={name} desc={meta}>
          <Button size="sm" variant={s.current ? 'danger' : 'secondary'} onClick={() => revoke(s)} disabled={rowAct.busy}>{t('退出')}</Button>
        </Row>
      );
    });
  }

  return (
    <Panel title={t('网页登录')} desc={t('通过浏览器登录本账号的记录。桌面版设备请在上方「管理设备」中查看。')}>
      {list}
      {rowAct.err && <Block><ErrorNote err={rowAct.err} /></Block>}
      <Block>
        {confirming ? (
          <div style={FORM}>
            <Note tone="warn">{t('除当前浏览器外，其他网页登录与全部桌面版设备将立即退出，需要重新登录。')}</Note>
            <div style={ACTIONS}>
              <Button size="sm" variant="danger" onClick={revokeOthers} disabled={allAct.busy}>{allAct.busy ? t('处理中…') : t('确认退出')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={allAct.busy}>{t('取消')}</Button>
            </div>
          </div>
        ) : (
          <div style={ACTIONS}>
            <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>{t('退出其他所有设备（含桌面版）')}</Button>
          </div>
        )}
        <ErrorNote err={allAct.err} />
      </Block>
      {gate.slot('sessions')}
    </Panel>
  );
}

export default function AccountSecurity({ showToast }) {
  const [methods, setMethods] = useState(null);
  const [account, setAccount] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [reauth, setReauth] = useState(null);   // { key, retry }：哪一行在等验证身份，验证通过后重跑什么
  const [sessionsKey, setSessionsKey] = useState(0);

  const loadAccount = useCallback(() => {
    setLoadErr(null);
    return AccountApi.account().then(setAccount).catch(setLoadErr);
  }, []);
  useEffect(() => {
    AccountApi.methods().then(setMethods).catch(() => setMethods({ providers: [], emailAuth: false }));
    loadAccount();
  }, [loadAccount]);

  // 第三方关联跳回来：/settings?linked=google 或 ?oauth_error=xxx → 提示一次，把这两个参数从地址栏去掉
  useEffect(() => {
    const back = readOAuthReturn(window.location.search);
    if (!back.linked && !back.error) return;
    if (back.linked) showToast?.(t('已关联 {provider}', { provider: providerLabel(back.linked) }), 'info');
    else showToast?.(oauthErrorMessage(back.error), 'error');
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${back.search}${window.location.hash}`); } catch { /* 地址栏改不了不影响使用 */ }
  }, [showToast]);

  const onUser = useCallback((u) => {
    if (!u) return;
    setAccount((a) => (a ? { ...a, user: { ...a.user, ...u } } : a));
    const store = useGlobalStore.getState();
    if (store.authUser) store.setAuthUser({ ...store.authUser, ...u });   // 顶栏与身份卡上的名字跟着变
  }, []);
  const onChanged = useCallback(() => { loadAccount(); setSessionsKey((k) => k + 1); }, [loadAccount]);

  const ask = useCallback((key, retry) => setReauth({ key, retry }), []);
  const slot = (key) => (reauth?.key === key && account ? (
    <Block style={UNDER_ROW}>
      <ReauthBlock user={account.user} emailAuth={!!methods?.emailAuth}
        onCancel={() => setReauth(null)}
        onDone={() => {
          const pending = reauth;
          setReauth(null);
          setAccount((a) => (a ? { ...a, recentAuth: true } : a));
          pending.retry();
        }} />
    </Block>
  ) : null);
  const gate = { ask, slot };

  if (loadErr || !account || !methods) {
    return (
      <Panel title={t('账号与安全')}>
        <Block first>
          {loadErr
            ? <div style={ACTIONS}><Note tone="bad">{loadErr.message}</Note><Button size="sm" onClick={loadAccount}>{t('重试')}</Button></div>
            : <Note>{t('读取中…')}</Note>}
        </Block>
      </Panel>
    );
  }
  const user = account.user || {};
  return (
    <>
      <Panel title={t('账号与安全')} desc={t('管理用户名、邮箱与密码。涉及账号安全的操作需要先验证身份。')}>
        <UsernameRow user={user} gate={gate} onUser={onUser} showToast={showToast} />
        <EmailRow user={user} emailAuth={!!methods.emailAuth} gate={gate} onUser={onUser} showToast={showToast} />
        <PasswordRow user={user} gate={gate} onChanged={onChanged} showToast={showToast} />
      </Panel>
      <IdentitiesPanel account={account} providers={methods.providers} gate={gate} onChanged={onChanged} showToast={showToast} />
      <SessionsPanel gate={gate} reloadKey={sessionsKey} showToast={showToast} />
    </>
  );
}
