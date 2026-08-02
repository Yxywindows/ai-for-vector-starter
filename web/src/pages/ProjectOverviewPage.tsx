import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'

import { getProject } from '../api/layers'
import { ExtentSketch } from './ExtentSketch'

export function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: Boolean(projectId),
  })

  if (project.isLoading) return <p className="page__empty">Loading project…</p>
  if (!project.data) return <p className="page__empty">Project not found.</p>

  return (
    <div className="page">
      <header className="page__header">
        <h1>{project.data.name}</h1>
        <Link to={`/projects/${projectId}/map`} className="btn-link btn-link--primary">
          Open map workspace ▸
        </Link>
      </header>

      <section aria-label="Layers">
        <h2 className="eyebrow">Layers</h2>
        {project.data.layers.length === 0 ? (
          <p className="page__empty">No layers yet — add one from the map workspace.</p>
        ) : (
          <ul className="row-list">
            {[...project.data.layers]
              .sort((a, b) => b.zIndex - a.zIndex)
              .map((layer) => (
                <li key={layer.id} className="row-list__row">
                  <ExtentSketch extent={layer.extent} />
                  <Link to={`/data/${layer.id}`} className="row-list__name">
                    {layer.name}
                  </Link>
                  <span className="row-list__meta mono">
                    {layer.kind}
                    {layer.geometryType ? ` · ${layer.geometryType}` : ''}
                    {layer.featureCount !== null
                      ? ` · ${layer.featureCount.toLocaleString()} features`
                      : ''}
                  </span>
                  <span className="row-list__meta mono">{layer.visible ? 'visible' : 'hidden'}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  )
}
