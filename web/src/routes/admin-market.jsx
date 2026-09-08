import { useState, useEffect, useCallback } from 'react';
import { Check, X, Star, StarOff, Ban, ChevronDown, ChevronUp } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { AdminMarket } from '../lib/api-market.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { timeAgo } from '../lib/helpers.js';
import { Segmented } from './Issues.jsx';
import { PAPER_SHADOW } from '../lib/paper.js';
import { Chip, GhostBtn, IconBtn, NumInput } from '../components/admin/primitives.jsx';

/**
 * admin-market — 控制台的「市场」tab（2026-09-08）
 *
 * 发布进来一律待审，站主在这里看三样再判：参考图（等于替作者公开了那件东西长什么样）、
 * SKILL.md 全文（它会整段进安装者的 agent 上下文，审的就是这段文字）、作者说明。
 * 加精 = 进所有人首页的项目区，rank 小的靠前；只有已通过的能加精。
 * 撤销（revoked）跟拒绝的区别：已经上过货架、可能有人装过；刀 2 会让已装的那份在下个会话失效。
 *
 * 全是站主一个人看的页面，文案不进词表（跟控制台其它 tab 同口径）。
 */

const STATE_LABEL = { pending: '待审', approved: '已通过', rejected: '已拒绝', withdrawn: '作者撤回', revoked: '已撤销', all: '全部' };
const STATE_COLOR = { pending: COLOR.warn, approved: COLOR.success, rejected: COLOR.error, withdrawn: COLOR.sub, revoked: COLOR.error };

export function MarketTab() {
  const [state, setState] = useState('pending');
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const showToast = useGlobalStore(s => s.showToast);

  const load = useCallback(() => {
    AdminMarket.list(state).then(d => { setItems(d.items); setCounts(d.counts || {}); })
      .catch(err => { showToast(`拉取失败：${err.message}`, 'error'); setItems([]); });
  }, [state, showToast]);
  useEffect(load, [load]);

  const options = ['pending', 'approved', 'rejected', 'withdrawn', 'revoked', 'all']
    .map(s => [s, counts[s] != null && s !== 'all' ? `${STATE_LABEL[s]} ${counts[s]}` : STATE_LABEL[s]]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
        <Segmented value={state} onChange={setState} options={options} onDesk />
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: `var(--desk-pencil, ${COLOR.sub})` }}>
          看全文再判：SKILL.md 会整段进安装者的 agent 上下文。
        </span>
      </div>
      {!items && <div style={emptyStyle}>加载中…</div>}
      {items && items.length === 0 && <div style={emptyStyle}>{state === 'pending' ? '没有待审的发布。' : '这一档是空的。'}</div>}
      {items && items.map(p => <PublicationCard key={p.id} pub={p} reload={load} />)}
    </div>
  );
}

function PublicationCard({ pub, reload }) {
  const [open, setOpen] = useState(false);
  const [skillMd, setSkillMd] = useState(null);
  const [rank, setRank] = useState(pub.featuredRank ?? '');
  const [busy, setBusy] = useState(false);
  const showToast = useGlobalStore(s => s.showToast);

  useEffect(() => { setRank(pub.featuredRank ?? ''); }, [pub.featuredRank]);
  useEffect(() => {
    if (!open || skillMd !== null) return;
    AdminMarket.get(pub.id).then(d => setSkillMd(d.skillMd || '')).catch(err => setSkillMd(`（拉不到全文：${err.message}）`));
  }, [open, skillMd, pub.id]);

  const act = async (fn, okText) => {
    setBusy(true);
    try { await fn(); if (okText) showToast(okText, 'success'); reload(); }
    catch (err) { showToast(`操作失败：${err.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const review = (state) => {
    const note = state === 'approved' ? '' : window.prompt(state === 'rejected' ? '拒绝理由（作者看得到，可空）' : '撤销理由（可空）') ?? null;
    if (note === null) return;
    return act(() => AdminMarket.review(pub.id, state, note || undefined), `已${STATE_LABEL[state]}`);
  };
  const feature = () => {
    const n = rank === '' ? null : Number(rank);
    if (n !== null && !Number.isInteger(n)) return showToast('顺序要填整数', 'error');
    return act(() => AdminMarket.setFeatured(pub.id, n), n === null ? '已取消精选' : `已加精（顺序 ${n}）`);
  };

  const images = Array.from({ length: pub.imageCount || 0 }, (_, i) => AdminMarket.imageUrl(pub.id, i));
  return (
    <div style={{
      background: COLOR.bgWhite, border: `1px solid ${COLOR.border}`, boxShadow: PAPER_SHADOW.far,
      borderLeft: `3px solid ${STATE_COLOR[pub.state] || COLOR.border}`,
      borderRadius: RADIUS.xl, padding: `${GAP.md}px ${GAP.lg}px`,
    }}>
      <div style={{ display: 'flex', gap: GAP.lg, alignItems: 'flex-start' }}>
        {images[0] && (
          <img src={images[0]} alt="" style={{ width: 160, aspectRatio: '16 / 10', objectFit: 'cover', objectPosition: 'top', borderRadius: RADIUS.lg, border: `1px solid ${COLOR.border}`, flex: 'none' }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.md, fontWeight: 600, color: COLOR.text }}>{pub.title}</span>
            <Chip color={STATE_COLOR[pub.state] || COLOR.sub}>{STATE_LABEL[pub.state] || pub.state}</Chip>
            {pub.featuredRank != null && <Chip color={COLOR.warn}>精选 #{pub.featuredRank}</Chip>}
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              {pub.author?.username} · {pub.source === 'desktop' ? '桌面版' : '网页'} · {timeAgo(pub.createdAt) || pub.createdAt} · 装了 {pub.installCount} 次
            </span>
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2, marginTop: GAP.xs }}>
            {pub.skillName}@{pub.skillVersion || '0.0.0'}
            {pub.skillDescription && <span style={{ color: COLOR.sub }}> — {pub.skillDescription}</span>}
          </div>
          {pub.note && <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, marginTop: GAP.sm, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{pub.note}</div>}
          {pub.reviewNote && <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: GAP.xs }}>批注：{pub.reviewNote}</div>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, marginTop: GAP.md, flexWrap: 'wrap' }}>
        <GhostBtn onClick={() => setOpen(o => !o)}>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? '收起全文' : '看 SKILL.md 全文'}</GhostBtn>
        <span style={{ flex: 1 }} />
        {pub.state === 'pending' && <>
          <IconBtn title="通过" onClick={() => !busy && review('approved')}><Check size={14} /></IconBtn>
          <IconBtn title="拒绝" onClick={() => !busy && review('rejected')} danger><X size={14} /></IconBtn>
        </>}
        {pub.state === 'approved' && <>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>精选顺序</span>
          <div style={{ width: 72 }}><NumInput value={rank} onChange={setRank} placeholder="空=不精选" /></div>
          <IconBtn title={rank === '' ? '取消精选' : '加精 / 改顺序'} onClick={() => !busy && feature()}>{rank === '' ? <StarOff size={14} /> : <Star size={14} />}</IconBtn>
          <IconBtn title="撤销（下架；已装的那份下个会话失效）" onClick={() => !busy && review('revoked')} danger><Ban size={14} /></IconBtn>
        </>}
        {pub.state === 'rejected' && <IconBtn title="改判通过" onClick={() => !busy && review('approved')}><Check size={14} /></IconBtn>}
      </div>

      {open && (
        <div style={{ marginTop: GAP.md }}>
          {images.length > 1 && (
            <div style={{ display: 'flex', gap: GAP.sm, overflowX: 'auto', marginBottom: GAP.md }}>
              {images.map(src => <img key={src} src={src} alt="" style={{ height: 140, borderRadius: RADIUS.lg, border: `1px solid ${COLOR.border}`, flex: 'none' }} />)}
            </div>
          )}
          <pre style={{
            margin: 0, padding: `${GAP.md}px ${GAP.lg}px`, background: 'rgba(43,33,23,0.025)', borderRadius: RADIUS.lg,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.text2, lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 520, overflow: 'auto',
          }}>{skillMd === null ? '加载中…' : skillMd || '（空）'}</pre>
        </div>
      )}
    </div>
  );
}

const emptyStyle = {
  padding: `${GAP.page}px ${GAP.xl}px`, textAlign: 'center',
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: `var(--desk-pencil, ${COLOR.sub})`,
};
