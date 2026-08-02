/**
 * Tasks lists real import provenance today (synchronous imports recorded
 * via sourceFilename); it becomes a live jobs view when the async-import
 * backend (performance plan, Phase 3) lands. Analysis and Exports state
 * their arrival conditions honestly instead of pretending.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'

import { getProject, listProjects } from '../api/layers'

export function TasksPage() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects })
  const projectQueries = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ['project', project.id],
      queryFn: () => getProject(project.id),
    })),
  })

  const imports = projectQueries.flatMap((query) => {
    const project = query.data
    if (!project) return []
    return project.layers
      .filter((layer) => layer.sourceFilename)
      .map((layer) => ({ layer, project }))
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>Tasks</h1>
      </header>
      <h2 className="eyebrow">Completed imports</h2>
      {imports.length === 0 ? (
        <p className="page__empty">
          No imports recorded yet. Start one from the map workspace's <em>Add layer</em> — imported
          datasets appear here with their source files.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              <th scope="col">Source file</th>
              <th scope="col">Project</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {imports.map(({ layer, project }) => (
              <tr key={layer.id}>
                <td>
                  <Link className="row-list__name" to={`/data/${layer.id}`}>
                    {layer.name}
                  </Link>
                </td>
                <td className="mono">{layer.sourceFilename}</td>
                <td>{project.name}</td>
                <td>
                  <span className="chip">imported</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="page__note">
        Running and queued tasks appear here once imports move to background jobs.
      </p>
    </div>
  )
}

const TOOLS = [
  {
    name: 'Buffer',
    description: 'Grow features by a distance into a new dataset (ST_Buffer in PostGIS).',
  },
  {
    name: 'Intersection',
    description: 'Cut one dataset by another, keeping the shared area (ST_Intersection).',
  },
]

export function AnalysisPage() {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Analysis</h1>
      </header>
      <div className="card-grid">
        {TOOLS.map((tool) => (
          <article key={tool.name} className="card">
            <h3 className="card__title">{tool.name}</h3>
            <p className="card__meta">{tool.description}</p>
            <div className="card__actions">
              <button type="button" disabled title="Requires the background-jobs backend">
                Configure ▸
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="page__note">
        Tools submit as background jobs and open their results on the map. They unlock with the
        jobs backend (performance plan, Phase 3).
      </p>
    </div>
  )
}

export function ExportsPage() {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Exports</h1>
      </header>
      <p className="page__empty">
        Nothing exported yet. Dataset exports (GeoJSON, PMTiles) and shareable map views land here
        once the export pipeline ships. Until then, a workspace URL — view, layers and selection —
        is itself shareable state.
      </p>
    </div>
  )
}
