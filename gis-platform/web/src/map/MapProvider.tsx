import OlMap from 'ol/Map'
import View from 'ol/View'
import { fromLonLat } from 'ol/proj'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

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

  useEffect(() => () => map.setTarget(undefined), [map])

  const value = useMemo(() => map, [map])
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>
}
