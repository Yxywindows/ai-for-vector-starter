/**
 * Client mirror of `app/services/geojson_validation.py`.
 *
 * Same rules, same codes, so a problem the user sees in the preview is the
 * same problem the server would report. This is a convenience, not a
 * security boundary: the server re-validates everything and trusts none of it.
 */

import type { DraftColumn, DraftColumnType, DraftFeature } from './parseGeoJson'

export interface DraftIssue {
  featureIndex: number
  field: string | null
  code: string
  message: string
}

const SUPPORTED_GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
])

/** Nesting depth of `coordinates` before reaching a [x, y] position. */
const COORDINATE_DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

const MIN_POSITIONS: Record<string, number> = {
  LineString: 2,
  MultiLineString: 2,
  Polygon: 4,
  MultiPolygon: 4,
}

/** Types whose innermost lists are linear rings that must be closed. */
const RING_TYPES = new Set(['Polygon', 'MultiPolygon'])

const isPosition = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.length <= 3 &&
  value.every((entry) => typeof entry === 'number')

const positionsEqual = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])

function issue(featureIndex: number, code: string, message: string): DraftIssue {
  return { featureIndex, field: null, code, message }
}

/**
 * True when `ring` has at least 3 positions and its first and last differ —
 * the case the server closes automatically rather than rejecting. Mirrors
 * `_close_ring` in `geojson_validation.py`, but computed virtually: this
 * module reports on the draft, it never rewrites it.
 */
const isOpenRing = (ring: unknown[]): boolean =>
  ring.length >= 3 && !positionsEqual(ring[0], ring[ring.length - 1])

function checkStructure(
  node: unknown,
  depth: number,
  type: string,
  index: number,
  errors: DraftIssue[],
  warnings: DraftIssue[],
): boolean {
  if (depth === 0) {
    if (!isPosition(node)) {
      errors.push(issue(index, 'malformed_coordinates', 'Expected a [longitude, latitude] pair'))
      return false
    }
    return true
  }
  if (!Array.isArray(node) || node.length === 0) {
    errors.push(issue(index, 'malformed_coordinates', `Expected an array of ${type} coordinates`))
    return false
  }
  if (depth === 1) {
    const minimum = MIN_POSITIONS[type]
    // An unclosed ring is closed virtually before the minimum is applied —
    // matching the server's ordering — so an open triangle (3 positions,
    // effectively 4 once closed) is accepted, not rejected.
    const open = RING_TYPES.has(type) && isOpenRing(node)
    const effectiveLength = open ? node.length + 1 : node.length
    if (minimum !== undefined && effectiveLength < minimum) {
      errors.push(
        issue(
          index,
          'malformed_coordinates',
          `${type} needs at least ${minimum} positions, got ${node.length}`,
        ),
      )
      return false
    }
    if (open) {
      warnings.push(
        issue(index, 'ring_auto_closed', 'Polygon ring was not closed and was closed automatically'),
      )
    }
  }
  return node.every((child) => checkStructure(child, depth - 1, type, index, errors, warnings))
}

function positions(node: unknown, depth: number): number[][] {
  if (depth === 0) return [node as number[]]
  return (node as unknown[]).flatMap((child) => positions(child, depth - 1))
}

function checkGeometry(
  geometry: Record<string, unknown> | null,
  index: number,
  errors: DraftIssue[],
  warnings: DraftIssue[],
): void {
  if (!geometry) {
    errors.push(issue(index, 'missing_geometry', 'Feature has no geometry'))
    return
  }
  const type = geometry.type
  if (typeof type !== 'string' || !SUPPORTED_GEOMETRY_TYPES.has(type)) {
    errors.push(
      issue(index, 'unsupported_geometry_type', `Geometry type "${String(type)}" is not supported`),
    )
    return
  }
  const depth = COORDINATE_DEPTH[type]!
  if (!checkStructure(geometry.coordinates, depth, type, index, errors, warnings)) return

  for (const [longitude, latitude] of positions(geometry.coordinates, depth)) {
    if (!Number.isFinite(longitude!) || !Number.isFinite(latitude!)) {
      errors.push(issue(index, 'coordinate_not_finite', 'Coordinate is NaN or infinite'))
      return
    }
    if (longitude! < -180 || longitude! > 180 || latitude! < -90 || latitude! > 90) {
      errors.push(
        issue(
          index,
          'coordinate_out_of_range',
          `Coordinate (${longitude}, ${latitude}) is outside longitude [-180, 180] / latitude [-90, 90]`,
        ),
      )
      return
    }
  }
}

export function validateDraft(
  features: DraftFeature[],
  columns: DraftColumn[],
): { errors: DraftIssue[]; warnings: DraftIssue[] } {
  const errors: DraftIssue[] = []
  const warnings: DraftIssue[] = []

  if (features.length === 0) {
    errors.push(issue(-1, 'empty_document', 'There are no features to import'))
    return { errors, warnings }
  }

  features.forEach((feature, index) => checkGeometry(feature.geometry, index, errors, warnings))

  for (const column of columns) {
    if (!column.mixed) continue
    warnings.push({
      featureIndex: -1,
      field: column.name,
      code: 'mixed_property_type',
      message: `"${column.name}" holds more than one value type and is stored as text`,
    })
  }

  return { errors, warnings }
}

type CellOutcome = { ok: true; value: unknown } | { ok: false; message: string }

export function validateCell(value: unknown, type: DraftColumnType): CellOutcome {
  if (value === null || value === undefined) return { ok: true, value: null }
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: 'Not a finite number' }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: 'Not true or false' }
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? { ok: true, value }
        : { ok: false, message: 'Not a recognisable date' }
    default:
      return { ok: true, value }
  }
}

/** Turn raw editor text into a typed value. Empty input always means null. */
export function coerceCellInput(raw: string, type: DraftColumnType): CellOutcome {
  if (raw.trim() === '') return { ok: true, value: null }

  switch (type) {
    case 'number': {
      const parsed = Number(raw)
      return Number.isFinite(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, message: `"${raw}" is not a number` }
    }
    case 'boolean': {
      const normalised = raw.trim().toLowerCase()
      if (['true', 'yes', '1'].includes(normalised)) return { ok: true, value: true }
      if (['false', 'no', '0'].includes(normalised)) return { ok: true, value: false }
      return { ok: false, message: `"${raw}" is not true or false` }
    }
    case 'date':
      return Number.isNaN(Date.parse(raw))
        ? { ok: false, message: `"${raw}" is not a recognisable date` }
        : { ok: true, value: raw }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(raw) }
      } catch (error) {
        return { ok: false, message: `Invalid JSON: ${(error as Error).message}` }
      }
    default:
      return { ok: true, value: raw }
  }
}
