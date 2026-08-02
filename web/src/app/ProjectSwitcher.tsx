import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'

import { listProjects } from '../api/layers'

/**
 * The topbar's project selector. Replaces the old hard-wired `projects[0]`:
 * the current project is whatever the route says, and switching navigates —
 * project identity lives in the URL, not in a store.
 */
export function ProjectSwitcher({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  if (!projects.data || projects.data.length === 0) return null

  return (
    <select
      className="project-switcher"
      aria-label="Switch project"
      value={projectId}
      onChange={(event) => void navigate(`/projects/${event.target.value}/map`)}
    >
      {projects.data.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  )
}
