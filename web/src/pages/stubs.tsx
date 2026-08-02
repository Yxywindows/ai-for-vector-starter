/**
 * R4 upgrades these three into real task pages (jobs list, analysis
 * workflow, exports). Until then they are honest empty states, not dead
 * links — each says what will live here and offers the current path to it.
 */
import { Link } from 'react-router'

export function TasksPage() {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Tasks</h1>
      </header>
      <p className="page__empty">
        No running tasks. Imports currently run in the foreground — start one from the map
        workspace's <em>Add layer</em>; completed imports appear as datasets in the{' '}
        <Link to="/data">catalog</Link>.
      </p>
    </div>
  )
}

export function AnalysisPage() {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Analysis</h1>
      </header>
      <p className="page__empty">
        Spatial analysis tools (buffer, intersection) arrive with the background-jobs backend —
        planned in docs/superpowers/plans, Phase 3 of the performance plan.
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
        Nothing exported yet. Dataset exports and shareable map views land here once the export
        pipeline ships.
      </p>
    </div>
  )
}
