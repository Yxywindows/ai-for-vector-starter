import type { Feature } from 'ol'
import GeoJSON from 'ol/format/GeoJSON'
import type { FeatureLoader } from 'ol/featureloader'
import { transformExtent } from 'ol/proj'
import type VectorSource from 'ol/source/Vector'

import { getFeatures } from '../api/features'
import type { Extent } from '../api/types'

export interface LoaderDeps {
  onFeatureBytes?: (layerId: string, bytes: number) => void
  onTruncated?: (layerId: string, truncated: boolean) => void
}

const format = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })

/**
 * A bbox loading strategy: OpenLayers calls this with the current view
 * extent, we ask the server for just that window, and we tell the memory
 * manager how many bytes arrived. `truncated` is surfaced so the UI can warn
 * that the map is showing a sample, not the layer.
 */
export function createBboxLoader(layerId: string, deps: LoaderDeps): FeatureLoader {
  return function loader(this: VectorSource, extent, _resolution, projection, success, failure) {
    const wgs84 = transformExtent(extent, projection, 'EPSG:4326') as Extent
    const clamped: Extent = [
      Math.max(wgs84[0], -180),
      Math.max(wgs84[1], -90),
      Math.min(wgs84[2], 180),
      Math.min(wgs84[3], 90),
    ]

    getFeatures(layerId, clamped)
      .then((collection) => {
        deps.onFeatureBytes?.(layerId, JSON.stringify(collection).length)
        deps.onTruncated?.(layerId, collection.truncated)
        const features = format.readFeatures(collection) as Feature[]
        features.forEach((feature) => feature.set('layer_id', layerId))
        this.addFeatures(features)
        success?.(features)
      })
      .catch((error: unknown) => {
        console.error(`Failed to load features for layer ${layerId}`, error)
        failure?.()
      })
  }
}
