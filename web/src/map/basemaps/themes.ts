/**
 * Code-owned Mapbox basemap themes (R10). Each theme is a stable,
 * versioned descriptor we control: identity, the provider style it
 * maps to, attribution, a three-color preview swatch, and an optional
 * CSS filter for the two derived looks. The Mapbox token comes only
 * from the environment (`VITE_MAPBOX_ACCESS_TOKEN`) — never from code.
 *
 * Tiles are Mapbox Static Tiles (raster, 512px @2x) rendered by the
 * ordinary OpenLayers XYZ pipeline: no extra SDK, no map recreation on
 * switch, and the same memory instrumentation path as every other tile
 * layer.
 */

export interface BasemapTheme {
  /** Stable id — persisted per project; never renumber. */
  id: string
  name: string
  description: string
  provider: 'mapbox'
  /** Mapbox style path, e.g. `mapbox/light-v11`. */
  styleId: string
  attribution: string
  /** Recommended colors: [ground, water, accent] — drawn as the preview swatch. */
  preview: [string, string, string]
  /** Optional CSS filter for derived looks (muted gray, high contrast). */
  filter?: string
}

const MAPBOX_ATTRIBUTION =
  '© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noreferrer">Mapbox</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> ' +
  '<a href="https://apps.mapbox.com/feedback/" target="_blank" rel="noreferrer">Improve this map</a>'

export const MAPBOX_THEMES: BasemapTheme[] = [
  {
    id: 'mapbox-light',
    name: 'Light',
    description: 'Quiet light backdrop that keeps data in front.',
    provider: 'mapbox',
    styleId: 'mapbox/light-v11',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#f2f0ec', '#cfe0e8', '#a5a29b'],
  },
  {
    id: 'mapbox-dark',
    name: 'Dark',
    description: 'Low-light backdrop for bright overlays.',
    provider: 'mapbox',
    styleId: 'mapbox/dark-v11',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#22242a', '#182028', '#5c6470'],
  },
  {
    id: 'mapbox-streets',
    name: 'Streets',
    description: 'Full street detail for urban work.',
    provider: 'mapbox',
    styleId: 'mapbox/streets-v12',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#f6f2e9', '#a4c8f0', '#f3b73f'],
  },
  {
    id: 'mapbox-satellite',
    name: 'Satellite',
    description: 'Imagery with street labels on top.',
    provider: 'mapbox',
    styleId: 'mapbox/satellite-streets-v12',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#3d4a35', '#1d2f40', '#d8d4c9'],
  },
  {
    id: 'mapbox-navigation',
    name: 'Navigation',
    description: 'High-legibility roads, tuned for routing.',
    provider: 'mapbox',
    styleId: 'mapbox/navigation-day-v1',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#f8f8f6', '#bcd8ee', '#4a90d9'],
  },
  {
    id: 'mapbox-terrain',
    name: 'Terrain',
    description: 'Hillshade, contours and trails (outdoors).',
    provider: 'mapbox',
    styleId: 'mapbox/outdoors-v12',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#ebe5d8', '#b5d3c3', '#8a9b6e'],
  },
  {
    id: 'mapbox-muted-gray',
    name: 'Muted Gray',
    description: 'Light style desaturated to pure grays.',
    provider: 'mapbox',
    styleId: 'mapbox/light-v11',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#ececec', '#d8d8d8', '#9a9a9a'],
    filter: 'grayscale(1) contrast(0.95)',
  },
  {
    id: 'mapbox-high-contrast',
    name: 'High Contrast',
    description: 'Dark style pushed for maximum separation.',
    provider: 'mapbox',
    styleId: 'mapbox/dark-v11',
    attribution: MAPBOX_ATTRIBUTION,
    preview: ['#101114', '#000208', '#f2f4f8'],
    filter: 'contrast(1.35) brightness(1.05)',
  },
]

export const themeById = (id: string | null): BasemapTheme | null =>
  MAPBOX_THEMES.find((theme) => theme.id === id) ?? null

/** The token lives in the local env file only; absent means Mapbox is off. */
export function getMapboxToken(): string | null {
  const raw = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined
  const token = raw?.trim()
  return token ? token : null
}

export function mapboxTileUrl(styleId: string, token: string): string {
  return (
    `https://api.mapbox.com/styles/v1/${styleId}/tiles/512/{z}/{x}/{y}@2x` +
    `?access_token=${encodeURIComponent(token)}`
  )
}

/* Per-project persistence, same tier as workspace layout. */

const choiceKey = (projectId: string) => `graticule:basemap:${projectId}`

export function loadBasemapChoice(projectId: string): string | null {
  try {
    const stored = localStorage.getItem(choiceKey(projectId))
    return stored && themeById(stored) ? stored : null
  } catch {
    return null
  }
}

export function saveBasemapChoice(projectId: string, themeId: string | null): void {
  try {
    if (themeId) localStorage.setItem(choiceKey(projectId), themeId)
    else localStorage.removeItem(choiceKey(projectId))
  } catch {
    // Storage full or blocked: the choice simply won't persist.
  }
}
