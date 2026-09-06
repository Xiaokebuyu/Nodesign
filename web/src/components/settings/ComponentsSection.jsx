// 设置 → 组件：清单里的外部程序（装 / 卸 / 进度）+ 能力表（探到没探到）。行组件跟首启引导页共用（routes/Setup.jsx）。
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { Card, Err, Btn } from '../local/primitives.jsx';
import CapabilityTable from '../local/CapabilityTable.jsx';
import { useComponents, ComponentRows } from '../../routes/Setup.jsx';
import { t } from '../../lib/i18n.js';

export default function ComponentsSection({ status, onStatus }) {
  const { data, err, install, uninstall, reload } = useComponents();
  const reprobe = async () => { const r = await fetch('/api/local/components/reprobe', { method: 'POST' }).then((x) => x.json()); onStatus?.({ capabilities: r.capabilities }); reload(); };
  return (
    <>
      <Card style={{ marginBottom: GAP.md }}>
        {err && <Err>{err}</Err>}
        {data?.manifestError && <Err>{t('组件清单拉不到：{err}', { err: data.manifestError })}</Err>}
        {!data ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span> : <ComponentRows data={data} install={install} uninstall={uninstall} />}
        <div style={{ marginTop: GAP.md, display: 'flex', gap: GAP.sm, alignItems: 'center' }}>
          <Btn small onClick={reprobe}>{t('重探')}</Btn>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{t('自己装在别处的程序只要在 PATH 里也认')}</span>
        </div>
      </Card>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.sm }}>{t('能力表：每一项管着哪些工具')}</div>
      <CapabilityTable capabilities={status?.capabilities} />
    </>
  );
}
