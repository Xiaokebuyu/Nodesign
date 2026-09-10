// web/src/routes/Setup.jsx — 首启引导：登录之后、进首页之前，把该装的外部程序装上。
// 组件清单和进度都从服务端来（/api/local/components，runtime/components.js）；这一页只负责列出来、点安装、轮询。
// 「稍后再说」写 prefs.setupDone，以后在设置 → 组件 里补装。
import { useEffect, useState, useCallback } from 'react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_KAI, RADIUS } from '../lib/theme.js';
import { Local } from '../lib/api.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Btn, Err } from '../components/local/primitives.jsx';
import { Badge, Button, Progress, Note } from '../components/settings/ui.jsx';
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
  const size = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  return (
    <div>
      {rows.map((c, i) => {
        const job = c.job; const active = ACTIVE.has(job?.status);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: GAP.xl, padding: `${GAP.lg}px ${compact ? GAP.lg : GAP.xxl}px`, borderTop: i === 0 ? 0 : '1px solid rgba(43,33,23,0.08)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: GAP.md, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.lg, color: COLOR.text }}>{c.label}</span>
                {c.required && <Badge tone="warn">{t('必需')}</Badge>}
                {c.sizeMb != null && <span style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.text4 }}>{size(c.sizeMb)}</span>}
              </div>
              <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.md, color: COLOR.text4, marginTop: 2, lineHeight: 1.6 }}>{c.uses}</div>
              {active && (
                <div style={{ marginTop: GAP.sm, maxWidth: 420 }}>
                  <Progress value={job.progress || 0} height={4} />
                  <div style={{ fontFamily: FONT_KAI, fontSize: FONT_SIZE.sm, color: COLOR.text4, marginTop: 4 }}>{stageLabel(job)}</div>
                </div>
              )}
              {job?.status === 'error' && <div style={{ marginTop: GAP.xs }}><Note tone="bad">{job.error}</Note></div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexShrink: 0 }}>
              {c.installed && !active && (
                c.outdated
                  ? <Badge tone="warn">{t('有更新')}</Badge>
                  : <Badge tone="ok">{t('已安装')}{c.installedVersion ? ` · ${c.installedVersion}` : ''}</Badge>
              )}
              {/* 装着的那份跟清单对不上就给一颗「更新」（09-10 rembg 那次：包里补了 C++ 运行库，
                  只看"装没装"的话，装过的用户永远拿不到修好的包）。装是覆盖式的，不用先卸。 */}
              {c.installed && c.outdated && !active && <Button size="sm" variant="primary" onClick={() => install(c.id)}>{t('更新')}</Button>}
              {!c.installed && !active && job?.status !== 'error' && <Button size="sm" variant="primary" onClick={() => install(c.id)}>{t('安装')}</Button>}
              {c.installed && !active && !compact && uninstall && <Button size="sm" variant="ghost" onClick={() => uninstall(c.id)}>{t('卸载')}</Button>}
              {job?.status === 'error' && <Button size="sm" onClick={() => install(c.id)}>{t('重试')}</Button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function stageLabel(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  if (job.status === 'probing') return t('正在测试下载源速度…');
  const src = job.source === 'mirror' ? ` · ${t('镜像')}` : job.source === 'official' ? ` · ${t('官方源')}` : '';
  if (job.status === 'downloading') return `${t('下载中')} ${pct}%${job.total ? ` · ${mb(job.bytes || 0)} / ${mb(job.total)}` : ''}${src}`;
  if (job.status === 'verifying') return t('校验中');
  if (job.status === 'extracting') return t('解压中');
  return `${t('安装中')} ${pct}%`;
}

/**
 * 引导页上的「装到哪」（09-08 站主确认：开头就能选盘，不只是设置页）。装之前换位置最省事 —— 这时候还没东西要搬。
 * 桌面版走系统选择框；没有选择框的环境给一个输入框。
 */
function InstallLocation({ data, onChanged }) {
  const [loc, setLoc] = useState(null);
  const [manual, setManual] = useState('');
  const [err, setErr] = useState('');
  const load = () => Local.componentsLocation().then((r) => { setLoc(r.location); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const relocation = data?.relocation || null;
  useEffect(() => { if (relocation?.status === 'done') { load(); onChanged?.(); } }, [relocation?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  const relocate = async (dir) => { if (!dir) return; try { await Local.relocateComponents(dir); setManual(''); await load(); } catch (e) { setErr(e.message); } };
  const pick = async () => { const d = window.nodesignDesktop; if (!d?.pickFolder) return; const dir = await d.pickFolder().catch(() => null); if (dir) relocate(dir); };
  const moving = relocation?.status === 'moving';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: GAP.sm, padding: `${GAP.sm}px 0 ${GAP.md}px`, borderBottom: `1px solid ${COLOR.borderLt}`, marginBottom: GAP.md, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3 }}>
      <span>{t('装到：')}</span>
      <span style={{ fontFamily: 'ui-monospace, monospace', color: COLOR.text2, wordBreak: 'break-all' }}>{loc?.dir || '…'}</span>
      {loc && !loc.custom && <span style={{ color: COLOR.sub }}>{t('（默认，在 NoDesign 的数据目录里）')}</span>}
      {window.nodesignDesktop?.pickFolder
        ? <Button size="sm" variant="ghost" onClick={pick} disabled={moving}>{t('换个位置')}</Button>
        : (
          <>
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t('绝对路径')} style={{ minWidth: 220, padding: '3px 8px', font: 'inherit' }} />
            <Button size="sm" variant="ghost" onClick={() => relocate(manual.trim())} disabled={!manual.trim() || moving}>{t('用这个')}</Button>
          </>
        )}
      {moving && <span style={{ color: COLOR.sub }}>{t('正在搬：{done} / {total}', { done: relocation.done, total: relocation.total })}</span>}
      {err && <span style={{ color: COLOR.error }}>{err}</span>}
    </div>
  );
}

export default function Setup() {
  const showToast = useGlobalStore((s) => s.showToast);
  const { data, err, busy, install, reload } = useComponents();
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
          {t('以下是 NoDesign 需要使用的外部程序，首次使用需先下载。全部安装后功能最完整；也可以先跳过，之后在「设置 → 组件」中补装。')}
        </p>
        <div style={{ background: COLOR.bgWhite, borderRadius: RADIUS.lg, padding: GAP.lg }}>
          {err && <Err>{err}</Err>}
          {data?.manifestError && <Err>{t('组件清单拉不到：{err}', { err: data.manifestError })}</Err>}
          <InstallLocation data={data} onChanged={reload} />
          {!data ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span> : <ComponentRows data={data} install={install} compact />}
        </div>
        <div style={{ display: 'flex', gap: GAP.md, marginTop: GAP.lg, alignItems: 'center' }}>
          {missing.length > 0 && <Btn primary onClick={installAll} disabled={busy}>{t('全部安装（{n} 个）', { n: missing.length, count: missing.length })}</Btn>}
          <span style={{ flex: 1 }} />
          <Btn onClick={finish} disabled={busy}>{missing.length === 0 ? t('完成并进入') : t('暂不安装，直接进入')}</Btn>
        </div>
      </div>
    </div>
  );
}
