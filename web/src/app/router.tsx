import { useQuery } from '@tanstack/react-query'
import { Navigate, createBrowserRouter } from 'react-router'

import { App } from '../App'
import { listProjects } from '../api/layers'

/**
 * `/` preserves the pre-router behavior explicitly: open the first
 * project's map. It becomes the dashboard in R1.
 */
function HomeRedirect() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  if (projects.isLoading) return <div className="route-fallback">Loading projects…</div>
  const first = projects.data?.[0]
  if (!first) return <div className="route-fallback">No projects yet.</div>
  return <Navigate to={`/projects/${first.id}/map`} replace />
}

export const router = createBrowserRouter([
  { path: '/', element: <HomeRedirect /> },
  { path: '/projects/:projectId/map', element: <App /> },
  { path: '*', element: <Navigate to="/" replace /> },
])
