import OlMap from 'ol/Map'
import TileLayer from 'ol/layer/Tile'
import XYZ from 'ol/source/XYZ'
import { describe, expect, it, vi } from 'vitest'

import { applyMapboxBasemap, findMapboxLayer, releaseMapboxBasemap } from './mapboxLayer'
import { themeById } from './themes'

const light = themeById('mapbox-light')!
const dark = themeById('mapbox-dark')!

function makeMap(): OlMap {
  return new OlMap({ layers: [] })
}

function makeProjectBasemap(): TileLayer<XYZ> {
  const layer = new TileLayer({ source: new XYZ({ url: 'https://osm/{z}/{x}/{y}.png' }) })
  layer.set('layer_kind', 'basemap')
  return layer
}

describe('applyMapboxBasemap (R10)', () => {
  it('adds one tile layer under everything, keyed to the theme', () => {
    const map = makeMap()
    applyMapboxBasemap(map, light, 'pk.test')

    const layer = findMapboxLayer(map)!
    expect(layer).toBeTruthy()
    expect(layer.getZIndex()).toBe(-100)
    expect(layer.getSource()!.getUrls()![0]).toContain('mapbox/light-v11')
    expect(layer.getSource()!.getUrls()![0]).toContain('access_token=pk.test')
    expect(layer.getSource()!.getAttributions()).toBeTruthy()
    expect(map.getLayers().getLength()).toBe(1)
  })

  it('is idempotent for the same theme and swaps for a different one', () => {
    const map = makeMap()
    applyMapboxBasemap(map, light, 'pk.test')
    const first = findMapboxLayer(map)!
    applyMapboxBasemap(map, light, 'pk.test')
    expect(findMapboxLayer(map)).toBe(first)

    applyMapboxBasemap(map, dark, 'pk.test')
    const swapped = findMapboxLayer(map)!
    expect(swapped).not.toBe(first)
    expect(swapped.getSource()!.getUrls()![0]).toContain('mapbox/dark-v11')
    expect(map.getLayers().getLength()).toBe(1)
  })

  it('hides project basemaps while active and restores them after', () => {
    const map = makeMap()
    const osm = makeProjectBasemap()
    map.addLayer(osm)

    applyMapboxBasemap(map, light, 'pk.test')
    expect(osm.getVisible()).toBe(false)

    applyMapboxBasemap(map, null, null)
    expect(osm.getVisible()).toBe(true)
    expect(findMapboxLayer(map)).toBeNull()
  })

  it('never re-shows a basemap the user had hidden themselves', () => {
    const map = makeMap()
    const osm = makeProjectBasemap()
    osm.setVisible(false)
    map.addLayer(osm)

    applyMapboxBasemap(map, light, 'pk.test')
    applyMapboxBasemap(map, null, null)
    expect(osm.getVisible()).toBe(false)
  })

  it('does nothing without a token', () => {
    const map = makeMap()
    applyMapboxBasemap(map, light, null)
    expect(findMapboxLayer(map)).toBeNull()
  })

  it('reports a broken theme after repeated tile errors, once', () => {
    const map = makeMap()
    const onBroken = vi.fn()
    applyMapboxBasemap(map, light, 'pk.invalid', { onBroken })

    const source = findMapboxLayer(map)!.getSource()!
    for (let i = 0; i < 5; i += 1) {
      source.dispatchEvent('tileloaderror' as never)
    }
    expect(onBroken).toHaveBeenCalledTimes(1)
    expect(onBroken).toHaveBeenCalledWith(light)
  })

  it('a successful tile resets the failure streak', () => {
    const map = makeMap()
    const onBroken = vi.fn()
    applyMapboxBasemap(map, light, 'pk.flaky', { onBroken })

    const source = findMapboxLayer(map)!.getSource()!
    source.dispatchEvent('tileloaderror' as never)
    source.dispatchEvent('tileloaderror' as never)
    source.dispatchEvent('tileloadend' as never)
    source.dispatchEvent('tileloaderror' as never)
    source.dispatchEvent('tileloaderror' as never)
    expect(onBroken).not.toHaveBeenCalled()
  })

  it('releases the layer and its source when the workspace exits', () => {
    const map = makeMap()
    applyMapboxBasemap(map, light, 'pk.test')
    const source = findMapboxLayer(map)!.getSource()!
    const disposed = vi.spyOn(source, 'dispose')

    releaseMapboxBasemap(map)
    expect(findMapboxLayer(map)).toBeNull()
    expect(map.getLayers().getLength()).toBe(0)
    expect(disposed).toHaveBeenCalled()
  })
})
