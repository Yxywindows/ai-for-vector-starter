/**
 * Exports states its arrival condition honestly instead of pretending.
 * (Tasks and Analysis graduated to real pages in R6/R7.)
 */

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
