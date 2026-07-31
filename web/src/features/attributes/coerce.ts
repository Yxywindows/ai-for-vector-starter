const INTEGER_TYPES = new Set(['integer', 'bigint', 'smallint'])
const REAL_TYPES = new Set(['double precision', 'numeric', 'real', 'decimal'])
const JSON_TYPES = new Set(['json', 'jsonb'])
const TRUE_VALUES = new Set(['true', 't', '1', 'yes'])
const FALSE_VALUES = new Set(['false', 'f', '0', 'no'])

/**
 * A table cell is always edited as text, but PostgreSQL wants the real type.
 * Coercion happens here rather than on the server so the user gets an
 * immediate, specific error instead of a 422 round trip.
 */
export function coerceValue(raw: string, dataType: string): unknown {
  if (raw === '') return null
  const type = dataType.toLowerCase()

  if (INTEGER_TYPES.has(type)) {
    const value = Number(raw)
    if (!Number.isInteger(value)) throw new Error(`"${raw}" is not a whole number`)
    return value
  }

  if (REAL_TYPES.has(type)) {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number`)
    return value
  }

  if (type === 'boolean') {
    const normalised = raw.trim().toLowerCase()
    if (TRUE_VALUES.has(normalised)) return true
    if (FALSE_VALUES.has(normalised)) return false
    throw new Error(`"${raw}" is not a boolean`)
  }

  if (JSON_TYPES.has(type)) {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`"${raw}" is not valid JSON`)
    }
  }

  return raw
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
