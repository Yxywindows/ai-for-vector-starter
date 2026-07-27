import type OlMap from 'ol/Map'
import VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'

function findVectorLayer(map: OlMap, layerId: string): VectorLayer<VectorSource> | null {
  for (const layer of map.getLayers().getArray()) {
    if (layer.get('layer_id') === layerId && layer instanceof VectorLayer) {
      return layer as VectorLayer<VectorSource>
    }
  }
  return null
}

/** Selection is a feature property the style compiler can read; no second layer. */
export function highlightFeatures(map: OlMap, layerId: string, featureIds: string[]): void {
  const layer = findVectorLayer(map, layerId)
  const source = layer?.getSource()
  if (!source) return
  const wanted = new Set(featureIds)
  for (const feature of source.getFeatures()) {
    feature.set('__selected', wanted.has(String(feature.getId() ?? feature.get('fid'))))
  }
  layer?.changed()
}

export function zoomToFeature(map: OlMap, layerId: string, featureId: string): void {
  const source = findVectorLayer(map, layerId)?.getSource()
  const feature = source
    ?.getFeatures()
    .find((candidate) => String(candidate.getId() ?? candidate.get('fid')) === featureId)
  const extent = feature?.getGeometry()?.getExtent()
  if (extent) map.getView().fit(extent, { maxZoom: 16, duration: 250, padding: [40, 40, 40, 40] })
}
