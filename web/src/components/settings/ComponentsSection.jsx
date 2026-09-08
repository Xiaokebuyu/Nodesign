// 设置 → 组件：清单里的外部程序（装 / 卸 / 进度）。行组件跟首启引导页共用（routes/Setup.jsx）。
// 能力表 09-07 下架（站主：用户装完依赖就够了，那张表是 npm 时代的产物）；重新检测收成一个小按钮。
// 09-08 站主：外部程序不能只装 C 盘 —— 加「安装位置」（换了把已装的搬过去）和「额外搜索目录」（自己装在别处的）。
import { useEffect, useState } from 'react';
import { Panel, Block, Row, Button, Note, Mono } from './ui.jsx';
import { useComponents, ComponentRows } from '../../routes/Setup.jsx';
import { Local } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

const desktop = () => (typeof window !== 'undefined' && window.nodesignDesktop) || null;

export default function ComponentsSection({ onStatus }) {
  const { data, err, install, uninstall, reload } = useComponents();
  const [loc, setLoc] = useState(null);          // { location:{dir,defaultDir,custom}, extraBinDirs }
  const [locErr, setLocErr] = useState('');
  const [manual, setManual] = useState('');
  const [extraDraft, setExtraDraft] = useState('');
  const loadLoc = () => Local.componentsLocation().then((r) => { setLoc(r); setLocErr(''); }).catch((e) => setLocErr(e.message));
  useEffect(() => { loadLoc(); }, []);
  const reprobe = async () => { const r = await fetch('/api/local/components/reprobe', { method: 'POST' }).then((x) => x.json()); onStatus?.({ capabilities: r.capabilities }); reload(); };
  const relocation = data?.relocation || null;
  // 搬完刷新一次位置
  useEffect(() => { if (relocation?.status === 'done') { loadLoc(); reprobe(); } }, [relocation?.status]);   // eslint-disable-line react-hooks/exhaustive-deps

  const relocate = async (dir) => {
    if (!dir) return;
    try { await Local.relocateComponents(dir); setManual(''); await reload(); await loadLoc(); } catch (e) { setLocErr(e.message); }
  };
  const pickAndRelocate = async () => {
    const d = desktop();
    if (!d?.pickFolder) return;
    const dir = await d.pickFolder().catch(() => null);
    if (dir) relocate(dir);
  };
  const saveExtra = async (dirs) => {
    try { const r = await Local.setExtraBinDirs(dirs); setLoc((v) => ({ ...(v || {}), extraBinDirs: r.extraBinDirs })); onStatus?.({ capabilities: r.capabilities }); setExtraDraft(''); reload(); } catch (e) { setLocErr(e.message); }
  };
  const addExtra = async () => {
    const d = desktop();
    let dir = extraDraft.trim();
    if (!dir && d?.pickFolder) dir = (await d.pickFolder().catch(() => null)) || '';
    if (!dir) return;
    saveExtra([...(loc?.extraBinDirs || []), dir]);
  };

  return (
    <>
      <Panel title={t('外部程序')} desc={t('全部安装后功能最完整。已安装在其他位置的程序，只要在 PATH 中即可识别。')}
        aside={<Button size="sm" variant="ghost" onClick={reprobe} title={t('手动安装程序后点击此处，让 NoDesign 重新检测')}>{t('重新检测')}</Button>}>
        {err && <Block><Note tone="bad">{err}</Note></Block>}
        {data?.manifestError && <Block><Note tone="warn">{t('组件清单获取失败：{err}', { err: data.manifestError })}</Note></Block>}
        {!data && <Block first><Note>{t('读取中…')}</Note></Block>}
        {data && !(data.components || []).some((c) => c.supported) && <Block first><Note>{t('当前系统无需单独安装外部程序。')}</Note></Block>}
        {data && <ComponentRows data={data} install={install} uninstall={uninstall} />}
      </Panel>
      <Panel title={t('安装位置')} desc={t('从这里下载的外部程序装在哪。换位置会把已装的搬过去，正在安装时不能换。')}>
        {locErr && <Block><Note tone="bad">{locErr}</Note></Block>}
        <Row label={t('当前')} desc={loc?.location?.custom ? t('自定义位置') : t('默认：数据目录下的 components')} first>
          <Mono copy>{loc?.location?.dir || '…'}</Mono>
        </Row>
        <Row label={t('换到')} desc={relocation?.status === 'moving' ? t('正在搬：{done} / {total}', { done: relocation.done, total: relocation.total }) : relocation?.status === 'error' ? t('上次搬运失败：{err}', { err: relocation.error }) : t('比如 D:\\NoDesign\\components')} stack>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {desktop()?.pickFolder && <Button size="sm" onClick={pickAndRelocate} disabled={relocation?.status === 'moving'}>{t('选一个文件夹')}</Button>}
            <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t('或直接填绝对路径')} style={{ minWidth: 260, padding: '4px 8px', font: 'inherit' }} />
            <Button size="sm" variant="ghost" onClick={() => relocate(manual.trim())} disabled={!manual.trim() || relocation?.status === 'moving'}>{t('搬过去')}</Button>
            {loc?.location?.custom && <Button size="sm" variant="ghost" onClick={() => relocate(loc.location.defaultDir)} disabled={relocation?.status === 'moving'}>{t('搬回默认')}</Button>}
          </div>
        </Row>
      </Panel>
      <Panel title={t('额外搜索目录')} desc={t('已经装在别处的程序（LibreOffice、ffmpeg、git…），把它们的可执行文件所在目录加进来，检测时先搜这些，不用再装一份。')}>
        {(loc?.extraBinDirs || []).map((d) => (
          <Row key={d} label={<Mono>{d}</Mono>}>
            <Button size="sm" variant="ghost" onClick={() => saveExtra((loc.extraBinDirs || []).filter((x) => x !== d))}>{t('移除')}</Button>
          </Row>
        ))}
        <Row label={t('添加')} desc={t('比如 D:\\LibreOffice\\program')} first={!(loc?.extraBinDirs || []).length} stack>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={extraDraft} onChange={(e) => setExtraDraft(e.target.value)} placeholder={t('目录的绝对路径')} style={{ minWidth: 260, padding: '4px 8px', font: 'inherit' }} />
            <Button size="sm" onClick={addExtra}>{desktop()?.pickFolder && !extraDraft.trim() ? t('选一个文件夹') : t('添加')}</Button>
          </div>
        </Row>
      </Panel>
    </>
  );
}
