// 设置 → 高级：状态 / 路径、其他钥匙与开关（搜索、发布、沙盒、权限模式）、重启
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../lib/theme.js';
import { Card, Btn } from '../local/primitives.jsx';
import EnvKeys from '../local/EnvKeys.jsx';
import { t } from '../../lib/i18n.js';

export default function AdvancedSection({ status, onStatus, restart, restarting, showToast }) {
  return (
    <>
      <Card style={{ marginBottom: GAP.md }}>
        {!status ? <span style={{ color: COLOR.sub, fontSize: FONT_SIZE.sm }}>{t('读取中…')}</span> : (
          <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, display: 'grid', gridTemplateColumns: '120px 1fr', gap: `${GAP.xs}px ${GAP.lg}px` }}>
            <span>{t('版本')}</span><span style={{ fontFamily: FONT_MONO }}>nodesign {status.version} · pid {status.pid}</span>
            <span>{t('数据目录')}</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.dataRoot}</span>
            <span>{t('配置文件')}</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.configPath}</span>
            <span>{t('日志')}</span><span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{status.dataRoot}/logs/server.log</span>
            <span>{t('插槽问题')}</span><span>{status.modelConfigErrors?.length ? status.modelConfigErrors.map((e, i) => <div key={i} style={{ color: COLOR.error }}>{e.where}: {e.message}</div>) : t('无')}</span>
          </div>
        )}
        <div style={{ marginTop: GAP.md }}><Btn small onClick={restart} disabled={restarting || !status}>{restarting ? t('重启中…') : t('重启服务端')}</Btn></div>
      </Card>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginBottom: GAP.sm }}>{t('写进 {path}/.env，钥匙类保存即生效', { path: status?.dataRoot || '~/.nodesign' })}</div>
      <EnvKeys exclude={['模型', 'NoDesign 服务']} showToast={showToast} onCapabilities={(caps) => onStatus?.({ capabilities: caps })} />
    </>
  );
}
