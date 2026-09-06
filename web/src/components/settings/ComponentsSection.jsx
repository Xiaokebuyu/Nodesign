// 设置 → 组件：清单里的外部程序（装 / 卸 / 进度）。行组件跟首启引导页共用（routes/Setup.jsx）。
// 能力表 09-07 下架（站主：用户装完依赖就够了，那张表是 npm 时代的产物）；重新检测收成一个小按钮。
import { Panel, Block, Button, Note } from './ui.jsx';
import { useComponents, ComponentRows } from '../../routes/Setup.jsx';
import { t } from '../../lib/i18n.js';

export default function ComponentsSection({ onStatus }) {
  const { data, err, install, uninstall, reload } = useComponents();
  const reprobe = async () => { const r = await fetch('/api/local/components/reprobe', { method: 'POST' }).then((x) => x.json()); onStatus?.({ capabilities: r.capabilities }); reload(); };
  return (
    <Panel title={t('外部程序')} desc={t('都装上功能最全。自己装在别处的程序只要在 PATH 里也认。')}
      aside={<Button size="sm" variant="ghost" onClick={reprobe} title={t('自己装了程序之后点一下，让 NoDesign 重新找一遍')}>{t('重新检测')}</Button>}>
      {err && <Block><Note tone="bad">{err}</Note></Block>}
      {data?.manifestError && <Block><Note tone="warn">{t('组件清单拉不到：{err}', { err: data.manifestError })}</Note></Block>}
      {!data && <Block first><Note>{t('读取中…')}</Note></Block>}
      {data && !(data.components || []).some((c) => c.supported) && <Block first><Note>{t('这个系统上没有需要单独安装的程序。')}</Note></Block>}
      {data && <ComponentRows data={data} install={install} uninstall={uninstall} />}
    </Panel>
  );
}
