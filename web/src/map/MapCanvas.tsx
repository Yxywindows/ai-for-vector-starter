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
    // Benchmark hook (Task 1.1): the harness waits on this mark to know the
    // map has painted its first frame after mount.
    map.once('rendercomplete', () => performance.mark('graticule:first-render'))
    // Dev-only escape hatch for the Playwright benchmark harness to drive
    // the view (pan scenario) — never present in a production build.
    if (import.meta.env.DEV) (window as unknown as { __olMap?: unknown }).__olMap = map
    return () => map.setTarget(undefined)
  }, [map])

  useEffect(() => {
    if (map) syncLayers(map, layers, deps)
  }, [map, layers, deps])

  return <div ref={container} className="map-canvas" />
}
