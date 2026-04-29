import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './routes/Home.jsx';
import Project from './routes/Project.jsx';
import DesignSystemList from './routes/DesignSystemList.jsx';
import SkillList from './routes/SkillList.jsx';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/projects/:id', element: <Project /> },
  { path: '/design-systems', element: <DesignSystemList /> },
  { path: '/skills', element: <SkillList /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
