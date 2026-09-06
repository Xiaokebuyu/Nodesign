// web/src/routes/Setup.jsx — 首启引导：登录之后、进首页之前，把该装的外部程序装上。
// 组件清单和进度都从服务端来（/api/local/components，runtime/components.js）；这一页只负责列出来、点安装、轮询。
// 「稍后再说」写 prefs.setupDone，以后在设置 → 组件 里补装。
import { useEffect, useState, useCallback } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_KAI, FONT_MONO, RADIUS } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Btn, Err } from '../components/local/primitives.jsx';
import { t } from '../lib/i18n.js';

const ACTIVE = new Set(['probing', 'downloading', 'verifying', 'extracting', 'installing']);

export function useComponents() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => Local.components().then((d) => { setData(d); setErr(''); return d; }).catch((e) => setErr(e.message)), []);
  useEffect(() => { reload(); }, [reload]);
  // 有任务在跑就 800ms 轮一次；跑完了重探能力表
  const busy = !!data?.components?.some((c) => ACTIVE.has(c.job?.status));
  useEffect(() => {
    if (!busy) return undefined;
    const tm = setInterval(async () => {
      const d = await reload();
      if (d && !d.components.some((c) => ACTIVE.has(c.job?.status))) { try { await Local.componentsReprobe(); } catch { /* */ } }
    }, 800);
    return () => clearInterval(tm);
  }, [busy, reload]);
  const install = async (id) => { try { await Local.installComponent(id); await reload(); } catch (e) { setErr(e.message); } };
  const uninstall = async (id) => { try { await Local.uninstallComponent(id); await reload(); } catch (e) { setErr(e.message); } };
  return { data, err, busy, reload, install, uninstall };
}

export function ComponentRows({ data, install, uninstall, compact = false }) {
  const rows = (data?.components || []).filter((c) => c.supported);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: `${GAP.md}px ${GAP.lg}px`, alignItems: 'center', fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm }}>
      {rows.map((c) => {
        const job = c.job; const active = ACTIVE.has(job?.status);
        return [
          <div key={c.id + 'a'}>
            <span style={{ color: COLOR.text, fontWeight: 600 }}>{c.label}</span>
            {c.required && <span style={{ marginLeft: GAP.sm, fontSize: FONT_SIZE.xs, color: COLOR.warn }}>{t('必需')}</span>}
            {c.sizeMb != null && <span style={{ marginLeft: GAP.sm, fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{c.sizeMb >= 1000 ? `${(c.sizeMb / 1000).toFixed(1)} GB` : `${Math.round(c.sizeMb)} MB`}</span>}
            <div style={{ fontSize: FONT_SIZE.xs, color: COLOR.text4 }}>{c.uses}</div>
            {active && (
              <div style={{ marginTop: 4, height: 4, background: COLOR.borderLt, borderRadius: 2, overflow: 'hidden', maxWidth: 420 }}>
                <div style={{ width: `${Math.round((job.progress || 0) * 100)}%`, height: '100%', background: COLOR.btn, transition: 'width .3s' }} />
              </div>
            )}
            {active && <div style={{ fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 2 }}>{stageLabel(job)}</div>}
            {job?.status === 'error' && <Err>{job.error}</Err>}
          </div>,
          <div key={c.id + 'b'} style={{ display: 'flex', gap: GAP.sm }}>
            {c.installed && !active && <span style={{ fontSize: FONT_SIZE.xs, color: COLOR.success }}>{t('已安装')}{c.installedVersion ? ` · ${c.installedVersion}` : ''}</span>}
            {!c.installed && !active && <Btn small primary onClick={() => install(c.id)}>{t('安装')}</Btn>}
            {c.installed && !active && !compact && uninstall && <Btn small onClick={() => uninstall(c.id)}>{t('卸载')}</Btn>}
            {job?.status === 'error' && <Btn small onClick={() => install(c.id)}>{t('重试')}</Btn>}
          </div>,
        ];
      })}
    </div>
  );
}

function stageLabel(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  if (job.status === 'probing') return t('在测哪个下载源快…');
  const src = job.source === 'mirror' ? ` · ${t('镜像')}` : job.source === 'official' ? ` · ${t('官方源')}` : '';
  if (job.status === 'downloading') return `${t('下载中')} ${pct}%${job.total ? ` · ${mb(job.bytes || 0)} / ${mb(job.total)}` : ''}${src}`;
  if (job.status === 'verifying') return t('校验中');
  if (job.status === 'extracting') return t('解压中');
  return `${t('安装中')} ${pct}%`;
}

export default function Setup() {
  const showToast = useGlobalStore((s) => s.showToast);
  const { data, err, busy, install } = useComponents();
  const missing = (data?.components || []).filter((c) => c.supported && !c.installed);
  const finish = async () => {
    try { await Local.savePrefs({ setupDone: true }); window.location.href = '/'; }
    catch (e) { showToast?.(e.message, 'error'); }
  };
  const installAll = async () => { for (const c of missing) await install(c.id); };
  return (
    <div style={{ minHeight: '100vh', background: COLOR.bg, display: 'flex', justifyContent: 'center', padding: `${GAP.xxl}px ${GAP.xl}px` }}>
      <div style={{ width: 760, maxWidth: '100%' }}>
        <h1 style={{ fontFamily: FONT_KAI, fontSize: 26, color: COLOR.text, margin: `0 0 ${GAP.xs}px` }}>{t('准备工作')}</h1>
        <p style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, margin: `0 0 ${GAP.lg}px` }}>
          {t('这些是 NoDesign 要用到的外部程序，第一次要下载一下。都装上功能最全；先跳过也行，以后在设置 → 组件里补。')}
        </p>
        <div style={{ background: COLOR.bgWhite, borderRadius: RADIUS.lg, padding: GAP.lg }}>
          {err && <Err>{err}</Err>}
          {data?.manifestError && <Err>{t('组件清单拉不到：{err}', { err: data.manifestError })}</Err>}
          {!data ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span> : <ComponentRows data={data} install={install} compact />}
        </div>
        <div style={{ display: 'flex', gap: GAP.md, marginTop: GAP.lg, alignItems: 'center' }}>
          {missing.length > 0 && <Btn primary onClick={installAll} disabled={busy}>{t('全部安装（{n} 个）', { n: missing.length, count: missing.length })}</Btn>}
          <span style={{ flex: 1 }} />
          <Btn onClick={finish} disabled={busy}>{missing.length === 0 ? t('完成，进入') : t('稍后再说，先进入')}</Btn>
        </div>
      </div>
    </div>
  );
}
