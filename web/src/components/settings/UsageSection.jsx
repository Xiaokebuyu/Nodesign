// 设置 → 用量：近 30 天摘要（总额 / 今日 / 最贵的一天）+ 每日柱状图（站点账本与本机两条叠着画）。
// 纯 SVG，不引图表库。点/指一根柱子看当天按模型拆。
import { useEffect, useMemo, useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_KAI, FONT_MONO } from '../../lib/theme.js';
import { Panel, Block, Note } from './ui.jsx';
import { t } from '../../lib/i18n.js';

const DAYS = 30;
const dayKey = (d) => d.toISOString().slice(0, 10);

export default function UsageSection({ isLocal }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState(null);   // 点/指到的那天（触屏上是点，鼠标是指）
  useEffect(() => {
    fetch(`/api/me/usage/daily?days=${DAYS}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData).catch((e) => setErr(e.message));
  }, []);

  const days = useMemo(() => {
    const out = [];
    const now = new Date(Date.now() + 8 * 3600 * 1000);   // 服务端日界是 +08:00
    for (let i = DAYS - 1; i >= 0; i--) out.push(dayKey(new Date(now.getTime() - i * 86400000)));
    return out;
  }, []);
  const series = useMemo(() => {
    const local = new Map(); const site = new Map(); const byDay = new Map();
    const add = (map, r) => map.set(r.day, (map.get(r.day) || 0) + (Number(r.costUsd) || 0));
    for (const r of data?.local || []) { add(local, r); pushModel(byDay, r, isLocal ? t('本机') : ''); }
    for (const r of (Array.isArray(data?.site) ? data.site : [])) { add(site, r); pushModel(byDay, r, t('站点')); }
    return { local, site, byDay };
  }, [data, isLocal]);

  const dayTotal = (d) => (series.local.get(d) || 0) + (series.site.get(d) || 0);
  const total = days.reduce((a, d) => a + dayTotal(d), 0);
  const today = dayTotal(days[DAYS - 1]);
  const peak = days.reduce((m, d) => (dayTotal(d) > dayTotal(m) ? d : m), days[0]);
  const max = Math.max(0.01, ...days.map(dayTotal));
  const W = 720; const H = 150; const pad = 20; const bw = (W - pad * 2) / DAYS;
  const empty = !!data && total === 0;
  // 站点账本那一半拉不到只是少一条线，不是整页出错：一句浅色提示就够
  const siteErr = data?.site?.error || null;

  return (
    <>
      <Panel>
        <Block first>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: GAP.xl }}>
            <Stat label={t('近 {n} 天', { n: DAYS })} value={`$${total.toFixed(2)}`} />
            <Stat label={t('今日')} value={`$${today.toFixed(2)}`} />
            <Stat label={t('最贵的一天')} value={total > 0 ? `$${dayTotal(peak).toFixed(2)}` : '—'} sub={total > 0 ? peak.slice(5).replace('-', '/') : ''} />
          </div>
        </Block>
      </Panel>
      <Panel title={t('每日花费')} desc={t('把鼠标停在柱子上看那天按模型怎么拆')}
        aside={<div style={{ display: 'flex', gap: GAP.lg, paddingTop: 4 }}>
          <Legend color={COLOR.btn} label={isLocal ? t('站点账本') : t('本站')} />
          {isLocal && <Legend color={COLOR.dim} label={t('本机（自己的钥匙）')} />}
        </div>}>
        <Block first style={{ paddingTop: GAP.sm }}>
          {err && <Note tone="bad">{t('用量读不到：{err}', { err })}</Note>}
          {siteErr && <Note tone="warn">{t('站点账本暂时读不到：{err}', { err: siteErr })}</Note>}
          {!data && !err && <Note>{t('读取中…')}</Note>}
          {empty && <Note>{t('这 30 天还没有花费。开一个会话用起来，这里就会有曲线。')}</Note>}
          <div style={{ overflowX: 'auto', opacity: empty ? 0.5 : 1 }}>
            <svg width={W} height={H + 26} style={{ display: 'block', fontFamily: FONT_KAI }} viewBox={`0 0 ${W} ${H + 26}`}>
              {days.map((d, i) => {
                const s = series.site.get(d) || 0; const l = series.local.get(d) || 0;
                const hs = (s / max) * H; const hl = (l / max) * H;
                const x = pad + i * bw + 1.5;
                const on = picked === d;
                return (
                  <g key={d} onPointerEnter={() => setPicked(d)} onClick={() => setPicked(d)} style={{ cursor: 'pointer' }}>
                    <rect x={x} y={0} width={bw - 3} height={H} fill={on ? 'rgba(43,33,23,0.05)' : 'transparent'} />
                    <rect x={x} y={H - hs} width={bw - 3} height={hs} fill={COLOR.btn} opacity={on ? 1 : 0.8} rx={1} />
                    <rect x={x} y={H - hs - hl} width={bw - 3} height={hl} fill={COLOR.dim} opacity={on ? 1 : 0.8} rx={1} />
                    {(i % 5 === 0 || i === DAYS - 1) && <text x={x + (bw - 3) / 2} y={H + 16} textAnchor="middle" fontSize="10" fill={COLOR.text4}>{d.slice(5).replace('-', '/')}</text>}
                  </g>
                );
              })}
              <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="rgba(43,33,23,0.12)" />
            </svg>
          </div>
          <div style={{ minHeight: 40, marginTop: GAP.sm, fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text3, lineHeight: 1.7 }}>
            {picked ? (
              <>
                <span style={{ fontFamily: FONT_MONO, color: COLOR.text }}>{picked}</span>
                <span style={{ margin: `0 ${GAP.sm}px` }}>·</span>
                {(series.byDay.get(picked) || []).sort((a, b) => b.cost - a.cost).map((m) => `${m.model}${m.src ? `（${m.src}）` : ''} $${m.cost.toFixed(3)}`).join('　') || t('没有花费')}
              </>
            ) : null}
          </div>
        </Block>
      </Panel>
    </>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4 }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: COLOR.text, marginTop: 2, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.text4, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function pushModel(byDay, r, src) {
  const list = byDay.get(r.day) || [];
  const hit = list.find((x) => x.model === r.model && x.src === src);
  if (hit) hit.cost += Number(r.costUsd) || 0; else list.push({ model: r.model, src, cost: Number(r.costUsd) || 0 });
  byDay.set(r.day, list);
}

function Legend({ color, label }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.text4 }}><span style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />{label}</span>;
}
