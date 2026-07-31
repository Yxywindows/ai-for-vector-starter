/**
 * Parse a JSON/GeoJSON file into a normalised import draft.
 *
 * Pure and synchronous: no DOM, no network, no worker. The worker in
 * `parseWorker.ts` is only transport around this, so the interesting logic is
 * testable without any of that machinery.
 *
 * Nothing is discarded. Unknown property keys, original casing, nested objects
 * and arrays, and the difference between an explicit null and an absent key all
 * survive to the draft and back out to the server.
 */

export type DraftColumnType = 'text' | 'number' | 'boolean' | 'date' | 'json'

export interface DraftColumn {
  name: string
  type: DraftColumnType
  /** True when values of more than one type appear; the column falls back to text. */
  mixed: boolean
}

export interface DraftFeature {
  id: string
  geometry: Record<string, unknown> | null
  properties: Record<string, unknown>
}

export interface ParseWarning {
  code: string
  message: string
  field?: string
}

export type DetectedFormat = 'featureCollection' | 'feature' | 'array' | 'records'

export interface ParseResult {
  detectedFormat: DetectedFormat
  columns: DraftColumn[]
  features: DraftFeature[]
  geometryTypes: string[]
  lonColumn: string | null
  latColumn: string | null
  warnings: ParseWarning[]
}

export class ParseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ParseError'
    this.code = code
  }
}

const RECORD_ARRAY_KEYS = ['features', 'records', 'data', 'items', 'rows']
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x']
const LAT_NAMES = ['lat', 'latitude', 'y']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRecordArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && value.every(isObject)

function valueType(value: unknown): DraftColumnType {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'json'
  if (typeof value === 'string' && ISO_DATE.test(value)) return 'date'
  return 'text'
}

/** Union the property keys of every feature — never just the first. */
export function inferColumns(features: DraftFeature[]): DraftColumn[] {
  const order: string[] = []
  const types = new Map<string, Set<DraftColumnType>>()

  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!types.has(key)) {
        types.set(key, new Set())
        order.push(key)
      }
      if (value !== null && value !== undefined) types.get(key)!.add(valueType(value))
    }
  }

  return order.map((name) => {
    const seen = types.get(name)!
    const mixed = seen.size > 1
    const type: DraftColumnType = mixed ? 'text' : ([...seen][0] ?? 'text')
    return { name, type, mixed }
  })
}

function detectColumn(columns: DraftColumn[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    const match = columns.find(
      (column) => column.name.toLowerCase() === candidate && column.type === 'number',
    )
    if (match) return match.name
  }
  return null
}

/** Build a Point from two property values, or null if either is unusable. */
export function buildPointGeometry(
  properties: Record<string, unknown>,
  lon: string | null,
  lat: string | null,
): Record<string, unknown> | null {
  if (!lon || !lat) return null
  const x = properties[lon]
  const y = properties[lat]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { type: 'Point', coordinates: [x, y] }
}

function toDraftFeatures(
  items: { geometry: Record<string, unknown> | null; properties: Record<string, unknown> }[],
): DraftFeature[] {
  return items.map((item, index) => ({
    id: String(index),
    geometry: item.geometry,
    properties: item.properties,
  }))
}

function fromFeatureArray(raw: unknown[]): DraftFeature[] {
  return toDraftFeatures(
    raw.map((entry) => {
      if (!isObject(entry)) {
        throw new ParseError('unsupported_root', 'Every feature must be an object')
      }
      const geometry = entry.geometry
      return {
        geometry: isObject(geometry) ? geometry : null,
        properties: isObject(entry.properties) ? entry.properties : {},
      }
    }),
  )
}

export function parseGeoJson(text: string): ParseResult {
  if (!text.trim()) {
    throw new ParseError('empty_document', 'The file is empty')
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new ParseError('malformed_json', (error as Error).message)
  }

  let detectedFormat: DetectedFormat
  let features: DraftFeature[]
  let derivesGeometry = false

  if (isObject(root) && root.type === 'FeatureCollection') {
    if (!Array.isArray(root.features)) {
      throw new ParseError('unsupported_root', 'FeatureCollection.features must be an array')
    }
    detectedFormat = 'featureCollection'
    features = fromFeatureArray(root.features)
  } else if (isObject(root) && root.type === 'Feature') {
    detectedFormat = 'feature'
    features = fromFeatureArray([root])
  } else if (isRecordArray(root)) {
    detectedFormat = 'array'
    features = toDraftFeatures(root.map((entry) => ({ geometry: null, properties: entry })))
    derivesGeometry = true
  } else if (isObject(root)) {
    const named = RECORD_ARRAY_KEYS.find((key) => isRecordArray(root[key]))
    const candidates = Object.keys(root).filter((key) => isRecordArray(root[key]))
    const key = named ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!key) {
      throw new ParseError(
        'unsupported_root',
        candidates.length > 1
          ? 'The file has more than one candidate records array; none is named recognisably'
          : 'The file has no recognisable records array',
      )
    }
    detectedFormat = 'records'
    const rows = root[key] as Record<string, unknown>[]
    features = toDraftFeatures(rows.map((entry) => ({ geometry: null, properties: entry })))
    derivesGeometry = true
  } else {
    throw new ParseError('unsupported_root', 'The file root is not a supported structure')
  }

  if (features.length === 0) {
    throw new ParseError('empty_document', 'The file contains no features')
  }

  const columns = inferColumns(features)
  const warnings: ParseWarning[] = columns
    .filter((column) => column.mixed)
    .map((column) => ({
      code: 'mixed_property_type',
      field: column.name,
      message: `"${column.name}" holds more than one value type and is treated as text`,
    }))

  let lonColumn: string | null = null
  let latColumn: string | null = null
  if (derivesGeometry) {
    lonColumn = detectColumn(columns, LON_NAMES)
    latColumn = detectColumn(columns, LAT_NAMES)
    features = features.map((feature) => ({
      ...feature,
      geometry: buildPointGeometry(feature.properties, lonColumn, latColumn),
    }))
  }

  const geometryTypes = [
    ...new Set(
      features
        .map((feature) => feature.geometry?.type)
        .filter((type): type is string => typeof type === 'string'),
    ),
  ]

  return { detectedFormat, columns, features, geometryTypes, lonColumn, latColumn, warnings }
}
