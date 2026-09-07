// 设置 → 组件：清单里的外部程序（装 / 卸 / 进度）。行组件跟首启引导页共用（routes/Setup.jsx）。
// 能力表 09-07 下架（站主：用户装完依赖就够了，那张表是 npm 时代的产物）；重新检测收成一个小按钮。
import { Panel, Block, Button, Note } from './ui.jsx';
import { useComponents, ComponentRows } from '../../routes/Setup.jsx';
import { t } from '../../lib/i18n.js';

export default function ComponentsSection({ onStatus }) {
  const { data, err, install, uninstall, reload } = useComponents();
  const reprobe = async () => { const r = await fetch('/api/local/components/reprobe', { method: 'POST' }).then((x) => x.json()); onStatus?.({ capabilities: r.capabilities }); reload(); };
  return (
    <Panel title={t('外部程序')} desc={t('全部安装后功能最完整。已安装在其他位置的程序，只要在 PATH 中即可识别。')}
      aside={<Button size="sm" variant="ghost" onClick={reprobe} title={t('手动安装程序后点击此处，让 NoDesign 重新检测')}>{t('重新检测')}</Button>}>
      {err && <Block><Note tone="bad">{err}</Note></Block>}
      {data?.manifestError && <Block><Note tone="warn">{t('组件清单获取失败：{err}', { err: data.manifestError })}</Note></Block>}
      {!data && <Block first><Note>{t('读取中…')}</Note></Block>}
      {data && !(data.components || []).some((c) => c.supported) && <Block first><Note>{t('当前系统无需单独安装外部程序。')}</Note></Block>}
      {data && <ComponentRows data={data} install={install} uninstall={uninstall} />}
    </Panel>
  );
}
