import ImageLayer from 'ol/layer/Image'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorTileLayer from 'ol/layer/VectorTile'
import VectorSource from 'ol/source/Vector'
import VectorTileSource from 'ol/source/VectorTile'
import XYZ from 'ol/source/XYZ'
import { describe, expect, it } from 'vitest'

import type { Layer } from '../api/types'
import { applyLayerProperties, createOlLayer } from './layerFactory'

const base = {
  id: 'l1',
  projectId: 'p1',
  style: null,
  visible: true,
  opacity: 1,
  zIndex: 0,
  extent: null,
  featureCount: null,
  srid: 4326,
  geometryType: null,
} satisfies Partial<Layer>

const postgisLayer: Layer = {
  ...base,
  name: 'Roads',
  kind: 'vector',
  source: {
    type: 'postgis',
    schemaName: 'gis_data',
    tableName: 'roads',
    geometryColumn: 'geometry',
    idColumn: 'fid',
    srid: 4326,
  },
} as Layer

const rasterLayer: Layer = {
  ...base,
  name: 'DEM',
  kind: 'raster',
  source: { type: 'raster_file', path: 'a.tif', bandCount: 1, nodata: null, isCog: true },
} as Layer

const basemapLayer: Layer = {
  ...base,
  name: 'OSM',
  kind: 'basemap',
  source: { type: 'xyz', url: 'https://tile/{z}/{x}/{y}.png', attribution: '© OSM' },
} as Layer

const mvtLayer: Layer = {
  ...base,
  name: 'Water',
  kind: 'vector_tile',
  source: { type: 'mvt', url: 'https://tiles/{z}/{x}/{y}.pbf', sourceLayer: 'water' },
} as Layer

describe('createOlLayer', () => {
  it('builds a VectorLayer with a bbox-loading source for a PostGIS layer', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    expect(olLayer).toBeInstanceOf(VectorLayer)
    expect((olLayer as VectorLayer).getSource()).toBeInstanceOf(VectorSource)
    expect(olLayer.get('editable')).toBe(true)
  })

  it('builds a TileLayer pointed at the raster tile endpoint', () => {
    const olLayer = createOlLayer(rasterLayer, {})
    expect(olLayer).toBeInstanceOf(TileLayer)
    const source = (olLayer as TileLayer<XYZ>).getSource()
    expect(source).toBeInstanceOf(XYZ)
    expect(source?.getUrls()?.[0]).toBe('/api/v1/layers/l1/tiles/{z}/{x}/{y}.png')
    expect(olLayer.get('editable')).toBe(false)
  })

  it('builds a TileLayer from a remote XYZ basemap url', () => {
    const olLayer = createOlLayer(basemapLayer, {})
    const source = (olLayer as TileLayer<XYZ>).getSource()
    expect(source?.getUrls()?.[0]).toBe('https://tile/{z}/{x}/{y}.png')
  })

  it('builds a VectorTileLayer for an MVT source', () => {
    const olLayer = createOlLayer(mvtLayer, {})
    expect(olLayer).toBeInstanceOf(VectorTileLayer)
    expect((olLayer as VectorTileLayer).getSource()).toBeInstanceOf(VectorTileSource)
  })

  it('tags every layer with its server id and kind', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    expect(olLayer.get('layer_id')).toBe('l1')
    expect(olLayer.get('layer_kind')).toBe('vector')
  })

  it('never returns an ImageLayer (nothing here is single-image)', () => {
    for (const layer of [postgisLayer, rasterLayer, basemapLayer, mvtLayer]) {
      expect(createOlLayer(layer, {})).not.toBeInstanceOf(ImageLayer)
    }
  })
})

describe('applyLayerProperties', () => {
  it('mirrors visibility, opacity and z-index onto the OL layer', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    applyLayerProperties(olLayer, { ...postgisLayer, visible: false, opacity: 0.25, zIndex: 7 })
    expect(olLayer.getVisible()).toBe(false)
    expect(olLayer.getOpacity()).toBe(0.25)
    expect(olLayer.getZIndex()).toBe(7)
  })

  it('is idempotent', () => {
    const olLayer = createOlLayer(postgisLayer, {})
    applyLayerProperties(olLayer, postgisLayer)
    applyLayerProperties(olLayer, postgisLayer)
    expect(olLayer.getOpacity()).toBe(1)
  })
})
