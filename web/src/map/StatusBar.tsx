import { unByKey } from 'ol/Observable'
import { toLonLat } from 'ol/proj'
import { useEffect, useState } from 'react'

import { useMap } from './MapProvider'

const formatDegrees = (value: number, positive: string, negative: string): string =>
  `${Math.abs(value).toFixed(4)}°${value >= 0 ? positive : negative}`

/**
 * The classic GIS status strip: pointer coordinates and zoom, read live
 * from the map. Purely presentational — nothing here writes map state.
 */
export function StatusBar({ layerCount }: { layerCount: number }) {
  const map = useMap()
  const [coords, setCoords] = useState<[number, number] | null>(null)
  const [zoom, setZoom] = useState<number | null>(null)

  useEffect(() => {
    if (!map) return

    const moveKey = map.on('pointermove', (event) => {
      const coordinate = toLonLat(event.coordinate)
      setCoords([coordinate[0]!, coordinate[1]!])
    })
    const zoomKey = map.on('moveend', () => setZoom(map.getView().getZoom() ?? null))
    // Initial readout arrives via the first render pass rather than a
    // synchronous set here, which React's effect rules disallow.
    const initialKey = map.once('postrender', () => setZoom(map.getView().getZoom() ?? null))

    return () => {
      unByKey(moveKey)
      unByKey(zoomKey)
      unByKey(initialKey)
    }
  }, [map])

  return (
    <div className="status-bar">
      <span className="status-bar__coords">
        {coords
          ? `${formatDegrees(coords[0], 'E', 'W')}  ${formatDegrees(coords[1], 'N', 'S')}`
          : '—'}
      </span>
      <span aria-hidden="true">·</span>
      <span>{zoom !== null ? `z ${zoom.toFixed(1)}` : 'z —'}</span>
      <span aria-hidden="true">·</span>
      <span>EPSG:3857</span>
      <span className="status-bar__spacer" />
      <span>
        {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
      </span>
    </div>
  )
}
