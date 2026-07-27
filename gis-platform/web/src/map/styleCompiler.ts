import type { FeatureLike } from 'ol/Feature'
import Circle from 'ol/style/Circle'
import Fill from 'ol/style/Fill'
import RegularShape from 'ol/style/RegularShape'
import Stroke from 'ol/style/Stroke'
import Style, { type StyleLike } from 'ol/style/Style'
import Text from 'ol/style/Text'

import type { Renderer, StyleSpec, VectorStyle } from '../api/types'

const FALLBACK = '#9ca3af'

export function hexToRgba(hex: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  const value = Number.parseInt(match?.[1] ?? '9ca3af', 16)
  const alpha = Math.min(1, Math.max(0, opacity))
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

/**
 * Which colour a feature gets. Categorized compares loosely (`String(a) ===
 * String(b)`) because a numeric column arriving as a string from MVT
 * attributes should still match a numeric category. Graduated treats a class
 * as `[min, max)` so a value sitting exactly on a boundary lands in the upper
 * class, and an open-ended final class (`max: null`) catches the tail.
 */
export function resolveColor(
  renderer: Renderer,
  properties: (key: string) => unknown,
  fallback: string,
): string {
  if (renderer.type === 'single') return fallback

  const raw = properties(renderer.field)

  if (renderer.type === 'categorized') {
    const match = renderer.categories.find((category) => String(category.value) === String(raw))
    return match?.color ?? renderer.fallbackColor
  }

  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) return FALLBACK

  const match = renderer.classes.find((cls) => {
    const lower = cls.min ?? Number.NEGATIVE_INFINITY
    const upper = cls.max ?? Number.POSITIVE_INFINITY
    return numeric >= lower && numeric < upper
  })
  return match?.color ?? FALLBACK
}

function buildImage(spec: VectorStyle, fillColor: string) {
  const fill = new Fill({ color: hexToRgba(fillColor, spec.fill.opacity) })
  const stroke = new Stroke({
    color: hexToRgba(spec.stroke.color, 1),
    width: spec.stroke.width,
  })
  const { shape, radius } = spec.marker

  if (shape === 'circle') return new Circle({ radius, fill, stroke })
  if (shape === 'square') {
    return new RegularShape({ points: 4, radius, angle: Math.PI / 4, fill, stroke })
  }
  return new RegularShape({ points: 3, radius, angle: 0, fill, stroke })
}

function compileVector(spec: VectorStyle): StyleLike {
  return (feature: FeatureLike) => {
    const read = (key: string) => feature.get(key)
    const color = resolveColor(spec.renderer, read, spec.fill.color)

    const style = new Style({
      fill: new Fill({ color: hexToRgba(color, spec.fill.opacity) }),
      stroke: new Stroke({
        color: hexToRgba(spec.stroke.color, 1),
        width: spec.stroke.width,
        lineDash: spec.stroke.dash ?? undefined,
      }),
      image: buildImage(spec, color),
    })

    if (spec.label) {
      const value = read(spec.label.field)
      style.setText(
        new Text({
          text: value === null || value === undefined ? '' : String(value),
          font: `${spec.label.size}px system-ui, sans-serif`,
          fill: new Fill({ color: hexToRgba(spec.label.color, 1) }),
          stroke: new Stroke({ color: hexToRgba(spec.label.haloColor, 1), width: 3 }),
          offsetY: -(spec.marker.radius + spec.label.size * 0.6),
          overflow: true,
        }),
      )
    }

    return style
  }
}

/** Raster symbology is applied server-side by rio-tiler, so there is nothing to compile. */
export function compileStyle(spec: StyleSpec | null): StyleLike | undefined {
  if (!spec || spec.kind !== 'vector') return undefined
  return compileVector(spec)
}
