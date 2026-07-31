import { describe, expect, it } from 'vitest'

import type { DraftColumn, DraftFeature } from './parseGeoJson'
import { coerceCellInput, validateCell, validateDraft } from './validation'

const columns: DraftColumn[] = [{ name: 'name', type: 'text', mixed: false }]

function features(...geometries: (Record<string, unknown> | null)[]): DraftFeature[] {
  return geometries.map((geometry, index) => ({
    id: String(index),
    geometry,
    properties: { name: 'x' },
  }))
}

describe('validateDraft', () => {
  it('accepts every supported geometry type', () => {
    const supported = [
      { type: 'Point', coordinates: [1, 2] },
      { type: 'MultiPoint', coordinates: [[1, 2]] },
      { type: 'LineString', coordinates: [[1, 2], [3, 4]] },
      { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] },
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    ]
    const { errors } = validateDraft(features(...supported), columns)
    expect(errors).toEqual([])
  })

  it('reports a missing geometry against its feature index', () => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: [1, 2] }, null), columns)
    expect(errors).toEqual([
      expect.objectContaining({ code: 'missing_geometry', featureIndex: 1 }),
    ])
  })

  it('rejects an unsupported geometry type', () => {
    const { errors } = validateDraft(features({ type: 'GeometryCollection' }), columns)
    expect(errors[0]!.code).toBe('unsupported_geometry_type')
  })

  it.each([
    [[181, 0]],
    [[-181, 0]],
    [[0, 91]],
    [[0, -91]],
  ])('rejects out-of-range coordinates %j', (coordinates) => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates }), columns)
    expect(errors[0]!.code).toBe('coordinate_out_of_range')
  })

  it.each([[NaN], [Infinity], [-Infinity]])('rejects non-finite coordinate %s', (bad) => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: [bad, 0] }), columns)
    expect(errors[0]!.code).toBe('coordinate_not_finite')
  })

  it('rejects malformed coordinates', () => {
    const { errors } = validateDraft(features({ type: 'Point', coordinates: 'nope' }), columns)
    expect(errors[0]!.code).toBe('malformed_coordinates')
  })

  it('rejects a LineString with fewer than two positions', () => {
    const { errors } = validateDraft(features({ type: 'LineString', coordinates: [[1, 2]] }), columns)
    expect(errors[0]!.code).toBe('malformed_coordinates')
  })

  it('reports an empty draft', () => {
    const { errors } = validateDraft([], columns)
    expect(errors[0]!.code).toBe('empty_document')
  })

  it('warns rather than errors on a mixed-type column', () => {
    const mixed: DraftColumn[] = [{ name: 'pop', type: 'text', mixed: true }]
    const { errors, warnings } = validateDraft(
      features({ type: 'Point', coordinates: [1, 2] }),
      mixed,
    )
    expect(errors).toEqual([])
    expect(warnings[0]!.code).toBe('mixed_property_type')
  })
})

describe('validateCell', () => {
  it('accepts null for every type', () => {
    for (const type of ['text', 'number', 'boolean', 'date', 'json'] as const) {
      expect(validateCell(null, type)).toEqual({ ok: true, value: null })
    }
  })

  it('rejects a non-numeric value in a number column', () => {
    expect(validateCell('many', 'number').ok).toBe(false)
  })

  it('rejects a non-finite number', () => {
    expect(validateCell(Infinity, 'number').ok).toBe(false)
  })
})

describe('coerceCellInput', () => {
  it('returns null for an empty string rather than an empty string', () => {
    expect(coerceCellInput('', 'text')).toEqual({ ok: true, value: null })
    expect(coerceCellInput('   ', 'number')).toEqual({ ok: true, value: null })
  })

  it('parses numbers, booleans and JSON', () => {
    expect(coerceCellInput('42', 'number')).toEqual({ ok: true, value: 42 })
    expect(coerceCellInput('true', 'boolean')).toEqual({ ok: true, value: true })
    expect(coerceCellInput('{"a":1}', 'json')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports invalid JSON without throwing', () => {
    const result = coerceCellInput('{not json', 'json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/json/i)
  })

  it('reports a non-numeric entry in a number column', () => {
    const result = coerceCellInput('lots', 'number')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/number/i)
  })

  it('reports an unparseable date', () => {
    expect(coerceCellInput('not-a-date', 'date').ok).toBe(false)
    expect(coerceCellInput('2026-07-31', 'date').ok).toBe(true)
  })
})
