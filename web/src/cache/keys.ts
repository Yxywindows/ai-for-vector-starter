/** Pure string builders for geo cache keys.
 *
 * Every key embeds the dataset version (`updatedAt`) so a layer edit
 * invalidates old entries structurally — a new `updatedAt` produces a new
 * key, and the stale entries simply age out via LRU/IDB eviction rather than
 * needing an explicit invalidation pass. Query parameters are embedded too
 * so differently-shaped requests for the same tile/bbox never collide.
 */

export function tileKey(
  layerId: string,
  updatedAt: string,
  z: number,
  x: number,
  y: number,
): string {
  return `tile:${layerId}:${updatedAt}:${z}:${x}:${y}`
}

/** Params are read in a fixed order (simplify, precision, limit) so the key
 * is deterministic regardless of how the caller's object was built; an
 * absent optional contributes `''` rather than shifting the other fields. */
export function featureKey(
  layerId: string,
  updatedAt: string,
  bbox: string,
  p: { simplify?: number; precision?: number; limit?: number },
): string {
  const simplify = p.simplify ?? ''
  const precision = p.precision ?? ''
  const limit = p.limit ?? ''
  return `feature:${layerId}:${updatedAt}:${bbox}:${simplify}:${precision}:${limit}`
}
