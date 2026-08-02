/**
 * The one Mapbox layer a workspace map can carry (R10). Pure OpenLayers
 * plumbing, no React: apply a theme (create or swap the tile layer),
 * clear it (remove, dispose, restore project basemaps), and report
 * repeated tile failures so the caller can fall back cleanly when the
 * token is invalid or the network refuses.
 *
 * While a Mapbox theme is active, project layers of kind `basemap` are
 * hidden at the OpenLayers level only — their store/DB state (the thing
 * the layer panel shows and persists) is never touched.
 */

import type OlMap from 'ol/Map'
import TileLayer from 'ol/layer/Tile'
import XYZ from 'ol/source/XYZ'

import { mapboxTileUrl, type BasemapTheme } from './themes'

const MAPBOX_FLAG = 'graticule_mapbox_theme'
const HIDDEN_FLAG = 'graticule_hidden_for_mapbox'
/** This many failed tiles in a row and we call the theme broken. */
const TILE_ERROR_LIMIT = 3

type MapboxTileLayer = TileLayer<XYZ>

export function findMapboxLayer(map: OlMap): MapboxTileLayer | null {
  const match = map
    .getLayers()
    .getArray()
    .find((candidate) => candidate.get(MAPBOX_FLAG) !== undefined)
  return (match as MapboxTileLayer) ?? null
}

function projectBasemapLayers(map: OlMap) {
  return map
    .getLayers()
    .getArray()
    .filter((candidate) => candidate.get('layer_kind') === 'basemap')
}

function hideProjectBasemaps(map: OlMap): void {
  for (const layer of projectBasemapLayers(map)) {
    if (layer.getVisible()) {
      layer.set(HIDDEN_FLAG, true)
      layer.setVisible(false)
    }
  }
}

function restoreProjectBasemaps(map: OlMap): void {
  for (const layer of projectBasemapLayers(map)) {
    if (layer.get(HIDDEN_FLAG)) {
      layer.unset(HIDDEN_FLAG)
      layer.setVisible(true)
    }
  }
}

export interface ApplyOptions {
  /** Called once when a theme keeps failing to load tiles. */
  onBroken?: (theme: BasemapTheme) => void
}

/**
 * Make the map show `theme` (or none, when null). The map, its view,
 * every data layer, selection and overlay stay untouched — switching
 * themes swaps one tile layer underneath everything (zIndex -100).
 */
export function applyMapboxBasemap(
  map: OlMap,
  theme: BasemapTheme | null,
  token: string | null,
  options: ApplyOptions = {},
): void {
  const existing = findMapboxLayer(map)

  if (!theme || !token) {
    if (existing) {
      map.removeLayer(existing)
      existing.getSource()?.dispose()
      existing.dispose()
    }
    restoreProjectBasemaps(map)
    return
  }

  if (existing?.get(MAPBOX_FLAG) === theme.id) return

  if (existing) {
    map.removeLayer(existing)
    existing.getSource()?.dispose()
    existing.dispose()
  }

  const source = new XYZ({
    url: mapboxTileUrl(theme.styleId, token),
    attributions: theme.attribution,
    crossOrigin: 'anonymous',
    tilePixelRatio: 2,
    tileSize: 512,
  })

  let failures = 0
  let reported = false
  source.on('tileloadend', () => {
    failures = 0
  })
  source.on('tileloaderror', () => {
    failures += 1
    if (failures >= TILE_ERROR_LIMIT && !reported) {
      reported = true
      options.onBroken?.(theme)
    }
  })

  const layer = new TileLayer({
    source,
    zIndex: -100,
    // The derived looks (muted gray, high contrast) are a CSS filter on
    // the layer's own canvas — dataset styles render above, unfiltered.
    className: `mapbox-basemap mapbox-basemap--${theme.id}`,
  })
  layer.set(MAPBOX_FLAG, theme.id)
  map.addLayer(layer)
  hideProjectBasemaps(map)
}

/** Leaving the workspace: drop the layer and its tile cache entirely. */
export function releaseMapboxBasemap(map: OlMap): void {
  applyMapboxBasemap(map, null, null)
}
