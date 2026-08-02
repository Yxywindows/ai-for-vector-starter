import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

import { listProjects } from '../api/layers'

export function ProjectsPage() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  return (
    <div className="page">
      <header className="page__header">
        <h1>Projects</h1>
      </header>
      {projects.data?.length === 0 ? (
        <p className="page__empty">No projects yet.</p>
      ) : (
        <ul className="row-list">
          {projects.data?.map((project) => (
            <li key={project.id} className="row-list__row">
              <Link to={`/projects/${project.id}`} className="row-list__name">
                {project.name}
              </Link>
              <span className="row-list__meta mono">
                {project.layerCount} {project.layerCount === 1 ? 'layer' : 'layers'}
              </span>
              <Link className="row-list__action" to={`/projects/${project.id}/map`}>
                Open map ▸
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
