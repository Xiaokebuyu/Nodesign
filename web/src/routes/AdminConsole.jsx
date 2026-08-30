import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LayoutDashboard, Users, Ticket, Megaphone, AlertTriangle, ShieldAlert,
  Copy, Pencil, Ban, RotateCcw, Send, X, Trash2,
} from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS, BANNER } from '../lib/theme.js';
import { Admin } from '../lib/api-admin.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo, isImeEnter } from '../lib/helpers.js';
import { IssuesPanel, Segmented } from './Issues.jsx';
import { PAPER_SHADOW } from '../lib/paper.js';
import { Chip, Field, NumInput, PrimaryBtn, GhostBtn, IconBtn } from '../components/admin/primitives.jsx';
import { ModLevelChip, LimitEditor } from '../components/admin/LimitEditor.jsx';

/**
 * AdminConsole — 内测控制台（/admin，2026-08-02）
 *
 * 用户 / 邀请码 / 公告 / 问题库四块收进一个壳。后端 API 早齐了（admin.js），
 * 这一页只是把原来靠 curl 和 invite.mjs 干的事搬进浏览器 —— 手机上也能
 * 铸码、调额度、发重启公告。问题库沿用既有 IssuesPanel，不重写。
 *
 * 命令行保底通道不撤：invite.mjs（pm2 挂了也能铸码）、reset-password.mjs
 * （安全敏感，不给 HTTP 面）。
 */

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/**
 * 顶上那两张模式卡。value = 项目数，sub = 回合数和每项目回合数。
 *
 * ⭐ 真正有信息量的是**每项目回合数**，不是项目数 —— 08-30 第一次拉这个数时，
 * 设计 2.7、演出 8.1，差三倍。项目数只说明谁点得多，每项目回合数说明谁留下来了。
 *
 * ⚠️ 演出模式 08-29 16:02 才有，比设计晚得多。两栏的累计数**不可直接相比**，
 *    看的是各自的每项目回合数。这句话没地方写进卡里，写在这儿。
 */
const MODE_CARDS = [['design', '设计'], ['rp', '演出']];

export default function AdminConsole() {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState(null);
  const [invites, setInvites] = useState(null);
  const [modes, setModes] = useState(null);
  const showToast = useGlobalStore(s => s.showToast);

  const reload = useCallback(() => {
    Admin.users().then(d => setUsers(d.users)).catch(err => showToast(`用户拉取失败：${err.message}`, 'error'));
    Admin.invites().then(d => setInvites(d.invites)).catch(err => showToast(`邀请码拉取失败：${err.message}`, 'error'));
    // 两个模式的用量。拉不到就不显示那两张卡，不弹 toast —— 它不是运营必需品，
    // 为它弹一条错误提示只会在真出事的时候盖住真正的报错。
    Admin.modes().then(d => setModes(d.modes)).catch(() => setModes([]));
  }, [showToast]);
  useEffect(reload, [reload]);

  const copy = useCallback((text) => {
    navigator.clipboard?.writeText(text)
      .then(() => showToast('已复制到剪贴板', 'success'))
      .catch(() => showToast(text, 'info'));
  }, [showToast]);

  const stats = useMemo(() => {
    if (!users) return null;
    const humans = users.filter(u => u.role !== 'admin');
    return {
      userCount: humans.length,
      activeToday: humans.filter(u => (u.costToday || 0) > 0).length,
      costToday: users.reduce((s, u) => s + (u.costToday || 0), 0),
      costTotal: users.reduce((s, u) => s + (u.costTotal || 0), 0),
      invitesOpen: (invites || []).filter(inv =>
        inv.used_count < inv.max_uses && !(inv.expires_at && new Date(inv.expires_at) < new Date())).length,
    };
  }, [users, invites]);

  return (
    <AppShell breadcrumb={[{ label: '控制台' }]}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <header style={{ marginBottom: GAP.xl }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.sm }}>
            <LayoutDashboard size={18} color={COLOR.brown} />
            <h1 style={{
              fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>控制台</h1>
          </div>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
            lineHeight: 1.65, margin: 0, maxWidth: 680,
          }}>
            内测运营的一张桌面：谁在用、烧了多少、放谁进来、有话广播。
          </p>
        </header>

        {stats && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.md, marginBottom: GAP.xxl }}>
            <StatCard label="内测用户" value={`${stats.userCount}`} sub={`今日活跃 ${stats.activeToday}`} />
            <StatCard label="今日全站" value={usd(stats.costToday)} accent={stats.costToday > 20} />
            <StatCard label="累计花费" value={usd(stats.costTotal)} />
            <StatCard label="可用邀请码" value={`${stats.invitesOpen}`} />
            {MODE_CARDS.map(([mode, label]) => {
              const m = (modes || []).find(x => x.mode === mode);
              if (!m) return null;
              return (
                <StatCard
                  key={mode}
                  label={label}
                  value={`${m.projects}`}
                  sub={`${m.runs} 回合 · ${(m.runs / (m.projects || 1)).toFixed(1)}/项目 · ${usd(m.costUsd)}`}
                  title={`${label}模式：${m.users} 个人建了 ${m.projects} 个项目。不含你自己的项目。`}
                />
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: GAP.xxs, padding: 3, background: 'rgba(43,33,23,0.045)', borderRadius: RADIUS.xl, marginBottom: GAP.xl, width: 'fit-content' }}>
          {[
            ['users', '用户', Users],
            ['invites', '邀请码', Ticket],
            ['notices', '公告', Megaphone],
            ['moderation', '审核', ShieldAlert],
            ['issues', '问题库', AlertTriangle],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
                padding: `${GAP.sm}px ${GAP.xl}px`,
                fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: tab === key ? 600 : 400,
                color: tab === key ? COLOR.text : COLOR.sub,
                background: tab === key ? COLOR.bgWhite : 'transparent',
                border: 0, borderRadius: RADIUS.lg, cursor: 'pointer',
                boxShadow: tab === key ? '0 1px 3px rgba(43,33,23,0.08)' : 'none',
              }}
            ><Icon size={13} /> {label}</button>
          ))}
        </div>

        {tab === 'users' && <UsersTab users={users} reload={reload} />}
        {tab === 'invites' && <InvitesTab invites={invites} users={users} reload={reload} copy={copy} />}
        {tab === 'notices' && <NoticesTab />}
        {tab === 'moderation' && <ModerationTab users={users} />}
        {tab === 'issues' && <IssuesPanel />}
      </div>
    </AppShell>
  );
}

function StatCard({ label, value, sub, accent, title }) {
  return (
    <div title={title} style={{
      minWidth: 148, padding: `${GAP.lg}px ${GAP.xl}px`,
      background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xxl,
      boxShadow: PAPER_SHADOW.far,
    }}>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.xs }}>{label}</div>
      <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700, color: accent ? COLOR.warn : COLOR.text }}>
        {value}
      </div>
      {sub && <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.xxs }}>{sub}</div>}
    </div>
  );
}

// ── 用户 ──────────────────────────────────────────────────────────────

/**
 * 排序档。三档都是"降序看头部"：花得最多 / 来得最晚 / 今天最活跃。
 *
 * ⭐ 为什么要有这个开关：默认那档（累计花费）在二十来个用户的时候是对的 ——
 * 观察期最想看的就是谁在真用。但用户过百之后，绝大多数人恒等于 $0.00 并列在
 * 后半段，今天新注册的一律沉到最底下，找一个具体的人要翻八屏。列表本身没坏
 * （92 个一个不少全渲染），坏的是"看得见的那一屏永远是同一批人"。
 *
 * ⚠️ admin 恒置顶，与档位无关 —— 它是站主自己，三档里都不该跟着排。
 * ⚠️ 每档都缀一个兜底次序（注册时间倒序）。并列的那一大片（几十个 $0.00）
 *    比较函数返回 0 时靠的是输入顺序，而输入顺序来自接口，不该指望它。
 */
const SORTS = {
  cost: ['累计花费', (a, b) => (b.costTotal || 0) - (a.costTotal || 0)],
  // 这一档的比较就是下面那个兜底次序本身，写全免得读的人以为是个没写完的桩
  fresh: ['注册时间', (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))],
  today: ['今日活跃', (a, b) => (b.costToday || 0) - (a.costToday || 0)],
};

function UsersTab({ users, reload }) {
  const [sort, setSort] = useState('cost');
  const sorted = useMemo(() => {
    if (!users) return null;
    const cmp = SORTS[sort]?.[1] || SORTS.cost[1];
    return [...users].sort((a, b) =>
      (b.role === 'admin') - (a.role === 'admin')
      || cmp(a, b)
      || String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [users, sort]);

  if (!sorted) return <div style={emptyStyle}>加载中…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
        <Segmented
          value={sort}
          onChange={setSort}
          options={Object.entries(SORTS).map(([k, [label]]) => [k, label])}
        />
        {/* 这一行是这次改动的由头：翻到一半时，没有任何东西告诉你后面还有多少 */}
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          共 {sorted.length} 人
        </span>
      </div>
      {sorted.map(u => <UserRow key={u.id} u={u} reload={reload} />)}
    </div>
  );
}

/** 头像底色：从用户名散列出一个柔和色相，同名恒同色 */
function avatarBg(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h}, 32%, 88%)`;
}

function UserRow({ u, reload }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [editing, setEditing] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const trial = u.lifetimeCostLimitUsd != null;
  const isAdmin = u.role === 'admin';

  // 额度读数：admin 不限；试用号对终身上限；普通号对日限
  const gateUsed = trial ? (u.costTotal || 0) : (u.costToday || 0);
  const gateLimit = trial ? u.lifetimeCostLimitUsd : u.effectiveDailyLimitUsd;
  const pct = gateLimit ? Math.min(100, (gateUsed / gateLimit) * 100) : 0;
  const barColor = pct >= 90 ? COLOR.error : pct >= 75 ? COLOR.warn : COLOR.gold;

  useEffect(() => {
    if (!confirmStop) return undefined;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  const toggleDisabled = async () => {
    if (!u.disabled && !confirmStop) { setConfirmStop(true); return; }
    try {
      await Admin.patchUser(u.id, { disabled: !u.disabled });
      showToast(u.disabled ? `已恢复 ${u.username}` : `已停用 ${u.username}（最迟 60s 生效）`, 'success');
      reload();
    } catch (err) { showToast(`操作失败：${err.message}`, 'error'); }
    setConfirmStop(false);
  };

  return (
    <div style={{
      background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xxl,
      boxShadow: PAPER_SHADOW.far,
      padding: `${GAP.lg}px ${GAP.xl}px`, opacity: u.disabled ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.lg, flexWrap: 'wrap' }}>
        <div style={{
          width: 34, height: 34, borderRadius: RADIUS.round, flexShrink: 0,
          background: avatarBg(u.username), color: COLOR.text2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, fontWeight: 600,
        }}>{[...u.username][0]}</div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 600, color: COLOR.text }}>
              {u.username}
            </span>
            {isAdmin && <Chip color={COLOR.gold}>admin</Chip>}
            {!isAdmin && <Chip color={u.tier === 'pro' ? COLOR.gold : COLOR.sub}>{u.tier === 'pro' ? 'pro' : 'basic'}</Chip>}
            {trial && <Chip color={COLOR.blue}>终身额度 {usd(u.lifetimeCostLimitUsd)}</Chip>}
            {u.disabled && <Chip color={COLOR.error}>已停用</Chip>}
            {u.flagsCount > 0 && <Chip color={COLOR.error}>违规 ×{u.flagsCount}</Chip>}
            <ModLevelChip u={u} />
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 3 }}>
            {u.inviteCode || '创始'} · 注册于 {timeAgo(u.createdAt) || u.createdAt}
          </div>
        </div>

        <div style={{ width: 210, flexShrink: 0 }}>
          {gateLimit ? (
            <>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(43,33,23,0.06)', overflow: 'hidden', marginBottom: GAP.xs }}>
                <div style={{ width: `${pct}%`, height: '100%', background: barColor }} />
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: pct >= 75 ? barColor : COLOR.text2 }}>
                {trial ? '全史' : '今日'} {usd(gateUsed)} / {usd(gateLimit)} · {Math.round(pct)}%
              </div>
            </>
          ) : (
            <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2 }}>
              今日 {usd(u.costToday)} · 不限额
            </div>
          )}
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.xxs }}>
            累计 {usd(u.costTotal)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: GAP.xxs, flexShrink: 0 }}>
          {/* admin 也要能开合外审档，所以铅笔对所有人显示（编辑器内部再按角色裁字段） */}
          <IconBtn title={isAdmin ? '外审设置' : '限额与外审'} onClick={() => setEditing(v => !v)}><Pencil size={13} /></IconBtn>
          {!isAdmin && (
            <>
              {confirmStop ? (
                <button
                  onClick={toggleDisabled}
                  style={{
                    padding: `0 ${GAP.md}px`, height: 26, borderRadius: RADIUS.md, border: 0, cursor: 'pointer',
                    background: COLOR.error, color: COLOR.bgWhite, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
                  }}
                >确认停用？</button>
              ) : (
                <IconBtn
                  title={u.disabled ? '恢复账号' : '停用账号'}
                  onClick={toggleDisabled}
                  danger={!u.disabled}
                >{u.disabled ? <RotateCcw size={13} /> : <Ban size={13} />}</IconBtn>
              )}
            </>
          )}
        </div>
      </div>

      {editing && <LimitEditor u={u} onDone={() => { setEditing(false); reload(); }} onCancel={() => setEditing(false)} />}
    </div>
  );
}

function InvitesTab({ invites, users, reload, copy }) {
  const showToast = useGlobalStore(s => s.showToast);
  const [uses, setUses] = useState('1');
  const [days, setDays] = useState('');
  const [grant, setGrant] = useState('');
  const [minting, setMinting] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [editCode, setEditCode] = useState(null);   // 正在改次数的码
  const [editUses, setEditUses] = useState('');

  // 邀请码 → 用它注册的人（观察转化用；users 自带 inviteCode 字段）
  const usedBy = useMemo(() => {
    const m = new Map();
    for (const u of users || []) {
      if (!u.inviteCode) continue;
      if (!m.has(u.inviteCode)) m.set(u.inviteCode, []);
      m.get(u.inviteCode).push(u.username);
    }
    return m;
  }, [users]);

  const mint = async () => {
    const n = (v) => Number(v);
    if (uses !== '' && (!Number.isFinite(n(uses)) || n(uses) < 1)) { showToast('次数至少 1', 'error'); return; }
    setMinting(true);
    try {
      const { invite } = await Admin.createInvite({
        maxUses: n(uses) || 1,
        ...(days !== '' && n(days) > 0 ? { expiresInDays: n(days) } : {}),
        ...(grant !== '' && n(grant) > 0 ? { grantLifetimeUsd: n(grant) } : {}),
      });
      setFresh(invite);
      copy(invite.code);
      reload();
    } catch (err) {
      showToast(`铸码失败：${err.message}`, 'error');
    }
    setMinting(false);
  };

  // 改总次数（不是剩余）。改到 ≤ 已用数 = 封死这个码 —— 简历码泄漏时的止血阀
  const saveUses = async (inv) => {
    const n = Number(editUses);
    if (!Number.isInteger(n) || n < 0) { showToast('次数需为 ≥0 的整数（0 = 封死）', 'error'); return; }
    try {
      await Admin.patchInvite(inv.code, { maxUses: n });
      showToast(n <= inv.used_count ? `${inv.code} 已封死` : `${inv.code} 次数改为 ${n}`, 'success');
      setEditCode(null);
      reload();
    } catch (err) { showToast(`修改失败：${err.message}`, 'error'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xl }}>
      <div style={{
        background: COLOR.bgCard, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xxl,
        padding: `${GAP.xl}px ${GAP.xl}px`,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: GAP.xl, flexWrap: 'wrap' }}>
          <Field label="可用次数">
            <NumInput value={uses} onChange={setUses} placeholder="1" />
          </Field>
          <Field label="有效期（天，留空 = 永久）">
            <NumInput value={days} onChange={setDays} placeholder="—" />
          </Field>
          <Field label="试用赠予 $（留空 = 普通码）">
            <NumInput value={grant} onChange={setGrant} placeholder="—" />
          </Field>
          <PrimaryBtn onClick={mint} disabled={minting}>{minting ? '生成中…' : '生成邀请码'}</PrimaryBtn>
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.md, lineHeight: 1.6 }}>
          试用赠予非空的码（放简历、公开场合）：用它注册的号拿终身额度，烧完不刷新；普通码注册的号走 $15/天。
        </div>
        {fresh && (
          <div style={{
            marginTop: GAP.lg, padding: `${GAP.md}px ${GAP.lg}px`,
            background: COLOR.bgWhite, border: `1px dashed ${COLOR.borderHv}`, borderRadius: RADIUS.xl,
            boxShadow: PAPER_SHADOW.far,
            display: 'flex', alignItems: 'center', gap: GAP.lg,
          }}>
            <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.h2, fontWeight: 700, color: COLOR.text, letterSpacing: '0.02em' }}>
              {fresh.code}
            </span>
            {fresh.grant_lifetime_usd && <Chip color={COLOR.blue}>试用 {usd(fresh.grant_lifetime_usd)}</Chip>}
            <IconBtn title="复制" onClick={() => copy(fresh.code)}><Copy size={13} /></IconBtn>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>已复制，直接粘贴发出去</span>
          </div>
        )}
      </div>

      {!invites ? (
        <div style={emptyStyle}>加载中…</div>
      ) : invites.length === 0 ? (
        <div style={emptyStyle}>还没有邀请码。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
          {invites.map(inv => {
            const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
            const exhausted = inv.used_count >= inv.max_uses;
            const open = !expired && !exhausted;
            const names = usedBy.get(inv.code) || [];
            return (
              <div key={inv.code} style={{
                background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xl,
                boxShadow: PAPER_SHADOW.far,
                padding: `${GAP.md}px ${GAP.lg}px`,
                display: 'flex', alignItems: 'center', gap: GAP.lg, flexWrap: 'wrap',
                opacity: open ? 1 : 0.6,
              }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, fontWeight: 600, color: COLOR.text }}>
                  {inv.code}
                </span>
                <IconBtn title="复制" onClick={() => copy(inv.code)}><Copy size={12} /></IconBtn>
                <Chip color={open ? COLOR.success : COLOR.dim}>{expired ? '已过期' : exhausted ? '已用完' : '可用'}</Chip>
                {inv.grant_lifetime_usd && <Chip color={COLOR.blue}>试用 {usd(inv.grant_lifetime_usd)}</Chip>}
                {editCode === inv.code ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: GAP.sm }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{inv.used_count}/</span>
                    <input
                      type="number" min="0" autoFocus
                      value={editUses}
                      onChange={e => setEditUses(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !isImeEnter(e)) saveUses(inv); if (e.key === 'Escape') setEditCode(null); }}
                      style={{
                        width: 64, padding: `${GAP.xxs}px ${GAP.sm}px`,
                        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text,
                        background: COLOR.bgWhite, border: `1px solid ${COLOR.borderHv}`, borderRadius: RADIUS.md, outline: 'none',
                        boxShadow: PAPER_SHADOW.far,
                      }}
                    />
                    <PrimaryBtn onClick={() => saveUses(inv)}>改</PrimaryBtn>
                    <GhostBtn onClick={() => setEditCode(null)}>取消</GhostBtn>
                  </span>
                ) : (
                  <button
                    title="改总次数（0 = 封死这个码）"
                    onClick={() => { setEditCode(inv.code); setEditUses(String(inv.max_uses)); }}
                    style={{
                      fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                      background: 'transparent', border: 0, cursor: 'pointer', padding: `${GAP.xxs}px ${GAP.xs}px`,
                      borderRadius: RADIUS.sm, textDecoration: 'underline dotted', textUnderlineOffset: 3,
                    }}
                  >{inv.used_count}/{inv.max_uses}</button>
                )}
                <span style={{ flex: 1, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text4, minWidth: 120 }}>
                  {names.length > 0
                    ? `${names.slice(0, 4).join('、')}${names.length > 4 ? ` 等 ${names.length} 人` : ''}`
                    : '尚无人使用'}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim }}>
                  {timeAgo(inv.created_at) || inv.created_at}
                  {inv.expires_at && !expired && ` · ${new Date(inv.expires_at).toLocaleDateString()} 到期`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 公告 ──────────────────────────────────────────────────────────────

// 与 QuotaBanner 的横幅底色同源（BANNER token）—— 预览必须长得和用户实际看到的一样
const NOTICE_BG = BANNER;

function NoticesTab() {
  const showToast = useGlobalStore(s => s.showToast);
  const [data, setData] = useState(null);
  const [body, setBody] = useState('');
  const [level, setLevel] = useState('info');
  const [hours, setHours] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    Admin.notices().then(setData).catch(err => showToast(`拉取失败：${err.message}`, 'error'));
  }, [showToast]);
  useEffect(load, [load]);

  const post = async () => {
    if (!body.trim()) { showToast('公告内容不能为空', 'error'); return; }
    setPosting(true);
    try {
      await Admin.createNotice({
        body: body.trim(),
        level,
        ...(hours !== '' && Number(hours) > 0 ? { expiresInHours: Number(hours) } : {}),
      });
      showToast('公告已发布，全站 60s 内可见', 'success');
      setBody('');
      load();
    } catch (err) {
      showToast(`发布失败：${err.message}`, 'error');
    }
    setPosting(false);
  };

  const retire = async (id) => {
    try {
      await Admin.retireNotice(id);
      showToast('已下架', 'success');
      load();
    } catch (err) { showToast(`下架失败：${err.message}`, 'error'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.xl }}>
      <div style={{
        background: COLOR.bgCard, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xxl,
        padding: `${GAP.xl}px ${GAP.xl}px`,
      }}>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="要跟大家说什么？（重启预告 / 更新说明 / 出了什么事）"
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            padding: `${GAP.md}px ${GAP.lg}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text, lineHeight: 1.6,
            background: COLOR.bgWhite, border: `1px solid ${COLOR.borderMd}`, borderRadius: RADIUS.xl, outline: 'none',
            boxShadow: PAPER_SHADOW.far,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: GAP.xl, flexWrap: 'wrap', marginTop: GAP.md }}>
          <Field label="级别">
            <Segmented value={level} onChange={setLevel} options={[
              ['info', '通知'], ['warn', '留意'], ['alert', '警报'],
            ]} />
          </Field>
          <Field label="时效（小时，留空 = 挂到手动下架）">
            <NumInput value={hours} onChange={setHours} placeholder="—" />
          </Field>
          <PrimaryBtn onClick={post} disabled={posting}>
            <Send size={12} style={{ marginRight: 5, verticalAlign: -1 }} />
            {posting ? '发布中…' : '发布'}
          </PrimaryBtn>
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.md }}>
          一次只有一条生效，发新的等于覆盖旧的；用户关掉后不会再弹同一条。
        </div>
      </div>

      {data?.active && (
        <div>
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.sm }}>
            当前挂着的（用户视角）：
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: GAP.base,
            padding: `${GAP.md}px ${GAP.lg}px`, borderRadius: RADIUS.lg, maxWidth: 560,
            background: NOTICE_BG[data.active.level] || NOTICE_BG.info,
            color: COLOR.bgWhite, fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, lineHeight: 1.5,
          }}>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{data.active.body}</span>
            <button
              onClick={() => retire(data.active.id)}
              title="下架"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, padding: 0, flexShrink: 0,
                background: 'rgba(255,254,246,0.16)', color: COLOR.bgWhite,
                border: 'none', borderRadius: RADIUS.sm, cursor: 'pointer',
              }}
            ><X size={12} /></button>
          </div>
        </div>
      )}

      {data && data.notices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
          {data.notices.map(n => (
            <div key={n.id} style={{
              background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.xl,
              boxShadow: PAPER_SHADOW.far,
              padding: `${GAP.md}px ${GAP.lg}px`,
              display: 'flex', alignItems: 'center', gap: GAP.lg,
              opacity: n.active ? 1 : 0.55,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: RADIUS.round, flexShrink: 0,
                background: NOTICE_BG[n.level] || NOTICE_BG.info,
              }} />
              <span style={{
                flex: 1, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{n.body}</span>
              <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim, flexShrink: 0 }}>
                {timeAgo(n.createdAt) || n.createdAt}{!n.active && ' · 已下架'}
              </span>
              {n.active && (
                <IconBtn title="下架" onClick={() => retire(n.id)} danger><X size={13} /></IconBtn>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 内容外审 ──────────────────────────────────────────────────────────

// 类别中文（与 server/lib/moderation.js 的 category 对齐）
const FLAG_CATEGORY = {
  sexual_minors: '未成年人色情', sexual_explicit: '色情', violence: '暴力',
  terrorism: '恐怖主义', weapons: '武器制作', drugs: '毒品', crime: '犯罪教程',
  self_harm: '自残自杀', hate: '仇恨歧视', harassment: '骚扰人肉',
  malware: '恶意软件', other: '其他违规',
};

function ModerationTab({ users }) {
  const [flags, setFlags] = useState(null);
  const showToast = useGlobalStore(s => s.showToast);
  const nameOf = useMemo(() => {
    const m = new Map((users || []).map(u => [u.id, u.username]));
    return (id) => m.get(id) || id;
  }, [users]);

  const load = useCallback(() => {
    Admin.moderation().then(d => setFlags(d.flags))
      .catch(err => { showToast(`拉取失败：${err.message}`, 'error'); setFlags([]); });
  }, [showToast]);
  useEffect(load, [load]);

  const remove = async (id) => {
    try { await Admin.removeFlag(id); load(); }
    catch (err) { showToast(`删除失败：${err.message}`, 'error'); }
  };

  if (!flags) return <div style={emptyStyle}>加载中…</div>;
  if (flags.length === 0) return <div style={emptyStyle}>没有拦截记录。</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
      {flags.map(f => (
        <div key={f.id} style={{
          background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`,
          boxShadow: PAPER_SHADOW.far,
          borderLeft: `3px solid ${f.severity === 'critical' ? COLOR.error : COLOR.warn}`,
          borderRadius: RADIUS.xl, padding: `${GAP.md}px ${GAP.lg}px`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 600, color: COLOR.text }}>
              {nameOf(f.userId)}
            </span>
            <Chip color={f.severity === 'critical' ? COLOR.error : COLOR.warn}>
              {FLAG_CATEGORY[f.category] || f.category}
            </Chip>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim }}>
              {f.level === 'loose' ? '宽松档拦下' : '严格档拦下'}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              {timeAgo(f.createdAt) || f.createdAt}
            </span>
            <span style={{ flex: 1 }} />
            <IconBtn title="删除这条记录" onClick={() => remove(f.id)} danger><Trash2 size={13} /></IconBtn>
          </div>
          {f.reason && (
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, marginTop: GAP.sm, lineHeight: 1.6 }}>
              {f.reason}
            </div>
          )}
          <div style={{
            marginTop: GAP.sm, padding: `${GAP.sm}px ${GAP.md}px`,
            background: 'rgba(43,33,23,0.025)', borderRadius: RADIUS.lg,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {f.excerpt || '（无摘录）'}
          </div>
        </div>
      ))}
    </div>
  );
}

const emptyStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`,
  textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};
