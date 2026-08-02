import { unByKey } from 'ol/Observable'
import { toLonLat } from 'ol/proj'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'

import { API_BASE } from '../api/client'
import { useLayerStore } from '../state/layerStore'
import { useMap } from './MapProvider'

/** `z/lon/lat`, the shareable center-and-zoom of the view. */
export function parseViewParam(
  raw: string | null,
): { center: [number, number]; zoom: number } | null {
  if (!raw) return null
  const parts = raw.split('/').map(Number)
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null
  const [zoom, lon, lat] = parts as [number, number, number]
  if (zoom < 0 || zoom > 28 || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null
  return { center: [lon, lat], zoom }
}

export function parseSelParam(raw: string | null): { layerId: string; featureIds: string[] } | null {
  if (!raw) return null
  const [layerId, ids] = raw.split(':', 2)
  if (!layerId) return null
  return { layerId, featureIds: ids ? ids.split(',').filter(Boolean) : [] }
}

const THUMBNAIL_DEBOUNCE_MS = 3000
const THUMBNAIL_SIZE: [number, number] = [256, 128]

/** Compose the map's layer canvases into a small PNG and store it for the
 * dashboard cards. Fire-and-forget: a failed capture costs nothing. */
function captureThumbnail(target: HTMLElement, projectId: string): void {
  const sources = target.querySelectorAll<HTMLCanvasElement>('.ol-layer canvas, canvas.ol-layer')
  if (sources.length === 0) return
  const canvas = document.createElement('canvas')
  canvas.width = THUMBNAIL_SIZE[0]
  canvas.height = THUMBNAIL_SIZE[1]
  const context = canvas.getContext('2d')
  if (!context) return
  for (const source of sources) {
    if (source.width === 0) continue
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
  }
  canvas.toBlob((blob) => {
    if (!blob) return
    void fetch(`${API_BASE}/projects/${projectId}/thumbnail`, {
      method: 'PUT',
      body: blob,
      headers: { 'content-type': 'image/png' },
    }).catch(() => undefined)
  }, 'image/png')
}

/**
 * Keeps the URL the source of truth for the workspace session (IA plan §7):
 * `view=z/lon/lat` after every move, `sel=layerId:fid,…` after every
 * selection change. All writes are `replace` — panning must not spam the
 * history stack. Also debounces the dashboard thumbnail capture.
 */
export function WorkspaceSync({ projectId }: { projectId: string }) {
  const map = useMap()
  const [, setSearchParams] = useSearchParams()

  useEffect(() => {
    if (!map) return
    let thumbTimer: ReturnType<typeof setTimeout> | undefined

    const moveKey = map.on('moveend', () => {
      const view = map.getView()
      const center = view.getCenter()
      const zoom = view.getZoom()
      if (!center || zoom === undefined) return
      const [lon, lat] = toLonLat(center)
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          next.set('view', `${zoom.toFixed(2)}/${lon!.toFixed(5)}/${lat!.toFixed(5)}`)
          return next
        },
        { replace: true },
      )

      clearTimeout(thumbTimer)
      const target = map.getTargetElement()
      if (target) {
        thumbTimer = setTimeout(() => captureThumbnail(target, projectId), THUMBNAIL_DEBOUNCE_MS)
      }
    })

    return () => {
      unByKey(moveKey)
      clearTimeout(thumbTimer)
    }
  }, [map, projectId, setSearchParams])

  useEffect(
    () =>
      useLayerStore.subscribe((state, previous) => {
        if (
          state.selectedLayerId === previous.selectedLayerId &&
          state.selectedFeatureIds === previous.selectedFeatureIds
        ) {
          return
        }
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current)
            if (state.selectedLayerId) {
              const ids = state.selectedFeatureIds.join(',')
              next.set('sel', ids ? `${state.selectedLayerId}:${ids}` : state.selectedLayerId)
            } else {
              next.delete('sel')
            }
            return next
          },
          { replace: true },
        )
      }),
    [setSearchParams],
  )

  return null
}
