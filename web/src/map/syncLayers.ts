import type OlMap from 'ol/Map'
import type BaseLayer from 'ol/layer/Base'

import type { Layer } from '../api/types'
import { applyLayerProperties, createOlLayer, type LayerFactoryDeps } from './layerFactory'

/**
 * Reconcile the map's layer collection against the server's list.
 *
 * Recreating every OL layer on each render would throw away loaded features
 * and tile caches — the exact memory the platform works hardest to manage.
 * So a layer is rebuilt only when its *source* changes; everything else
 * (visibility, opacity, order, style) is applied in place.
 */
function sourceFingerprint(layer: Layer): string {
  return JSON.stringify(layer.source)
}

function styleFingerprint(layer: Layer): string {
  return JSON.stringify(layer.style)
}

export function syncLayers(map: OlMap, layers: Layer[], deps: LayerFactoryDeps): void {
  const collection = map.getLayers()
  const existing = new Map<string, BaseLayer>()
  for (const olLayer of collection.getArray()) {
    const id = olLayer.get('layer_id') as string | undefined
    if (id) existing.set(id, olLayer)
  }

  const wanted = new Set(layers.map((layer) => layer.id))
  for (const [id, olLayer] of existing) {
    if (!wanted.has(id)) {
      collection.remove(olLayer)
      existing.delete(id)
    }
  }

  for (const layer of layers) {
    const current = existing.get(layer.id)
    if (!current) {
      const created = createOlLayer(layer, deps)
      created.set('source_fingerprint', sourceFingerprint(layer))
      created.set('style_fingerprint', styleFingerprint(layer))
      collection.push(created)
      continue
    }

    if (current.get('source_fingerprint') !== sourceFingerprint(layer)) {
      collection.remove(current)
      const rebuilt = createOlLayer(layer, deps)
      rebuilt.set('source_fingerprint', sourceFingerprint(layer))
      rebuilt.set('style_fingerprint', styleFingerprint(layer))
      collection.push(rebuilt)
      continue
    }

    applyLayerProperties(current, layer)
    current.set('style_fingerprint', styleFingerprint(layer))
  }
}
