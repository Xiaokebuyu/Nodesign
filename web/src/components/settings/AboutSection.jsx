// 设置 → 关于：版本 / 检查更新 / 数据目录 / 日志 / 重启；「开发者选项」折叠（其他钥匙与开关、插槽问题、配置文件）。
// 检查更新与打开文件夹走桌面壳的桥（desktop/preload.cjs 挂的 window.nodesignDesktop）；
// 不在桌面壳里（浏览器开的本地版）就只显示版本，不画按不动的按钮。
import { useState } from 'react';
import { Panel, Row, Block, Button, Mono, Disclosure, Note } from './ui.jsx';
import EnvKeys from '../local/EnvKeys.jsx';
import { t } from '../../lib/i18n.js';

const bridge = () => (typeof window !== 'undefined' ? window.nodesignDesktop : null) || null;

export default function AboutSection({ status, onStatus, restart, restarting, showToast }) {
  const [checking, setChecking] = useState(false);
  const [updateNote, setUpdateNote] = useState('');
  const d = bridge();

  const checkUpdates = async () => {
    setChecking(true); setUpdateNote('');
    try { const r = await d.checkForUpdates(); setUpdateNote(r?.message || ''); }
    catch (e) { setUpdateNote(t('检查更新失败：{err}', { err: e.message })); }
    finally { setChecking(false); }
  };
  const openDir = async (p) => { try { await d.openPath(p); } catch (e) { showToast?.(e.message, 'error'); } };

  if (!status) return <Panel><Block first><Note>{t('读取中…')}</Note></Block></Panel>;
  const logPath = `${status.dataRoot}/logs/server.log`;
  return (
    <>
      <Panel>
        <Row first label={t('版本')} desc={updateNote || (d ? t('桌面版会自己检查更新，装好后重开生效') : t('浏览器里打开的本地版，更新走 npm'))}>
          <Mono>{`NoDesign ${status.version}`}</Mono>
          {d && <Button size="sm" onClick={checkUpdates} disabled={checking}>{checking ? t('检查中…') : t('检查更新')}</Button>}
        </Row>
        <Row label={t('数据目录')} desc={t('项目、生成的图、对话记录都在这。换电脑把整个目录拷走即可')} stack>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Mono copy>{status.dataRoot}</Mono>
            {d && <Button size="sm" variant="ghost" onClick={() => openDir(status.dataRoot)}>{t('打开文件夹')}</Button>}
          </div>
        </Row>
        <Row label={t('日志')} desc={t('出问题反馈时把这个文件发来')} stack>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Mono copy>{logPath}</Mono>
            {d && <Button size="sm" variant="ghost" onClick={() => openDir(`${status.dataRoot}/logs`)}>{t('打开文件夹')}</Button>}
          </div>
        </Row>
        <Row label={t('重启服务端')} desc={t('改了自定义服务商或卡住不动时用。正在跑的会话会断')}>
          <Button size="sm" onClick={restart} disabled={restarting}>{restarting ? t('重启中…') : t('重启')}</Button>
        </Row>
      </Panel>

      <Panel title={t('开发者选项')} desc={t('联网搜索、发布、沙盒这些钥匙和开关。一般用不着动。')}>
        <Disclosure title={t('钥匙与开关')} desc={t('写进 {path}/.env，钥匙类保存即生效', { path: status.dataRoot })}>
          <EnvKeys exclude={['模型', 'NoDesign 服务']} bare showToast={showToast} onCapabilities={(caps) => onStatus?.({ capabilities: caps })} />
        </Disclosure>
        <Disclosure title={t('诊断')} desc={status.modelConfigErrors?.length ? t('{n} 处问题', { n: status.modelConfigErrors.length, count: status.modelConfigErrors.length }) : t('正常')}>
          <Note>{t('进程')} pid {status.pid}</Note>
          <Note>{t('配置文件')}：<Mono copy>{status.configPath}</Mono></Note>
          {status.modelConfigErrors?.length
            ? status.modelConfigErrors.map((e, i) => <Note key={i} tone="bad">{e.where}: {e.message}</Note>)
            : <Note>{t('插槽问题')}：{t('无')}</Note>}
        </Disclosure>
      </Panel>
    </>
  );
}
