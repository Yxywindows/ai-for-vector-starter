import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'

import { getProject, listProjects } from '../api/layers'
import { ExtentSketch } from './ExtentSketch'

/**
 * R1 shape: overview only, resolved through the cached project queries.
 * R2 gives this page its tabs (metadata/schema/extent/preview/style/…)
 * backed by GET /layers/{id}.
 */
export function DatasetDetailsPage() {
  const { layerId } = useParams<{ layerId: string }>()
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectQueries = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ['project', project.id],
      queryFn: () => getProject(project.id),
    })),
  })

  const match = projectQueries
    .flatMap((query) => {
      const project = query.data
      if (!project) return []
      return project.layers
        .filter((layer) => layer.id === layerId)
        .map((layer) => ({ layer, project }))
    })
    .at(0)

  if (projects.isLoading || projectQueries.some((query) => query.isLoading)) {
    return <p className="page__empty">Loading dataset…</p>
  }
  if (!match) return <p className="page__empty">Dataset not found.</p>

  const { layer, project } = match
  return (
    <div className="page">
      <header className="page__header">
        <h1>{layer.name}</h1>
        <Link to={`/projects/${project.id}/map`} className="btn-link btn-link--primary">
          Open on map ▸
        </Link>
      </header>
      <section className="dataset-overview">
        <ExtentSketch extent={layer.extent} />
        <dl className="kv">
          <div>
            <dt>Kind</dt>
            <dd>{layer.kind}</dd>
          </div>
          <div>
            <dt>Geometry</dt>
            <dd className="mono">{layer.geometryType ?? '—'}</dd>
          </div>
          <div>
            <dt>Features</dt>
            <dd className="mono">{layer.featureCount?.toLocaleString() ?? '—'}</dd>
          </div>
          <div>
            <dt>SRID</dt>
            <dd className="mono">{layer.srid ?? '—'}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>
              <Link to={`/projects/${project.id}`}>{project.name}</Link>
            </dd>
          </div>
          <div>
            <dt>Source file</dt>
            <dd className="mono">{layer.sourceFilename ?? '—'}</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
