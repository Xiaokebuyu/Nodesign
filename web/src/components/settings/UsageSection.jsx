// 设置 → 用量：近 30 天每日花费，站点账本和本机两条叠着画；点一根柱子看当天按模型拆。纯 SVG，不引图表库。
import { useEffect, useMemo, useState } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Card, Err } from '../local/primitives.jsx';
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

  const total = days.reduce((a, d) => a + (series.local.get(d) || 0) + (series.site.get(d) || 0), 0);
  const max = Math.max(0.01, ...days.map((d) => (series.local.get(d) || 0) + (series.site.get(d) || 0)));
  const W = 720; const H = 160; const pad = 24; const bw = (W - pad * 2) / DAYS;

  return (
    <Card>
      {err && <Err>{err}</Err>}
      {data?.site?.error && <Err>{t('站点账本读不到：{err}', { err: data.site.error })}</Err>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2, marginBottom: GAP.sm }}>
        <span>{t('近 {n} 天', { n: DAYS })}</span>
        <span style={{ fontFamily: FONT_MONO, color: COLOR.text }}>${total.toFixed(2)}</span>
        <span style={{ flex: 1 }} />
        <Legend color={COLOR.btn} label={isLocal ? t('站点账本') : t('本站')} />
        {isLocal && <Legend color={COLOR.dim} label={t('本机（自己的钥匙）')} />}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg width={W} height={H + 28} style={{ display: 'block', fontFamily: FONT_SANS }}>
          {days.map((d, i) => {
            const s = series.site.get(d) || 0; const l = series.local.get(d) || 0;
            const hs = (s / max) * H; const hl = (l / max) * H;
            const x = pad + i * bw + 1;
            return (
              <g key={d} onPointerEnter={() => setPicked(d)} onClick={() => setPicked(d)} style={{ cursor: 'pointer' }}>
                <rect x={x} y={0} width={bw - 2} height={H} fill="transparent" />
                <rect x={x} y={H - hs} width={bw - 2} height={hs} fill={COLOR.btn} opacity={picked === d ? 1 : 0.85} />
                <rect x={x} y={H - hs - hl} width={bw - 2} height={hl} fill={COLOR.dim} opacity={picked === d ? 1 : 0.85} />
                {(i % 5 === 0 || i === DAYS - 1) && <text x={x + (bw - 2) / 2} y={H + 16} textAnchor="middle" fontSize="10" fill={COLOR.sub}>{d.slice(5)}</text>}
              </g>
            );
          })}
          <line x1={pad} x2={W - pad} y1={H} y2={H} stroke={COLOR.borderLt} />
        </svg>
      </div>
      <div style={{ minHeight: 44, marginTop: GAP.sm, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text3 }}>
        {picked ? (
          <>
            <span style={{ fontFamily: FONT_MONO, color: COLOR.text }}>{picked}</span>
            {' · '}
            {(series.byDay.get(picked) || []).sort((a, b) => b.cost - a.cost).map((m) => `${m.model}${m.src ? `（${m.src}）` : ''} $${m.cost.toFixed(3)}`).join('　') || t('没有花费')}
          </>
        ) : <span style={{ color: COLOR.sub }}>{t('点一根柱子看当天按模型拆')}</span>}
      </div>
    </Card>
  );
}

function pushModel(byDay, r, src) {
  const list = byDay.get(r.day) || [];
  const hit = list.find((x) => x.model === r.model && x.src === src);
  if (hit) hit.cost += Number(r.costUsd) || 0; else list.push({ model: r.model, src, cost: Number(r.costUsd) || 0 });
  byDay.set(r.day, list);
}

function Legend({ color, label }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FONT_SIZE.xs, color: COLOR.sub }}><span style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />{label}</span>;
}
