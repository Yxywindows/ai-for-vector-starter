import OlMap from 'ol/Map'
import View from 'ol/View'
import { fromLonLat } from 'ol/proj'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

const MapContext = createContext<OlMap | null>(null)

export function useMap(): OlMap | null {
  return useContext(MapContext)
}

interface MapProviderProps {
  center: [number, number]
  zoom: number
  children: ReactNode
}

export function MapProvider({ center, zoom, children }: MapProviderProps) {
  const [map] = useState(
    () => new OlMap({ view: new View({ center: fromLonLat(center), zoom }), layers: [] }),
  )

  // The saved view usually arrives after mount (the project query is
  // async). Apply it when it lands — but never yank the camera away from a
  // user who has already started navigating.
  const interacted = useRef(false)
  useEffect(() => {
    const viewport = map.getViewport()
    const markInteracted = () => {
      interacted.current = true
    }
    viewport.addEventListener('pointerdown', markInteracted)
    viewport.addEventListener('wheel', markInteracted)
    return () => {
      viewport.removeEventListener('pointerdown', markInteracted)
      viewport.removeEventListener('wheel', markInteracted)
    }
  }, [map])

  const [lon, lat] = center
  useEffect(() => {
    if (interacted.current) return
    const view = map.getView()
    view.setCenter(fromLonLat([lon, lat]))
    view.setZoom(zoom)
  }, [map, lon, lat, zoom])

  useEffect(() => () => map.setTarget(undefined), [map])

  const value = useMemo(() => map, [map])
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>
}
