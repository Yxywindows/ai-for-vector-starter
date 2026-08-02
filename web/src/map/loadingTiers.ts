import type { Layer } from '../api/types'

/**
 * Adaptive loading tiers for PostGIS-backed layers, decided from the
 * feature count the server already persists on every layer.
 *
 * - small: one full GeoJSON fetch — no per-pan churn at all.
 * - medium: viewport (bbox) GeoJSON with cancellation and zoom-scaled
 *   simplification.
 * - large: the server's MVT tile endpoint — generalization and clipping
 *   happen in PostGIS, and the map never holds the whole layer.
 *
 * SMALL_MAX mirrors the server's `feature_bbox_limit` (config.py): a layer
 * that fits under the bbox cap in one response needs no bbox strategy.
 * A layer with an unknown count (registered before counting, external
 * tables) gets the medium path, which degrades gracefully either way.
 */
export const SMALL_MAX = 2_000
export const MEDIUM_MAX = 50_000

export type LoadingTier = 'small' | 'medium' | 'large'

export function tierFor(layer: Layer): LoadingTier {
  if (layer.source.type !== 'postgis') return 'medium'
  const count = layer.featureCount
  if (count === null || count === undefined) return 'medium'
  if (count <= SMALL_MAX) return 'small'
  if (count <= MEDIUM_MAX) return 'medium'
  return 'large'
}
