import { Suspense, lazy } from 'react'
import { Link, Navigate, createBrowserRouter, useRouteError } from 'react-router'

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

/** A render error shows a way out, not a stack trace (React Router's
 * default error screen). The error still reaches the console for us. */
function RouteError() {
  const error = useRouteError()
  return (
    <div className="page">
      <header className="page__header">
        <h1>Something went wrong</h1>
      </header>
      <p className="task-error" role="alert">
        {error instanceof Error ? error.message : 'An unexpected error interrupted this page.'}
      </p>
      <p className="page__note">
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>{' '}
        or go back to the <Link to="/">dashboard</Link>.
      </p>
    </div>
  )
}

export const router = createBrowserRouter([
  {
    element: <PlatformShell />,
    errorElement: <RouteError />,
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
    errorElement: <RouteError />,
    element: (
      <Suspense fallback={<div className="route-fallback">Loading workspace…</div>}>
        <App />
      </Suspense>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
