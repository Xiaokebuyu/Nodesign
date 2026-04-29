import { COLOR } from '../../lib/theme.js';
import TopBar from './TopBar.jsx';

/**
 * AppShell — 整站外壳：顶栏 + 主内容
 *
 * 用于所有路由的根容器。各路由通过 props 配置顶栏内容。
 */
export default function AppShell({ breadcrumb, status, actions, children }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: COLOR.bg,
    }}>
      <TopBar breadcrumb={breadcrumb} status={status} actions={actions} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
