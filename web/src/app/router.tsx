import { Suspense, lazy } from 'react'
import { Navigate, createBrowserRouter } from 'react-router'

import { DashboardPage } from '../pages/DashboardPage'
import { DataCatalogPage } from '../pages/DataCatalogPage'
import { DatasetDetailsPage } from '../pages/DatasetDetailsPage'
import { ProjectOverviewPage } from '../pages/ProjectOverviewPage'
import { ProjectsPage } from '../pages/ProjectsPage'
import { TasksPage } from '../pages/TasksPage'
import { AnalysisPage } from '../pages/AnalysisPage'
import { ExportsPage } from '../pages/ExportsPage'
import { PlatformShell } from './PlatformShell'

// The workspace chunk carries the whole map engine; nothing outside this
// lazy boundary may import `ol` or `ag-grid` (IA acceptance §9.3).
const App = lazy(() => import('../App').then((module) => ({ default: module.App })))

export const router = createBrowserRouter([
  {
    element: <PlatformShell />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/projects', element: <ProjectsPage /> },
      { path: '/projects/:projectId', element: <ProjectOverviewPage /> },
      { path: '/data', element: <DataCatalogPage /> },
      { path: '/data/:layerId/*', element: <DatasetDetailsPage /> },
      { path: '/tasks', element: <TasksPage /> },
      { path: '/analysis', element: <AnalysisPage /> },
      { path: '/exports', element: <ExportsPage /> },
    ],
  },
  // The map workspace keeps its own chrome (WorkspaceShell in R3); it is a
  // sibling of the platform shell, not a child.
  {
    path: '/projects/:projectId/map',
    element: (
      <Suspense fallback={<div className="route-fallback">Loading workspace…</div>}>
        <App />
      </Suspense>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
