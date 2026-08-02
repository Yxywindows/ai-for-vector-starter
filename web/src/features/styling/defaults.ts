import type { RasterStyle, Renderer, VectorStyle } from '../../api/types'

const MAX_CATEGORIES = 50

export function defaultVectorStyle(): VectorStyle {
  return {
    kind: 'vector',
    renderer: { type: 'single' },
    fill: { color: '#3b82f6', opacity: 0.6 },
    stroke: { color: '#1e3a8a', width: 1, dash: null },
    marker: { shape: 'circle', radius: 5 },
    label: null,
  }
}

export function defaultRasterStyle(): RasterStyle {
  return { kind: 'raster', bands: [1], rescale: null, colormap: null, opacity: 1 }
}

export function withRenderer(style: VectorStyle, renderer: Renderer): VectorStyle {
  return { ...style, renderer }
}

export function distinctValues(
  rows: Record<string, unknown>[],
  field: string,
): (string | number)[] {
  const seen: (string | number)[] = []
  const set = new Set<string>()
  for (const row of rows) {
    const value = row[field]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const key = String(value)
    if (set.has(key)) continue
    set.add(key)
    seen.push(value)
    if (seen.length >= MAX_CATEGORIES) break
  }
  return seen
}

export function numericRange(
  rows: Record<string, unknown>[],
  field: string,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const raw = row[field]
    // Number(null) is 0 — a null cell must not drag the range to zero.
    if (raw === null || raw === undefined) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return Number.isFinite(min) ? [min, max] : null
}
