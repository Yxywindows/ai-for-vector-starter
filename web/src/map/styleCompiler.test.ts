import type { FeatureLike } from 'ol/Feature'
import type Style from 'ol/style/Style'
import { describe, expect, it } from 'vitest'

import type { VectorStyle } from '../api/types'
import { compileStyle, hexToRgba } from './styleCompiler'

function fakeFeature(properties: Record<string, unknown>): FeatureLike {
  return {
    get: (key: string) => properties[key],
    getGeometry: () => ({ getType: () => 'Point' }),
  } as unknown as FeatureLike
}

const singleStyle: VectorStyle = {
  kind: 'vector',
  renderer: { type: 'single' },
  fill: { color: '#3b82f6', opacity: 0.6 },
  stroke: { color: '#1e3a8a', width: 2, dash: null },
  marker: { shape: 'circle', radius: 5 },
  label: null,
}

function styleFor(spec: VectorStyle, properties: Record<string, unknown> = {}): Style {
  const compiled = compileStyle(spec)
  expect(typeof compiled).toBe('function')
  const result = (compiled as (f: FeatureLike, r: number) => Style)(fakeFeature(properties), 1)
  return result
}

describe('hexToRgba', () => {
  it('converts a hex triplet and opacity to an rgba string', () => {
    expect(hexToRgba('#3b82f6', 0.5)).toBe('rgba(59, 130, 246, 0.5)')
  })

  it('clamps opacity into 0..1', () => {
    expect(hexToRgba('#000000', 2)).toBe('rgba(0, 0, 0, 1)')
    expect(hexToRgba('#000000', -1)).toBe('rgba(0, 0, 0, 0)')
  })

  it('falls back to grey for a malformed colour', () => {
    expect(hexToRgba('nonsense', 1)).toBe('rgba(156, 163, 175, 1)')
  })
})

describe('compileStyle', () => {
  it('returns undefined for a null spec so OL uses its default', () => {
    expect(compileStyle(null)).toBeUndefined()
  })

  it('returns undefined for a raster spec (rasters are styled server-side)', () => {
    expect(
      compileStyle({ kind: 'raster', bands: [1], rescale: null, colormap: null, opacity: 1 }),
    ).toBeUndefined()
  })

  it('applies fill, stroke and radius for a single-symbol renderer', () => {
    const style = styleFor(singleStyle)
    expect(style.getFill()?.getColor()).toBe('rgba(59, 130, 246, 0.6)')
    expect(style.getStroke()?.getColor()).toBe('rgba(30, 58, 138, 1)')
    expect(style.getStroke()?.getWidth()).toBe(2)
    expect(style.getImage()).toBeTruthy()
  })

  it('passes the dash array through', () => {
    const style = styleFor({ ...singleStyle, stroke: { ...singleStyle.stroke, dash: [4, 2] } })
    expect(style.getStroke()?.getLineDash()).toEqual([4, 2])
  })

  it('picks the matching category colour', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'landuse',
        fallbackColor: '#9ca3af',
        categories: [
          { color: '#ff0000', value: 'urban', min: null, max: null, label: null },
          { color: '#00ff00', value: 'forest', min: null, max: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { landuse: 'forest' }).getFill()?.getColor()).toBe('rgba(0, 255, 0, 0.6)')
  })

  it('uses the fallback colour when no category matches', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'landuse',
        fallbackColor: '#9ca3af',
        categories: [{ color: '#ff0000', value: 'urban', min: null, max: null, label: null }],
      },
    }
    expect(styleFor(spec, { landuse: 'water' }).getFill()?.getColor()).toBe(
      'rgba(156, 163, 175, 0.6)',
    )
  })

  it('compares category values loosely so numeric fields still match', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'categorized',
        field: 'code',
        fallbackColor: '#9ca3af',
        categories: [{ color: '#ff0000', value: 3, min: null, max: null, label: null }],
      },
    }
    expect(styleFor(spec, { code: '3' }).getFill()?.getColor()).toBe('rgba(255, 0, 0, 0.6)')
  })

  it('selects the graduated class containing the value', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [
          { color: '#eff6ff', min: 0, max: 100, value: null, label: null },
          { color: '#60a5fa', min: 100, max: 1000, value: null, label: null },
          { color: '#1d4ed8', min: 1000, max: null, value: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { pop: 500 }).getFill()?.getColor()).toBe('rgba(96, 165, 250, 0.6)')
    expect(styleFor(spec, { pop: 5000 }).getFill()?.getColor()).toBe('rgba(29, 78, 216, 0.6)')
  })

  it('treats a class boundary as belonging to the upper class', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [
          { color: '#eff6ff', min: 0, max: 100, value: null, label: null },
          { color: '#60a5fa', min: 100, max: 1000, value: null, label: null },
        ],
      },
    }
    expect(styleFor(spec, { pop: 100 }).getFill()?.getColor()).toBe('rgba(96, 165, 250, 0.6)')
  })

  it('falls back for a non-numeric value under a graduated renderer', () => {
    const spec: VectorStyle = {
      ...singleStyle,
      renderer: {
        type: 'graduated',
        field: 'pop',
        method: 'equal_interval',
        classes: [{ color: '#eff6ff', min: 0, max: 100, value: null, label: null }],
      },
    }
    expect(styleFor(spec, { pop: 'unknown' }).getFill()?.getColor()).toBe(
      'rgba(156, 163, 175, 0.6)',
    )
  })

  it('adds a text style when a label field is configured', () => {
    const style = styleFor(
      { ...singleStyle, label: { field: 'name', color: '#111827', size: 12, haloColor: '#ffffff' } },
      { name: 'Beijing' },
    )
    expect(style.getText()?.getText()).toBe('Beijing')
    expect(style.getText()?.getFont()).toContain('12px')
  })

  it('omits the text style when the label field is empty on this feature', () => {
    const style = styleFor(
      { ...singleStyle, label: { field: 'name', color: '#111827', size: 12, haloColor: '#ffffff' } },
      {},
    )
    expect(style.getText()?.getText()).toBeFalsy()
  })
})
