import { describe, expect, it } from 'vitest'

import { defaultRasterStyle, defaultVectorStyle, distinctValues, numericRange } from './defaults'

describe('defaultVectorStyle', () => {
  it('is a valid single-symbol vector style', () => {
    const style = defaultVectorStyle()
    expect(style.kind).toBe('vector')
    expect(style.renderer.type).toBe('single')
    expect(style.fill.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(style.stroke.width).toBeGreaterThan(0)
    expect(style.label).toBeNull()
  })

  it('returns a fresh object each call so edits do not leak', () => {
    const first = defaultVectorStyle()
    first.fill.color = '#ff0000'
    expect(defaultVectorStyle().fill.color).not.toBe('#ff0000')
  })
})

describe('defaultRasterStyle', () => {
  it('renders band 1 at full opacity by default', () => {
    const style = defaultRasterStyle()
    expect(style.kind).toBe('raster')
    expect(style.bands).toEqual([1])
    expect(style.opacity).toBe(1)
    expect(style.rescale).toBeNull()
  })
})

describe('distinctValues', () => {
  it('returns unique, non-null values in first-seen order', () => {
    const rows = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: null }]
    expect(distinctValues(rows, 'k')).toEqual(['a', 'b'])
  })

  it('caps the result so a high-cardinality column cannot explode the UI', () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => ({ k: index }))
    expect(distinctValues(rows, 'k').length).toBeLessThanOrEqual(50)
  })
})

describe('numericRange', () => {
  it('returns the min and max of the numeric values', () => {
    expect(numericRange([{ v: 3 }, { v: 1 }, { v: 9 }], 'v')).toEqual([1, 9])
  })

  it('ignores non-numeric entries', () => {
    expect(numericRange([{ v: 3 }, { v: 'x' }, { v: null }], 'v')).toEqual([3, 3])
  })

  it('returns null when no numeric value is present', () => {
    expect(numericRange([{ v: 'x' }], 'v')).toBeNull()
  })
})
