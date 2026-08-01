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

const WORLD: Extent = [-180, -90, 180, 90]

/** Metres per degree of longitude at the equator — good enough to scale a
 * simplification tolerance from a Web Mercator resolution. */
const METRES_PER_DEGREE = 111_320

/**
 * Tolerance for the current view: roughly 1.5 screen pixels of geometry
 * detail, in degrees. Below ~2 m/px (city zoom) simplification is skipped
 * entirely so editing-adjacent inspection always sees true vertices.
 */
export function simplifyToleranceFor(resolution: number): number | undefined {
  if (!Number.isFinite(resolution) || resolution < 2) return undefined
  return (resolution * 1.5) / METRES_PER_DEGREE
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * A bbox loading strategy: OpenLayers calls this with the current view
 * extent, we ask the server for just that window. A new extent aborts the
 * previous in-flight request — a fast pan otherwise queues stale fetches
 * that all complete, parse, and are thrown away. `truncated` is surfaced
 * so the UI can warn that the map is showing a sample, not the layer.
 */
export function createBboxLoader(layerId: string, deps: LoaderDeps): FeatureLoader {
  let inflight: AbortController | null = null

  return function loader(this: VectorSource, extent, resolution, projection, success, failure) {
    const wgs84 = transformExtent(extent, projection, 'EPSG:4326') as Extent
    const clamped: Extent = [
      Math.max(wgs84[0], -180),
      Math.max(wgs84[1], -90),
      Math.min(wgs84[2], 180),
      Math.min(wgs84[3], 90),
    ]

    inflight?.abort()
    const controller = new AbortController()
    inflight = controller

    getFeatures(layerId, clamped, {
      simplify: simplifyToleranceFor(resolution),
      signal: controller.signal,
    })
      .then((collection) => {
        deps.onFeatureBytes?.(layerId, JSON.stringify(collection).length)
        deps.onTruncated?.(layerId, collection.truncated)
        const features = format.readFeatures(collection) as Feature[]
        features.forEach((feature) => feature.set('layer_id', layerId))
        this.addFeatures(features)
        success?.(features)
      })
      .catch((error: unknown) => {
        if (isAbort(error)) {
          failure?.() // superseded, not failed — OL just forgets the extent
          return
        }
        console.error(`Failed to load features for layer ${layerId}`, error)
        failure?.()
      })
      .finally(() => {
        if (inflight === controller) inflight = null
      })
  }
}

/**
 * The small tier: the whole layer in one request, no bbox churn. Loaded
 * once by OL's default `all` strategy; full precision, no simplification.
 */
export function createFullLoader(layerId: string, limit: number, deps: LoaderDeps): FeatureLoader {
  return function loader(this: VectorSource, _extent, _resolution, _projection, success, failure) {
    getFeatures(layerId, WORLD, { limit })
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
