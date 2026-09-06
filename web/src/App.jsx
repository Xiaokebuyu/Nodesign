import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import Home from './routes/Home.jsx';
import ProjectWorkspace from './routes/ProjectWorkspace.jsx';
import SkillList from './routes/SkillList.jsx';
import Showcase from './routes/Showcase.jsx';
import Issues from './routes/Issues.jsx';
import AdminConsole from './routes/AdminConsole.jsx';
import Settings from './routes/Settings.jsx';
import Devices from './routes/Devices.jsx';
import ToastContainer from './components/ui/ToastContainer.jsx';
import GlobalDialogs from './components/ui/GlobalDialogs.jsx';
import QuotaBanner from './components/layout/QuotaBanner.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  // 项目只剩一张工作台（2026-07-28：ProjectHub 控制台页退役 —— 记忆 / 指引 /
  // 品牌 / 文件回到桌面顶带的"项目区"，会话列表归左栏会话头）
  //   /projects/:id              → 重定向到 /work
  //   /projects/:id/work         → ProjectWorkspace（无 sid，新会话；首跑后 navigate replace 到 /sessions/:sid）
  //   /projects/:id/sessions/:sid → ProjectWorkspace（带 sid，恢复某次会话）
  { path: '/projects/:id', element: <Navigate to="work" replace /> },
  { path: '/projects/:id/work', element: <ProjectWorkspace /> },
  { path: '/projects/:id/sessions/:sid', element: <ProjectWorkspace /> },
  { path: '/skills', element: <SkillList /> },
  // 橱窗取代了假模板市场（2026-07-30）：卡片是用户自己做出来的作品 + 那次探索
  // 固化出来的 skill。/templates 是旧地址，留个重定向别让老链接 404。
  { path: '/gallery', element: <Showcase /> },
  { path: '/templates', element: <Navigate to="/gallery" replace /> },
  // 内测控制台（admin 用；后端 adminGuard 兜底，非 admin 进来只会看到报错空态）
  { path: '/admin', element: <AdminConsole /> },
  // 问题库独立页保留 —— 老链接不 404，控制台里也有同一份（tab）
  { path: '/admin/issues', element: <Issues /> },
  // 本地分发版设置（08-22）：钥匙 / 模型插槽 / 本机能力 / 重启。hosted 下后端没有 /api/local，页面只会看到空态
  { path: '/settings', element: <Settings /> },
  { path: '/devices', element: <Devices /> },          // hosted：桌面版设备令牌（本地版没有账号，这页 404 也无妨）
]);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ToastContainer />
      <GlobalDialogs />
      <QuotaBanner />
    </>
  );
}
