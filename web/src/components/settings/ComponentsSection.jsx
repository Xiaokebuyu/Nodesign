// 设置 → 组件：本机的 chromium / LibreOffice / ffmpeg / poppler / rembg / git 各自的状态。
// 安装按钮接 runtime/components.js（组件管理器）；没接上之前只显示状态和装法。
import { COLOR, GAP, FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import { Card } from '../local/primitives.jsx';
import CapabilityTable from '../local/CapabilityTable.jsx';
import { t } from '../../lib/i18n.js';

export default function ComponentsSection({ status }) {
  return (
    <>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.sm }}>
        {t('这些是本机的外部程序，缺了对应的能力就不可用。起动时探一次；装好东西后「重启」重探。')}
      </div>
      <Card><CapabilityTable capabilities={status?.capabilities} /></Card>
    </>
  );
}
