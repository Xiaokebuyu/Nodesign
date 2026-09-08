// 设置 → MCP（2026-09-08）：NoDesign 作为 MCP 服务端的第一段——运行质量检查。
// 这里只给三样：地址、令牌（可复制）、一条 `claude mcp add` 连法；下面顺手显示健康一览，
// 用户不用连 MCP 也能看到本机哪些外部程序在、relay 登没登、有没有回合在飞。
// ⚠️ 令牌就是钥匙：谁拿到谁就能看这台机器上所有项目的运行情况（只读）。远程给别人看要走隧道，别开到公网。
import { useEffect, useState } from 'react';
import { Panel, Block, Row, Button, Note, Mono, Badge } from './ui.jsx';
import { Local } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

export default function McpSection() {
  const [info, setInfo] = useState(null);
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState(null);
  const [reveal, setReveal] = useState(false);
  const load = () => {
    Local.mcp().then(setInfo).catch((e) => setErr(e.message));
    Local.health().then(setHealth).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const caps = health?.capabilities || [];
  const missing = caps.filter((c) => !c.available);
  return (
    <>
      <Panel title={t('MCP 服务端')} desc={t('把 NoDesign 的运行情况开放给 Claude Code、Codex 这类 agent（只读：健康、项目、进程、回合、日志）。画布工具还没开放。')}
        aside={<Button size="sm" variant="ghost" onClick={load}>{t('刷新')}</Button>}>
        {err && <Block><Note tone="bad">{err}</Note></Block>}
        {info && (
          <>
            <Row label={t('地址')} desc={t('只在本机监听。要给别处的人看，用 ssh -R 之类的隧道把这个端口带过去')} first>
              <Mono copy>{info.url}</Mono>
            </Row>
            <Row label={t('令牌')} desc={t('请求头 Authorization: Bearer <令牌>。它是钥匙，别贴到公开的地方')}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Mono copy>{reveal ? info.token : '•'.repeat(12)}</Mono>
                <Button size="sm" variant="ghost" onClick={() => setReveal((v) => !v)}>{reveal ? t('隐藏') : t('显示')}</Button>
              </div>
            </Row>
            <Row label={t('接入 Claude Code')} desc={t('终端里跑这一条，之后在 Claude Code 里就能用 health / project_status 这些工具')} stack>
              <Mono copy>{reveal ? info.addCommand : info.addCommand.replace(info.token, '•'.repeat(12))}</Mono>
            </Row>
          </>
        )}
      </Panel>
      <Panel title={t('运行健康')} desc={t('MCP 里 health 工具回的就是这一份')}>
        {!health && <Block first><Note>{t('读取中…')}</Note></Block>}
        {health && (
          <>
            <Row label={t('版本')} first><Mono>{health.version || '?'}</Mono></Row>
            <Row label={t('平台')}><Mono>{`${health.platform.os} ${health.platform.arch} · node ${health.platform.node}${health.platform.electron ? ` · electron ${health.platform.electron}` : ''}`}</Mono></Row>
            <Row label={t('站点账号')}>
              {health.relay?.loggedIn ? <Badge tone="ok">{t('已登录')}{health.relay.user?.username ? ` · ${health.relay.user.username}` : ''}</Badge> : <Badge tone="warn">{t('未登录')}</Badge>}
              {health.relay?.error && <Note tone="bad">{health.relay.error}</Note>}
            </Row>
            <Row label={t('在飞回合')}><Mono>{String(health.activeRuns)}</Mono></Row>
            <Row label={t('内存')}><Mono>{`rss ${health.memoryMB.rss} MB · heap ${health.memoryMB.heapUsed} MB`}</Mono></Row>
            <Row label={t('外部程序')} desc={missing.length ? t('缺的这些对应功能不可用，去「组件」页装') : t('全部就绪')} stack>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {caps.map((c) => <Badge key={c.id} tone={c.available ? 'ok' : (c.level === 'required' ? 'bad' : 'warn')}>{c.id}</Badge>)}
              </div>
            </Row>
          </>
        )}
      </Panel>
    </>
  );
}
