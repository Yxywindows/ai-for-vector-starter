import { describe, expect, it } from 'vitest'

import { buildCategorizedClasses, buildGraduatedClasses, RAMPS, sampleRamp } from './ramps'

describe('sampleRamp', () => {
  it('returns exactly the requested number of colours', () => {
    expect(sampleRamp('viridis', 7)).toHaveLength(7)
  })

  it('returns valid hex triplets', () => {
    for (const color of sampleRamp('spectral', 9)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('starts and ends on the ramp anchors', () => {
    const colors = sampleRamp('blues', 5)
    expect(colors[0]).toBe(RAMPS.blues[0])
    expect(colors.at(-1)).toBe(RAMPS.blues.at(-1))
  })

  it('handles the degenerate counts', () => {
    expect(sampleRamp('greys', 0)).toEqual([])
    expect(sampleRamp('greys', 1)).toHaveLength(1)
  })
})

describe('buildGraduatedClasses', () => {
  it('covers the range contiguously with an open-ended top class', () => {
    const classes = buildGraduatedClasses(0, 100, 4, 'blues')
    expect(classes).toHaveLength(4)
    expect(classes[0]?.min).toBe(0)
    expect(classes[0]?.max).toBe(25)
    expect(classes[1]?.min).toBe(25)
    expect(classes.at(-1)?.max).toBeNull()
  })

  it('labels each class', () => {
    expect(buildGraduatedClasses(0, 10, 2, 'blues')[0]?.label).toBe('0.0 – 5.0')
  })
})

describe('buildCategorizedClasses', () => {
  it('deduplicates values and assigns one colour each', () => {
    const classes = buildCategorizedClasses(['a', 'b', 'a', 'c'], 'viridis')
    expect(classes.map((c) => c.value)).toEqual(['a', 'b', 'c'])
    expect(new Set(classes.map((c) => c.color)).size).toBe(3)
  })
})
