import { Navigate, createBrowserRouter } from 'react-router'

import { App } from '../App'
import { DashboardPage } from '../pages/DashboardPage'
import { DataCatalogPage } from '../pages/DataCatalogPage'
import { DatasetDetailsPage } from '../pages/DatasetDetailsPage'
import { ProjectOverviewPage } from '../pages/ProjectOverviewPage'
import { ProjectsPage } from '../pages/ProjectsPage'
import { AnalysisPage, ExportsPage, TasksPage } from '../pages/stubs'
import { PlatformShell } from './PlatformShell'

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
  { path: '/projects/:projectId/map', element: <App /> },
  { path: '*', element: <Navigate to="/" replace /> },
])
