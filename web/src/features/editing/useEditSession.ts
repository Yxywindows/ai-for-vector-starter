import type { Feature } from 'ol'
import type { MapBrowserEvent } from 'ol'
import { Draw, Modify, Snap } from 'ol/interaction'
import VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createFeature, deleteFeature, updateFeature } from '../../api/features'
import type { Layer } from '../../api/types'
import { useMap } from '../../map/MapProvider'
import { EditQueue, featureToGeoJson, geometryTypeToDrawType } from './editSession'

export type EditMode = 'off' | 'draw' | 'modify' | 'delete'

export function useEditSession(layer: Layer | null) {
  const map = useMap()
  const layerId = layer?.id
  const queue = useMemo(() => {
    void layerId // a fresh queue per layer: pending edits never cross layers
    return new EditQueue()
  }, [layerId])
  const [mode, setMode] = useState<EditMode>('off')
  const [pendingCount, setPendingCount] = useState(0)
  const [isSaving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tempCounter = useRef(0)

  const source = useMemo<VectorSource | null>(() => {
    if (!map || !layer) return null
    for (const olLayer of map.getLayers().getArray()) {
      if (olLayer.get('layer_id') === layer.id && olLayer instanceof VectorLayer) {
        return olLayer.getSource() as VectorSource
      }
    }
    return null
  }, [map, layer])

  const bump = useCallback(() => setPendingCount(queue.pending.length), [queue])

  useEffect(() => {
    if (!map || !source || !layer || mode === 'off') return

    const interactions: (Draw | Modify | Snap)[] = []
    const snap = new Snap({ source })

    if (mode === 'draw') {
      const drawType = geometryTypeToDrawType(layer.geometryType)
      // The undrawable-type error is derived at render time, not set here.
      if (!drawType) return
      const draw = new Draw({ source, type: drawType })
      draw.on('drawend', (event) => {
        tempCounter.current += 1
        const tempId = `temp-${tempCounter.current}`
        event.feature.setId(tempId)
        queue.enqueue({ kind: 'create', tempId, geometry: featureToGeoJson(event.feature) })
        bump()
      })
      interactions.push(draw)
    }

    if (mode === 'modify') {
      const modify = new Modify({ source })
      modify.on('modifyend', (event) => {
        for (const feature of event.features.getArray() as Feature[]) {
          const featureId = String(feature.getId() ?? feature.get('fid'))
          queue.enqueue({ kind: 'update', featureId, geometry: featureToGeoJson(feature) })
        }
        bump()
      })
      interactions.push(modify)
    }

    interactions.push(snap)
    interactions.forEach((interaction) => map.addInteraction(interaction))

    let onClick: ((event: MapBrowserEvent) => void) | null = null
    if (mode === 'delete') {
      onClick = (event) => {
        map.forEachFeatureAtPixel(event.pixel, (candidate) => {
          const feature = candidate as Feature
          const featureId = String(feature.getId() ?? feature.get('fid'))
          queue.enqueue({ kind: 'delete', featureId })
          source.removeFeature(feature)
          bump()
          return true
        })
      }
      map.on('click', onClick)
    }

    return () => {
      interactions.forEach((interaction) => map.removeInteraction(interaction))
      if (onClick) map.un('click', onClick)
    }
  }, [map, source, layer, mode, queue, bump])

  const save = useCallback(async () => {
    if (!layer) return
    setSaving(true)
    setError(null)
    const result = await queue.flush({
      create: async (geometry) => {
        const created = await createFeature(layer.id, { geometry, properties: {} })
        return created.id
      },
      update: async (featureId, geometry) => {
        await updateFeature(layer.id, featureId, { geometry })
      },
      remove: async (featureId) => {
        await deleteFeature(layer.id, featureId)
      },
    })
    setSaving(false)
    bump()
    if (result.failures.length > 0) {
      setError(
        `${result.failures.length} edit(s) failed: ${result.failures[0]?.message ?? 'unknown error'}`,
      )
    } else {
      source?.refresh()
    }
  }, [layer, queue, source, bump])

  const discard = useCallback(() => {
    queue.discard()
    bump()
    setError(null)
    source?.refresh()
  }, [queue, source, bump])

  const drawProblem =
    mode === 'draw' && layer && !geometryTypeToDrawType(layer.geometryType)
      ? 'This layer has a geometry type that cannot be drawn.'
      : null

  return { mode, setMode, pendingCount, save, discard, isSaving, error: error ?? drawProblem }
}
