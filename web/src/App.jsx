import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './routes/Home.jsx';
import Project from './routes/Project.jsx';
import DesignSystemList from './routes/DesignSystemList.jsx';
import DesignSystemNew from './routes/DesignSystemNew.jsx';
import DesignSystemDetail from './routes/DesignSystemDetail.jsx';
import SkillList from './routes/SkillList.jsx';
import ToastContainer from './components/ui/ToastContainer.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/projects/:id', element: <Project /> },
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
