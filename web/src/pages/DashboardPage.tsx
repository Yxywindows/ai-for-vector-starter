import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'

import { API_BASE } from '../api/client'
import { getProject, listProjects } from '../api/layers'
import { getOverview } from '../api/system'
import type { Extent } from '../api/types'
import { ExtentSketch } from './ExtentSketch'

/** Captured workspace snapshot when one exists; extent sketch otherwise. */
function ProjectThumb({ id, extent }: { id: string; extent: Extent | null }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <ExtentSketch extent={extent} />
  return (
    <img
      className="extent-sketch"
      src={`${API_BASE}/projects/${id}/thumbnail`}
      alt=""
      onError={() => setFailed(true)}
    />
  )
}

/** Union of a project's layer extents — the card sketch, no map engine. */
function ProjectCard({ id, name, layerCount }: { id: string; name: string; layerCount: number }) {
  const project = useQuery({ queryKey: ['project', id], queryFn: () => getProject(id) })
  const union = (project.data?.layers ?? [])
    .map((layer) => layer.extent)
    .filter((extent): extent is Extent => extent !== null)
    .reduce<Extent | null>(
      (acc, extent) =>
        acc === null
          ? extent
          : [
              Math.min(acc[0], extent[0]),
              Math.min(acc[1], extent[1]),
              Math.max(acc[2], extent[2]),
              Math.max(acc[3], extent[3]),
            ],
      null,
    )

  return (
    <article className="card">
      <ProjectThumb id={id} extent={union} />
      <h3 className="card__title">{name}</h3>
      <p className="card__meta">
        {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
      </p>
      <div className="card__actions">
        <Link to={`/projects/${id}`}>Overview</Link>
        <Link to={`/projects/${id}/map`} className="card__primary">
          Open map ▸
        </Link>
      </div>
    </article>
  )
}

export function DashboardPage() {
  const overview = useQuery({ queryKey: ['system-overview'], queryFn: getOverview })
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })

  return (
    <div className="page">
      <header className="page__header">
        <h1>Dashboard</h1>
      </header>

      {overview.data ? (
        <section className="stat-row" aria-label="Platform statistics">
          <div className="stat">
            <span className="stat__value">{overview.data.projectCount}</span>
            <span className="stat__label">projects</span>
          </div>
          <div className="stat">
            <span className="stat__value">{overview.data.layerCount}</span>
            <span className="stat__label">datasets</span>
          </div>
          <div className="stat">
            <span className="stat__value">{overview.data.featureTotal.toLocaleString()}</span>
            <span className="stat__label">features</span>
          </div>
          <div className="stat stat--chips">
            {Object.entries(overview.data.layersByKind).map(([kind, count]) => (
              <span key={kind} className="chip">
                {kind} {count}
              </span>
            ))}
          </div>
        </section>
      ) : (
        <p className="page__empty">{overview.isLoading ? 'Loading…' : 'Statistics unavailable.'}</p>
      )}

      <section aria-label="Projects">
        <h2 className="eyebrow">Projects</h2>
        {projects.data?.length === 0 ? (
          <p className="page__empty">No projects yet — create one from the API to get started.</p>
        ) : (
          <div className="card-grid">
            {projects.data?.map((project) => (
              <ProjectCard key={project.id} {...project} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Recent datasets">
        <h2 className="eyebrow">Recent datasets</h2>
        <ul className="row-list">
          {overview.data?.recentLayers.map((layer) => (
            <li key={layer.id} className="row-list__row">
              <Link to={`/data/${layer.id}`} className="row-list__name">
                {layer.name}
              </Link>
              <span className="row-list__meta mono">
                {layer.kind}
                {layer.geometryType ? ` · ${layer.geometryType}` : ''}
                {layer.featureCount !== null ? ` · ${layer.featureCount.toLocaleString()}` : ''}
              </span>
              <span className="row-list__project">{layer.projectName}</span>
              <Link className="row-list__action" to={`/projects/${layer.projectId}/map`}>
                map ▸
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
