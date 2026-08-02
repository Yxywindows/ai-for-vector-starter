import { beforeEach, describe, expect, it } from 'vitest'

import {
  MAPBOX_THEMES,
  loadBasemapChoice,
  mapboxTileUrl,
  saveBasemapChoice,
  themeById,
} from './themes'

beforeEach(() => localStorage.clear())

describe('Mapbox theme registry (R10)', () => {
  it('ships exactly the eight required themes with stable ids', () => {
    expect(MAPBOX_THEMES.map((theme) => theme.id)).toEqual([
      'mapbox-light',
      'mapbox-dark',
      'mapbox-streets',
      'mapbox-satellite',
      'mapbox-navigation',
      'mapbox-terrain',
      'mapbox-muted-gray',
      'mapbox-high-contrast',
    ])
  })

  it('gives every theme a complete descriptor', () => {
    for (const theme of MAPBOX_THEMES) {
      expect(theme.name).toBeTruthy()
      expect(theme.description).toBeTruthy()
      expect(theme.provider).toBe('mapbox')
      expect(theme.styleId).toMatch(/^mapbox\//)
      expect(theme.attribution).toContain('Mapbox')
      expect(theme.attribution).toContain('OpenStreetMap')
      expect(theme.preview).toHaveLength(3)
      for (const color of theme.preview) expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('derived looks reuse provider styles with their own filters', () => {
    expect(themeById('mapbox-muted-gray')!.styleId).toBe('mapbox/light-v11')
    expect(themeById('mapbox-muted-gray')!.filter).toContain('grayscale')
    expect(themeById('mapbox-high-contrast')!.styleId).toBe('mapbox/dark-v11')
    expect(themeById('mapbox-high-contrast')!.filter).toContain('contrast')
  })

  it('builds tile URLs with the style and an encoded token', () => {
    const url = mapboxTileUrl('mapbox/light-v11', 'pk.abc+def')
    expect(url).toContain('https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}@2x')
    expect(url).toContain('access_token=pk.abc%2Bdef')
  })

  it('round-trips the per-project choice and rejects unknown ids', () => {
    saveBasemapChoice('p1', 'mapbox-dark')
    expect(loadBasemapChoice('p1')).toBe('mapbox-dark')
    expect(loadBasemapChoice('p2')).toBeNull()

    saveBasemapChoice('p1', null)
    expect(loadBasemapChoice('p1')).toBeNull()

    localStorage.setItem('graticule:basemap:p3', 'a-theme-we-deleted')
    expect(loadBasemapChoice('p3')).toBeNull()
  })
})
