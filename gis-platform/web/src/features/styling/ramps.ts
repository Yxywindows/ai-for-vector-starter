import type { ColorStop } from '../../api/types'

export type RampName = 'viridis' | 'blues' | 'oranges' | 'spectral' | 'greys'

/** Five anchor colours per ramp; `sampleRamp` interpolates between them. */
export const RAMPS: Record<RampName, string[]> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  blues: ['#eff6ff', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'],
  oranges: ['#fff7ed', '#fed7aa', '#fb923c', '#ea580c', '#7c2d12'],
  spectral: ['#d53e4f', '#fc8d59', '#ffffbf', '#99d594', '#3288bd'],
  greys: ['#f8fafc', '#cbd5e1', '#94a3b8', '#475569', '#0f172a'],
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match?.[1]) return [156, 163, 175]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

export function sampleRamp(name: RampName, count: number): string[] {
  const anchors = RAMPS[name]
  if (count <= 0) return []
  if (count === 1) return [anchors[Math.floor(anchors.length / 2)]!]

  return Array.from({ length: count }, (_unused, index) => {
    const position = (index / (count - 1)) * (anchors.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, anchors.length - 1)
    const t = position - lower
    const a = parseHex(anchors[lower]!)
    const b = parseHex(anchors[upper]!)
    return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
  })
}

export function buildGraduatedClasses(
  min: number,
  max: number,
  count: number,
  ramp: RampName,
): ColorStop[] {
  const colors = sampleRamp(ramp, count)
  const step = (max - min) / count
  return colors.map((color, index) => {
    const lower = min + step * index
    const upper = index === count - 1 ? null : min + step * (index + 1)
    return {
      color,
      min: lower,
      max: upper,
      value: null,
      label: upper === null ? `≥ ${lower.toFixed(1)}` : `${lower.toFixed(1)} – ${upper.toFixed(1)}`,
    }
  })
}

export function buildCategorizedClasses(values: (string | number)[], ramp: RampName): ColorStop[] {
  const unique = [...new Set(values)]
  const colors = sampleRamp(ramp, unique.length)
  return unique.map((value, index) => ({
    color: colors[index] ?? '#9ca3af',
    value,
    min: null,
    max: null,
    label: String(value),
  }))
}
