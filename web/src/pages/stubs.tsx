/**
 * Analysis and Exports state their arrival conditions honestly instead of
 * pretending. (Tasks graduated to its own page in R6, backed by the real
 * task backend.)
 */

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
