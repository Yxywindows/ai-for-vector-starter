import OlMap from 'ol/Map'
import View from 'ol/View'
import { fromLonLat, transformExtent } from 'ol/proj'
import { useEffect, useRef, useState } from 'react'

import type { Layer } from '../api/types'
import { createOlLayer } from './layerFactory'

/**
 * The embedded map mode (IA plan §6): one layer, pan/zoom only, its own
 * small engine instance, fully disposed on unmount. Loaded lazily — this
 * module (and `ol` with it) must never reach a page's initial chunk.
 */
export function MapPreview({ layer }: { layer: Layer }) {
  const container = useRef<HTMLDivElement>(null)
  const [map] = useState(
    () => new OlMap({ view: new View({ center: fromLonLat([0, 0]), zoom: 1 }), layers: [] }),
  )

  useEffect(() => {
    if (!container.current) return
    map.setTarget(container.current)
    const olLayer = createOlLayer(layer, {})
    map.addLayer(olLayer)

    if (layer.extent) {
      map
        .getView()
        .fit(transformExtent(layer.extent, 'EPSG:4326', 'EPSG:3857'), {
          padding: [24, 24, 24, 24],
          maxZoom: 12,
        })
    }

    return () => {
      map.removeLayer(olLayer)
      map.setTarget(undefined)
      map.dispose()
    }
  }, [map, layer])

  return <div ref={container} className="map-preview" role="region" aria-label="Dataset preview map" />
}

export default MapPreview
