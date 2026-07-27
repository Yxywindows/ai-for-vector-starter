import { useState } from 'react'

import type { Layer } from '../../api/types'
import { useLayerStore } from '../../state/layerStore'
import { AddLayerDialog } from './AddLayerDialog'
import { moveItem } from './reorder'
import { useLayerMutations } from './useLayerMutations'

interface LayerPanelProps {
  projectId: string
  layers: Layer[]
}

export function LayerPanel({ projectId, layers }: LayerPanelProps) {
  const mutations = useLayerMutations(projectId)
  const selectedLayerId = useLayerStore((state) => state.selectedLayerId)
  const selectLayer = useLayerStore((state) => state.selectLayer)
  const truncatedLayerIds = useLayerStore((state) => state.truncatedLayerIds)
  const [dialogOpen, setDialogOpen] = useState(false)

  // The panel shows the topmost layer first, which is the reverse of z-index.
  const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex)

  const move = (displayIndex: number, delta: number) => {
    const next = moveItem(ordered, displayIndex, displayIndex + delta)
    // Convert display order (top first) back to ascending z-index order.
    mutations.reorder.mutate([...next].reverse().map((layer) => layer.id))
  }

  return (
    <div className="layer-panel">
      <header className="layer-panel__header">
        <h2>Layers</h2>
        <button type="button" onClick={() => setDialogOpen(true)}>
          Add layer
        </button>
      </header>

      {ordered.length === 0 ? (
        <p className="layer-panel__empty">No layers yet. Add one to get started.</p>
      ) : (
        <ul className="layer-panel__list">
          {ordered.map((layer, index) => (
            <li
              key={layer.id}
              className={
                layer.id === selectedLayerId ? 'layer-item layer-item--selected' : 'layer-item'
              }
            >
              <div className="layer-item__row">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  aria-label={`Toggle visibility of ${layer.name}`}
                  onChange={(event) =>
                    mutations.setVisible.mutate({
                      layerId: layer.id,
                      visible: event.target.checked,
                    })
                  }
                />
                <button
                  type="button"
                  className="layer-item__name"
                  data-testid="layer-name"
                  onClick={() => selectLayer(layer.id)}
                >
                  {layer.name}
                </button>
                <button
                  type="button"
                  aria-label={`Move layer up: ${layer.name}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move layer down: ${layer.name}`}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove layer: ${layer.name}`}
                  onClick={() => mutations.remove.mutate(layer.id)}
                >
                  ×
                </button>
              </div>

              <div className="layer-item__meta">
                {layer.featureCount !== null ? `${layer.featureCount} features` : layer.kind}
                {layer.geometryType ? ` · ${layer.geometryType}` : ''}
              </div>

              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layer.opacity}
                aria-label={`Opacity of ${layer.name}`}
                onChange={(event) =>
                  mutations.setOpacity.mutate({
                    layerId: layer.id,
                    opacity: Number(event.target.value),
                  })
                }
              />

              {truncatedLayerIds.includes(layer.id) ? (
                <p role="status" className="layer-item__warning">
                  Showing a subset — zoom in to see every feature.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <AddLayerDialog projectId={projectId} open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  )
}
