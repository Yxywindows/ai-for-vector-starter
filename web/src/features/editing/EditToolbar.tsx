import type { Layer } from '../../api/types'
import { tierFor } from '../../map/loadingTiers'
import { useEditSession, type EditMode } from './useEditSession'

const MODES: { value: EditMode; label: string }[] = [
  { value: 'off', label: 'Browse' },
  { value: 'draw', label: 'Draw' },
  { value: 'modify', label: 'Modify' },
  { value: 'delete', label: 'Delete' },
]

interface EditToolbarProps {
  layer: Layer | null
}

export function EditToolbar({ layer }: EditToolbarProps) {
  const session = useEditSession(layer)
  // Tile-served (large-tier) layers render clipped MVT geometries, not the
  // row geometries an edit session mutates — same rule as layerFactory.
  const editable =
    layer !== null && layer.source.type === 'postgis' && tierFor(layer) !== 'large'

  if (!layer) return null
  if (!editable) {
    return <p className="edit-toolbar edit-toolbar--disabled">This layer is not editable.</p>
  }

  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Editing tools">
      {MODES.map((entry) => (
        <button
          key={entry.value}
          type="button"
          aria-pressed={session.mode === entry.value}
          onClick={() => session.setMode(entry.value)}
        >
          {entry.label}
        </button>
      ))}

      <span data-testid="pending-count">{session.pendingCount} pending</span>

      <button
        type="button"
        className="btn--primary"
        disabled={session.pendingCount === 0 || session.isSaving}
        onClick={() => void session.save()}
      >
        {session.isSaving ? 'Saving…' : 'Save edits'}
      </button>
      <button
        type="button"
        disabled={session.pendingCount === 0 || session.isSaving}
        onClick={session.discard}
      >
        Discard
      </button>

      {session.error ? <p role="alert">{session.error}</p> : null}
    </div>
  )
}
