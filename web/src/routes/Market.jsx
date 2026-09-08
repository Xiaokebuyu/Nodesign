import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Store, Download, Check, Trash2, LayoutTemplate, Copy } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { TOP_ACTION_STYLE as iconBtnStyle } from '../components/layout/TopBar.jsx';
import { Desk } from './desk.jsx';
import { DayToggle } from './home-light.jsx';
import Modal from '../components/ui/Modal.jsx';
import MarkdownText from '../components/chat/MarkdownText.jsx';
import { paperCard, PAPER } from '../lib/paper.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { Market as MarketApi } from '../lib/api-market.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { useMedia, NARROW } from '../lib/use-media.js';
import { useHoverReveal } from '../lib/use-hover-reveal.js';
import { timeAgo } from '../lib/helpers.js';
import { t } from '../lib/i18n.js';

/**
 * Market — skill 市场（/market，2026-09-08）
 *
 * 货架上一条 = 别人发布的 skill + 几张它做出来的东西的截图。不带产物：你拿走的是方法论，
 * 不是成品。装到自己的 skill 库里，下个新会话点名就能用（跟自己 crystallize 出来的一样）。
 *
 * 上架前站主逐条看过 SKILL.md 全文和图 —— 这是「陌生人的 SKILL.md 会整段进你 agent 上下文」
 * 那条顾虑的答案：不是不开，是人审。装了之后站主撤回的，下个会话自动不再加载。
 *
 * /market/:id 打开详情（同一页上的弹窗），关掉回 /market。
 * 桌面版走同一页：api-market.js 按部署形态换前缀，本机转站点。
 */
const STATE_LABEL = () => ({ pending: t('待审'), approved: t('已上架'), rejected: t('没通过'), withdrawn: t('已撤回'), revoked: t('已下架') });

export default function Market() {
  const [items, setItems] = useState(null);
  const [mine, setMine] = useState([]);
  const { id: openId } = useParams();
  const navigate = useNavigate();
  const narrow = useMedia(NARROW);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const isLocal = useGlobalStore(s => s.authProfile) === 'local';
  // 桌面版的 authUser 是本机的 _anon，但发布记录里的 author 是站点账号 —— 站点那侧返回的 mine 列表才是「我的」判据
  const mineIds = new Set(mine.map(p => p.id));

  const load = useCallback(() => {
    MarketApi.list().then(d => setItems(d.items || [])).catch(err => {
      setItems([]);
      showToast(err.code === 'RELAY_NOT_CONFIGURED' ? t('先在设置里登录站点账号，市场才能用') : t('市场拉取失败：{err}', { err: err.message }), 'error');
    });
    MarketApi.mine().then(d => setMine(d.items || [])).catch(() => setMine([]));
  }, [showToast]);
  useEffect(load, [load]);

  // 照着来一个（v2，09-08 晚）：不复制别人的产物，开新项目 + 参考图 + skill，进工作台自动发一句开工提示词（agent 会先对齐）
  const fork = async (pub) => {
    try {
      const r = await MarketApi.fork(pub.id);
      navigate(`/projects/${r.projectId}/work`, { state: { initialMessage: r.prompt } });
    } catch (err) {
      showToast(err.code === 'WEB_ONLY' ? t('桌面版暂不支持照着来一个，请在网页端操作') : t('没开成：{err}', { err: err.message }), 'error');
    }
  };

  const install = async (pub, { force = false } = {}) => {
    try {
      await MarketApi.install(pub.id, { force });
      showToast(t('装好了。下个新会话起 agent 就认识它了。'), 'success');
      load();
      return true;
    } catch (err) {
      if (err.status === 409 && !force) {
        const ok = await confirm({
          title: t('覆盖已装的同名 skill？'),
          message: t('你已经装了一个叫「{name}」的 skill。覆盖后旧的那份就没了。', { name: pub.skillName }),
          confirmLabel: t('覆盖'), danger: true,
        });
        if (ok) return install(pub, { force: true });
        return false;
      }
      showToast(t('安装失败：{err}', { err: err.message }), 'error');
      return false;
    }
  };

  const withdraw = async (pub) => {
    if (!(await confirm({ title: t('撤回这条发布？'), message: t('货架上不再展示「{title}」。已经装了的人手里那份不受影响。', { title: pub.title }), confirmLabel: t('撤回'), danger: true }))) return;
    try { await MarketApi.withdraw(pub.id); showToast(t('已撤回'), 'info'); load(); }
    catch (err) { showToast(t('撤回失败：{err}', { err: err.message }), 'error'); }
  };

  const pendingMine = mine.filter(p => p.state !== 'approved');

  return (
    <AppShell
      breadcrumb={[{ label: t('Skill 市场') }]}
      actions={
        <>
          <Link to="/gallery" style={iconBtnStyle} title={t('我的橱窗')} aria-label={t('我的橱窗')}>
            <LayoutTemplate size={14} />{narrow ? null : ` ${t('我的橱窗')}`}
          </Link>
          <DayToggle style={iconBtnStyle} compact={narrow} />
        </>
      }
    >
      <Desk>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: narrow ? `${GAP.xxl}px ${GAP.lg}px` : `${GAP.page}px ${GAP.page}px` }}>
        <header style={{ marginBottom: GAP.xxl + 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginBottom: GAP.sm }}>
            <Store size={18} color={COLOR.gold} />
            <h1 style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700, color: 'var(--desk-ink)', letterSpacing: '-0.01em', margin: 0 }}>{t('Skill 市场')}</h1>
          </div>
          <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: 'var(--desk-ink-2)', lineHeight: 1.6, margin: 0, maxWidth: 680 }}>
            {t('别人探索出来的方法论，连同它做出来的东西的样子。装进自己的 skill 库，下个新会话点名就能用。装之前先看一眼 SKILL.md 全文，装了之后它会整段进你 agent 的上下文。')}
          </p>
        </header>

        {pendingMine.length > 0 && (
          <section style={{ marginBottom: GAP.xxl }}>
            <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, letterSpacing: '0.12em', color: 'var(--desk-pencil, ' + COLOR.sub + ')', marginBottom: GAP.sm }}>{t('我发的')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.sm }}>
              {pendingMine.map(p => (
                <div key={p.id} style={{ ...paperCard('far'), padding: `${GAP.md}px ${GAP.lg}px`, display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{p.title}</span>
                  <StatePill state={p.state} />
                  {p.reviewNote && <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('站主批注：{note}', { note: p.reviewNote })}</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{timeAgo(p.createdAt)}</span>
                  {p.state === 'pending' && <button onClick={() => withdraw(p)} title={t('撤回')} style={ghostIcon}><Trash2 size={12} /></button>}
                </div>
              ))}
            </div>
          </section>
        )}

        {items === null ? (
          <div style={loadingStyle}>{t('加载中…')}</div>
        ) : items.length === 0 ? (
          <div style={loadingStyle}>{t('货架还是空的。橱窗里的作品可以发上来，发布即上架。')}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: narrow ? GAP.lg : GAP.xl }}>
            {items.map(p => <MarketCard key={p.id} pub={p} onOpen={() => navigate(`/market/${p.id}`)} onInstall={() => install(p)} onFork={() => fork(p)} />)}
          </div>
        )}
      </div>
      </Desk>

      <DetailModal id={openId} onClose={() => navigate('/market')} onInstall={install} onFork={fork} onWithdraw={withdraw} isLocal={isLocal} isMine={openId ? mineIds.has(openId) : false} />
    </AppShell>
  );
}

function StatePill({ state }) {
  const color = state === 'approved' ? COLOR.success : state === 'pending' ? COLOR.warn : COLOR.sub;
  return (
    <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color, padding: '1px 7px', border: `1px solid ${color}`, borderRadius: RADIUS.pill, whiteSpace: 'nowrap' }}>
      {STATE_LABEL()[state] || state}
    </span>
  );
}

function MarketCard({ pub, onOpen, onInstall, onFork }) {
  const { hover, hoverProps } = useHoverReveal();
  return (
    <div {...hoverProps} style={{
      ...paperCard(hover ? 'near' : 'mid'), overflow: 'hidden', position: 'relative',
      transform: hover ? 'translateY(-3px)' : 'none', transition: 'all 0.28s cubic-bezier(0.25, 1, 0.5, 1)',
      display: 'flex', flexDirection: 'column', cursor: 'pointer',
    }} onClick={onOpen}>
      <div style={{ aspectRatio: '16 / 10', background: COLOR.bgCard, overflow: 'hidden', borderBottom: `1px solid ${COLOR.borderLt}` }}>
        <img src={MarketApi.imageUrl(pub.id, 0)} alt={pub.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }} />
      </div>
      <div style={{ padding: `${GAP.lg}px ${GAP.lg}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.sm, flex: 1 }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600, color: COLOR.text }}>{pub.title}</div>
        {pub.note && <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{pub.note}</div>}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.sm, marginTop: GAP.sm }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pub.author?.username} · {t('{n} 人装过', { n: pub.installCount || 0 })}
          </span>
          <button onClick={(e) => { e.stopPropagation(); onFork(); }} title={t('照着来一个')} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: RADIUS.md, border: `1px solid ${COLOR.border}`, background: 'transparent', color: COLOR.text2, cursor: 'pointer', flexShrink: 0,
          }}>
            <Copy size={12} /><span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs }}>{t('照着来一个')}</span>
          </button>
          {pub.hasSkill !== false && <button onClick={(e) => { e.stopPropagation(); if (!pub.installed) onInstall(); }} title={pub.installed ? t('已装') : t('装到我的 skill 库')} style={{
            ...ghostIcon, display: 'inline-flex', alignItems: 'center', gap: GAP.xs, padding: `${GAP.xxs}px ${GAP.sm}px`,
            color: pub.installed ? COLOR.success : COLOR.text2, borderColor: pub.installed ? COLOR.success : COLOR.border, flexShrink: 0,
          }}>
            {pub.installed ? <Check size={12} /> : <Download size={12} />}
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs }}>{pub.installed ? t('已装') : t('安装')}</span>
          </button>}
        </div>
      </div>
      {pub.featuredRank != null && (
        <span style={{ position: 'absolute', top: GAP.sm, left: GAP.sm, fontFamily: FONT_KAI, fontSize: FONT_SIZE.xs, color: PAPER.red, border: `1.5px solid ${PAPER.red}`, borderRadius: 3, padding: '1px 6px', background: 'rgba(255,254,246,0.85)', transform: 'rotate(-6deg)' }}>{t('精选')}</span>
      )}
    </div>
  );
}

function DetailModal({ id, onClose, onInstall, onFork, onWithdraw, isLocal, isMine }) {
  const [data, setData] = useState(null);
  const [shot, setShot] = useState(0);
  useEffect(() => {
    if (!id) { setData(null); return; }
    let dead = false;
    setShot(0);
    MarketApi.get(id).then(d => { if (!dead) setData(d); }).catch(err => { if (!dead) setData({ error: err.message }); });
    return () => { dead = true; };
  }, [id]);
  const pub = data?.publication;
  const installed = pub ? (isLocal ? data.installedLocally : pub.installed) : false;
  const images = pub ? Array.from({ length: pub.imageCount || 0 }, (_, i) => MarketApi.imageUrl(pub.id, i)) : [];
  return (
    <Modal show={!!id} onClose={onClose} title={pub?.title || t('加载中…')} width={780}>
      {data?.error && <div style={loadingStyle}>{data.error}</div>}
      {pub && (
        <div style={{ padding: `${GAP.lg}px ${GAP.xl}px`, display: 'flex', flexDirection: 'column', gap: GAP.lg, maxHeight: '70vh', overflow: 'auto' }}>
          {images.length > 0 && (
            <div>
              <img src={images[shot]} alt="" style={{ width: '100%', borderRadius: RADIUS.lg, border: `1px solid ${PAPER.hair}`, display: 'block' }} />
              {images.length > 1 && (
                <div style={{ display: 'flex', gap: GAP.xs, marginTop: GAP.sm }}>
                  {images.map((src, i) => <img key={src} src={src} alt="" onClick={() => setShot(i)} style={{ width: 72, height: 45, objectFit: 'cover', borderRadius: RADIUS.sm, cursor: 'pointer', border: `2px solid ${i === shot ? PAPER.ink : 'transparent'}` }} />)}
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.brown }}>{pub.hasSkill === false ? t('作品') : `${pub.skillName}@${pub.skillVersion || '0.0.0'}`}</span>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{pub.author?.username} · {timeAgo(pub.createdAt)} · {t('{n} 人装过', { n: pub.installCount || 0 })}</span>
            {pub.state && pub.state !== 'approved' && <StatePill state={pub.state} />}
            <span style={{ flex: 1 }} />
            {pub.state === 'approved' && (
              <button onClick={() => onFork(pub)} style={primaryBtn} title={t('开一个新项目：参考图放进去、有 skill 就装上，agent 先跟你对齐再做')}>
                <Copy size={13} /> {t('照着来一个')}
              </button>
            )}
            {pub.state === 'approved' && pub.hasSkill !== false && (
              <button onClick={() => !installed && onInstall(pub)} style={{ ...primaryBtn, opacity: installed ? 0.6 : 1, cursor: installed ? 'default' : 'pointer' }}>
                {installed ? <><Check size={13} /> {t('已装')}</> : <><Download size={13} /> {t('装到我的 skill 库')}</>}
              </button>
            )}
            {isMine && ['pending', 'approved'].includes(pub.state) && (
              <button onClick={() => onWithdraw(pub)} style={ghostIcon} title={t('撤回')}><Trash2 size={13} /></button>
            )}
          </div>
          {pub.note && <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{pub.note}</div>}
          {pub.hasSkill !== false && <div>
            <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, letterSpacing: '0.12em', color: PAPER.pencil, marginBottom: GAP.sm }}>{t('SKILL.md 全文（装了之后 agent 读到的就是这段）')}</div>
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, color: COLOR.text, lineHeight: 1.7, padding: `${GAP.md}px ${GAP.lg}px`, background: 'rgba(43,33,23,0.025)', borderRadius: RADIUS.lg }}>
              <MarkdownText>{data.skillMd || ''}</MarkdownText>
            </div>
          </div>}
        </div>
      )}
    </Modal>
  );
}

const ghostIcon = {
  background: 'transparent', border: `1px solid ${COLOR.border}`, borderRadius: RADIUS.pill,
  color: COLOR.sub, cursor: 'pointer', padding: `${GAP.xxs}px ${GAP.sm}px`, display: 'inline-flex', alignItems: 'center',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  padding: `${GAP.sm}px ${GAP.lg}px`, fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, letterSpacing: '0.06em',
  color: '#fff', background: PAPER.ink, border: 0, borderRadius: 2, cursor: 'pointer',
};
const loadingStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`, textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: 'var(--desk-pencil, ' + COLOR.sub + ')',
};
