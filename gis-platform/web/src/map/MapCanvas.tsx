import { useEffect, useRef } from 'react'

import type { Layer } from '../api/types'
import type { LayerFactoryDeps } from './layerFactory'
import { useMap } from './MapProvider'
import { syncLayers } from './syncLayers'

interface MapCanvasProps {
  layers: Layer[]
  deps?: LayerFactoryDeps
}

export function MapCanvas({ layers, deps = {} }: MapCanvasProps) {
  const map = useMap()
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!map || !container.current) return
    map.setTarget(container.current)
    return () => map.setTarget(undefined)
  }, [map])

  useEffect(() => {
    if (map) syncLayers(map, layers, deps)
  }, [map, layers, deps])

  return <div ref={container} className="map-canvas" />
}
