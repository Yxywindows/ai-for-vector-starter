import type Feature from 'ol/Feature'
import { unByKey } from 'ol/Observable'
import VectorLayer from 'ol/layer/Vector'
import { useEffect, useState } from 'react'

import { useLayerStore } from '../state/layerStore'
import { useMap } from './MapProvider'

interface Identified {
  layerId: string
  layerName: string
  featureId: string
  properties: [string, unknown][]
  pixel: [number, number]
}

/** Feature properties that are map plumbing, not user data. */
const INTERNAL_KEYS = new Set(['geometry', '__selected', 'layer_id'])

const display = (value: unknown): string => {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Click-to-identify, the standard GIS gesture: clicking a feature opens a
 * card with its attributes, makes its layer active, and selects the row in
 * the attribute table. Clicking bare map clears the selection. The card is
 * anchored to the click point and clamped inside the map viewport.
 */
export function IdentifyPopup({ names }: { names: Map<string, string> }) {
  const map = useMap()
  const [hit, setHit] = useState<Identified | null>(null)

  useEffect(() => {
    if (!map) return

    const clickKey = map.on('singleclick', (event) => {
      let found: Identified | null = null
      map.forEachFeatureAtPixel(
        event.pixel,
        (candidate, layer) => {
          const layerId = layer?.get('layer_id') as string | undefined
          if (!layerId) return undefined
          const feature = candidate as Feature
          const featureId = String(feature.getId() ?? feature.get('fid'))
          const properties = Object.entries(feature.getProperties()).filter(
            ([key]) => !INTERNAL_KEYS.has(key),
          )
          found = {
            layerId,
            layerName: names.get(layerId) ?? layerId,
            featureId,
            properties,
            pixel: [event.pixel[0]!, event.pixel[1]!],
          }
          return true // first (topmost) feature wins
        },
        { layerFilter: (layer) => layer instanceof VectorLayer },
      )

      const store = useLayerStore.getState()
      if (found) {
        const identified = found as Identified
        store.selectLayer(identified.layerId)
        store.selectFeatures([identified.featureId])
      } else {
        store.selectFeatures([])
      }
      setHit(found)
    })

    const moveKey = map.on('movestart', () => setHit(null))

    return () => {
      unByKey(clickKey)
      unByKey(moveKey)
    }
  }, [map, names])

  if (!hit) return null

  // Keep the card inside the viewport: flip to the left of the click near
  // the right edge, and clamp vertically near the top and bottom.
  const target = map?.getTargetElement()
  const width = target?.clientWidth ?? Number.POSITIVE_INFINITY
  const height = target?.clientHeight ?? Number.POSITIVE_INFINITY
  const flip = hit.pixel[0] > width - 320
  const top = Math.max(90, Math.min(hit.pixel[1], height - 120))

  return (
    <div
      className={flip ? 'identify-popup identify-popup--flip' : 'identify-popup'}
      data-testid="identify-popup"
      role="dialog"
      aria-label={`Feature ${hit.featureId} on ${hit.layerName}`}
      style={{ left: hit.pixel[0], top }}
    >
      <header className="identify-popup__header">
        <span className="identify-popup__title">{hit.layerName}</span>
        <span className="identify-popup__id">#{hit.featureId}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close feature details"
          onClick={() => setHit(null)}
        >
          ×
        </button>
      </header>
      {hit.properties.length === 0 ? (
        <p className="identify-popup__empty">No attributes.</p>
      ) : (
        <dl className="identify-popup__rows">
          {hit.properties.slice(0, 12).map(([key, value]) => (
            <div key={key} className="identify-popup__row">
              <dt>{key}</dt>
              <dd>{display(value)}</dd>
            </div>
          ))}
          {hit.properties.length > 12 ? (
            <div className="identify-popup__row">
              <dt>…</dt>
              <dd>{hit.properties.length - 12} more in the attribute table</dd>
            </div>
          ) : null}
        </dl>
      )}
    </div>
  )
}
