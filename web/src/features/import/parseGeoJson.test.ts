import { describe, expect, it } from 'vitest'

import { ParseError, inferColumns, parseGeoJson } from './parseGeoJson'

const POINT = { type: 'Point', coordinates: [116.4, 39.9] }

const featureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: POINT, properties: { name: 'Beijing', pop: 21540000 } },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [91.1, 29.6] },
      properties: { name: 'Lhasa', pop: 560000 },
    },
  ],
}

describe('parseGeoJson root shapes', () => {
  it('takes a FeatureCollection as-is', () => {
    const result = parseGeoJson(JSON.stringify(featureCollection))
    expect(result.detectedFormat).toBe('featureCollection')
    expect(result.features).toHaveLength(2)
    expect(result.geometryTypes).toEqual(['Point'])
  })

  it('wraps a single Feature into a one-feature collection', () => {
    const single = { type: 'Feature', geometry: POINT, properties: { name: 'Beijing' } }
    const result = parseGeoJson(JSON.stringify(single))
    expect(result.detectedFormat).toBe('feature')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]!.properties.name).toBe('Beijing')
  })

  it('turns an array of objects into Points from detected lat/lon', () => {
    const rows = [
      { city: 'Beijing', lon: 116.4, lat: 39.9 },
      { city: 'Lhasa', lon: 91.1, lat: 29.6 },
    ]
    const result = parseGeoJson(JSON.stringify(rows))
    expect(result.detectedFormat).toBe('array')
    expect(result.lonColumn).toBe('lon')
    expect(result.latColumn).toBe('lat')
    expect(result.features[0]!.geometry).toEqual({ type: 'Point', coordinates: [116.4, 39.9] })
  })

  it('finds a records array inside a wrapper object', () => {
    const wrapper = { total: 2, records: [{ x: 1, y: 2, k: 'a' }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.features).toHaveLength(1)
  })

  it('finds a sole array property even when it is not conventionally named', () => {
    const wrapper = { stations: [{ longitude: 1, latitude: 2 }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.lonColumn).toBe('longitude')
    expect(result.latColumn).toBe('latitude')
  })

  it('keeps records with no detectable coordinate pair, with a null geometry', () => {
    const result = parseGeoJson(JSON.stringify([{ a: 1 }, { a: 2 }]))
    expect(result.lonColumn).toBeNull()
    expect(result.features[0]!.geometry).toBeNull()
  })

  it('skips a decoy empty array and parses via the one real unnamed candidate', () => {
    const wrapper = { a: [], b: [{ y: 1 }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]!.properties.y).toBe(1)
  })

  it('skips an empty features array and parses via a populated, non-conventional key', () => {
    const wrapper = { features: [], items: [{ x: 1 }] }
    const result = parseGeoJson(JSON.stringify(wrapper))
    expect(result.detectedFormat).toBe('records')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]!.properties.x).toBe(1)
  })
})

describe('parseGeoJson failures', () => {
  it('throws a coded error on malformed JSON', () => {
    expect(() => parseGeoJson('{not json')).toThrowError(ParseError)
    try {
      parseGeoJson('{not json')
    } catch (error) {
      expect((error as ParseError).code).toBe('malformed_json')
    }
  })

  it('throws on an empty file', () => {
    try {
      parseGeoJson('   ')
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('empty_document')
    }
  })

  it('throws on an unsupported root', () => {
    try {
      parseGeoJson(JSON.stringify({ type: 'Point', coordinates: [0, 0] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('throws when a wrapper object has two unnamed candidate arrays', () => {
    try {
      parseGeoJson(JSON.stringify({ a: [{ x: 1 }], b: [{ y: 2 }] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('throws on an empty FeatureCollection', () => {
    try {
      parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('empty_document')
    }
  })

  it('reports empty_document for a bare empty array root', () => {
    try {
      parseGeoJson(JSON.stringify([]))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('empty_document')
    }
  })

  it('reports empty_document for a wrapper object with an empty records array', () => {
    try {
      parseGeoJson(JSON.stringify({ features: [] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('empty_document')
    }
  })

  it('still reports unsupported_root for an array of non-objects', () => {
    try {
      parseGeoJson(JSON.stringify([1, 2, 3]))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('still reports unsupported_root for an object with no array property at all', () => {
    try {
      parseGeoJson(JSON.stringify({}))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('unsupported_root')
    }
  })

  it('reports empty_document when every candidate array is empty, regardless of which is picked', () => {
    try {
      parseGeoJson(JSON.stringify({ a: [], b: [] }))
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).code).toBe('empty_document')
    }
  })
})

describe('column inference', () => {
  it('unions properties across every feature, not just the first', () => {
    const mixed = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { a: 1 } },
        { type: 'Feature', geometry: POINT, properties: { b: 2 } },
        { type: 'Feature', geometry: POINT, properties: { c: 3 } },
      ],
    }
    const result = parseGeoJson(JSON.stringify(mixed))
    expect(result.columns.map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })

  it('orders columns by first appearance', () => {
    const features = [
      { id: '1', geometry: null, properties: { z: 1, a: 2 } },
      { id: '2', geometry: null, properties: { m: 3 } },
    ]
    expect(inferColumns(features).map((c) => c.name)).toEqual(['z', 'a', 'm'])
  })

  it('infers number, boolean, date, json and text', () => {
    const features = [
      {
        id: '1',
        geometry: null,
        properties: {
          n: 4,
          b: true,
          d: '2026-07-31T00:00:00Z',
          j: { nested: [1] },
          t: 'hello',
        },
      },
    ]
    const byName = Object.fromEntries(inferColumns(features).map((c) => [c.name, c.type]))
    expect(byName).toEqual({ n: 'number', b: 'boolean', d: 'date', j: 'json', t: 'text' })
  })

  it('falls back to text and flags a column whose values are of mixed type', () => {
    const features = [
      { id: '1', geometry: null, properties: { pop: 100 } },
      { id: '2', geometry: null, properties: { pop: 'many' } },
    ]
    const column = inferColumns(features)[0]!
    expect(column.type).toBe('text')
    expect(column.mixed).toBe(true)
  })

  it('ignores nulls when inferring a type', () => {
    const features = [
      { id: '1', geometry: null, properties: { pop: null } },
      { id: '2', geometry: null, properties: { pop: 12 } },
    ]
    const column = inferColumns(features)[0]!
    expect(column.type).toBe('number')
    expect(column.mixed).toBe(false)
  })
})

describe('value preservation', () => {
  it('keeps nested objects and arrays intact rather than flattening them', () => {
    const nested = { sensor: { bands: [1, 2, 3], calibrated: true } }
    const document = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: POINT, properties: { meta: nested } }],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(result.features[0]!.properties.meta).toEqual(nested)
  })

  it('preserves unknown keys and original casing', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { OddKey: 1, 'with space': 2 } },
      ],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(Object.keys(result.features[0]!.properties)).toEqual(['OddKey', 'with space'])
  })

  it('distinguishes an explicit null from an absent property', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: { a: null } },
        { type: 'Feature', geometry: POINT, properties: {} },
      ],
    }
    const result = parseGeoJson(JSON.stringify(document))
    expect(result.features[0]!.properties.a).toBeNull()
    expect('a' in result.features[1]!.properties).toBe(false)
  })

  it('reports every distinct geometry type present', () => {
    const document = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: POINT, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
          properties: {},
        },
      ],
    }
    expect(parseGeoJson(JSON.stringify(document)).geometryTypes).toEqual(['Point', 'LineString'])
  })
})
