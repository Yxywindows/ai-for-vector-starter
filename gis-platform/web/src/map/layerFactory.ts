import type BaseLayer from 'ol/layer/Base'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorTileLayer from 'ol/layer/VectorTile'
import MVT from 'ol/format/MVT'
import { bbox as bboxStrategy } from 'ol/loadingstrategy'
import VectorSource from 'ol/source/Vector'
import VectorTileSource from 'ol/source/VectorTile'
import XYZ from 'ol/source/XYZ'

import { tileUrl } from '../api/features'
import type { Layer } from '../api/types'
import { createBboxLoader, type LoaderDeps } from './featureLoader'
import type { LayerMemoryManager } from './memory/LayerMemoryManager'
import { instrumentTileSource, instrumentVectorTileSource } from './memory/instrumentation'
import { compileStyle } from './styleCompiler'

export interface LayerFactoryDeps extends LoaderDeps {
  onTileBytes?: (layerId: string, bytes: number) => void
  memory?: LayerMemoryManager
}

/** A layer is editable only when its geometry lives in a PostGIS table. */
function isEditable(layer: Layer): boolean {
  return layer.source.type === 'postgis'
}

function tagLayer(olLayer: BaseLayer, layer: Layer): BaseLayer {
  olLayer.set('layer_id', layer.id)
  olLayer.set('layer_kind', layer.kind)
  olLayer.set('editable', isEditable(layer))
  return olLayer
}

export function createOlLayer(layer: Layer, deps: LayerFactoryDeps): BaseLayer {
  const source = layer.source

  if (source.type === 'postgis') {
    const vectorSource = new VectorSource({
      strategy: bboxStrategy,
      loader: createBboxLoader(layer.id, deps),
    })
    if (deps.memory) {
      deps.memory.register(layer.id, () => vectorSource.clear(true))
    }
    const olLayer = new VectorLayer({ source: vectorSource, style: compileStyle(layer.style) })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  if (source.type === 'mvt') {
    const vectorTileSource = new VectorTileSource({
      format: new MVT(),
      url: source.url,
    })
    if (deps.memory) {
      deps.memory.register(layer.id, () => vectorTileSource.clear())
      instrumentVectorTileSource(vectorTileSource, layer.id, deps.memory)
    }
    const olLayer = new VectorTileLayer({
      source: vectorTileSource,
      style: compileStyle(layer.style),
    })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  if (source.type === 'raster_file') {
    const tileSource = new XYZ({ url: tileUrl(layer.id, 'png'), crossOrigin: 'anonymous' })
    if (deps.memory) {
      deps.memory.register(layer.id, () => tileSource.refresh())
      instrumentTileSource(tileSource, layer.id, deps.memory)
    }
    const olLayer = new TileLayer({ source: tileSource })
    return tagLayer(applyLayerProperties(olLayer, layer), layer)
  }

  const tileSource = new XYZ({
    url: source.url,
    attributions: source.attribution ?? undefined,
    crossOrigin: 'anonymous',
  })
  if (deps.memory) {
    deps.memory.register(layer.id, () => tileSource.refresh())
    instrumentTileSource(tileSource, layer.id, deps.memory)
  }
  const olLayer = new TileLayer({ source: tileSource })
  return tagLayer(applyLayerProperties(olLayer, layer), layer)
}

export function applyLayerProperties<T extends BaseLayer>(olLayer: T, layer: Layer): T {
  olLayer.setVisible(layer.visible)
  olLayer.setOpacity(layer.opacity)
  olLayer.setZIndex(layer.zIndex)
  if (olLayer instanceof VectorLayer || olLayer instanceof VectorTileLayer) {
    olLayer.setStyle(compileStyle(layer.style))
  }
  return olLayer
}
