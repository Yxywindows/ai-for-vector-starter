import Map from 'ol/Map'
import View from 'ol/View'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../api/types'
import { syncLayers } from './syncLayers'

function makeLayer(id: string, zIndex: number, overrides: Partial<Layer> = {}): Layer {
  return {
    id,
    projectId: 'p1',
    name: `Layer ${id}`,
    kind: 'basemap',
    source: { type: 'xyz', url: `https://tile/${id}/{z}/{x}/{y}.png`, attribution: null },
    style: null,
    visible: true,
    opacity: 1,
    zIndex,
    extent: null,
    featureCount: null,
    srid: null,
    geometryType: null,
    ...overrides,
  } as Layer
}

function makeMap(): Map {
  return new Map({ view: new View({ center: [0, 0], zoom: 2 }) })
}

const ids = (map: Map) =>
  map
    .getLayers()
    .getArray()
    .map((l) => l.get('layer_id') as string)

describe('syncLayers', () => {
  it('adds layers that are new', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1)], {})
    expect(ids(map)).toEqual(['a', 'b'])
  })

  it('removes layers that disappeared from the server list', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1)], {})
    syncLayers(map, [makeLayer('a', 0)], {})
    expect(ids(map)).toEqual(['a'])
  })

  it('reuses the existing OL layer instance when a layer is unchanged', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(map, [makeLayer('a', 0)], {})
    expect(map.getLayers().item(0)).toBe(first)
  })

  it('updates visibility and opacity in place without recreating the layer', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(map, [makeLayer('a', 0, { visible: false, opacity: 0.3 })], {})
    expect(map.getLayers().item(0)).toBe(first)
    expect(first.getVisible()).toBe(false)
    expect(first.getOpacity()).toBe(0.3)
  })

  it('recreates the layer when its source changes', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    const first = map.getLayers().item(0)
    syncLayers(
      map,
      [
        makeLayer('a', 0, {
          source: { type: 'xyz', url: 'https://other/{z}/{x}/{y}.png', attribution: null },
        }),
      ],
      {},
    )
    expect(map.getLayers().item(0)).not.toBe(first)
  })

  it('applies z-index so draw order follows the server order', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0), makeLayer('b', 1), makeLayer('c', 2)], {})
    const byId = Object.fromEntries(
      map
        .getLayers()
        .getArray()
        .map((l) => [l.get('layer_id') as string, l.getZIndex()]),
    )
    expect(byId).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('handles an empty layer list', () => {
    const map = makeMap()
    syncLayers(map, [makeLayer('a', 0)], {})
    syncLayers(map, [], {})
    expect(ids(map)).toEqual([])
  })
})
