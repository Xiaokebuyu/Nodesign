import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './routes/Home.jsx';
import ProjectHub from './routes/ProjectHub.jsx';
import ProjectWorkspace from './routes/ProjectWorkspace.jsx';
import DesignSystemList from './routes/DesignSystemList.jsx';
import DesignSystemNew from './routes/DesignSystemNew.jsx';
import DesignSystemDetail from './routes/DesignSystemDetail.jsx';
import SkillList from './routes/SkillList.jsx';
import ToastContainer from './components/ui/ToastContainer.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  // H1：项目两级页面
  //   /projects/:id              → ProjectHub（控制台：管理 sessions / instructions / memory / files）
  //   /projects/:id/work         → ProjectWorkspace（无 sid，新会话；首跑后 navigate replace 到 /sessions/:sid）
  //   /projects/:id/sessions/:sid → ProjectWorkspace（带 sid，恢复某次会话）
  { path: '/projects/:id', element: <ProjectHub /> },
  { path: '/projects/:id/work', element: <ProjectWorkspace /> },
  { path: '/projects/:id/sessions/:sid', element: <ProjectWorkspace /> },
  { path: '/design-systems', element: <DesignSystemList /> },
  { path: '/design-systems/new', element: <DesignSystemNew /> },
  { path: '/design-systems/:id', element: <DesignSystemDetail /> },
  { path: '/skills', element: <SkillList /> },
]);

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ToastContainer />
    </>
  );
}
