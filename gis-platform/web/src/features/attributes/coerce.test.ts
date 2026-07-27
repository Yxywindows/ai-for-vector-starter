import { describe, expect, it } from 'vitest'

import { coerceValue, formatValue } from './coerce'

describe('coerceValue', () => {
  it('parses integers', () => {
    expect(coerceValue('42', 'integer')).toBe(42)
    expect(coerceValue('42', 'bigint')).toBe(42)
  })

  it('parses reals', () => {
    expect(coerceValue('3.5', 'double precision')).toBe(3.5)
    expect(coerceValue('3.5', 'numeric')).toBe(3.5)
  })

  it('parses booleans from the usual spellings', () => {
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('FALSE', 'boolean')).toBe(false)
    expect(coerceValue('1', 'boolean')).toBe(true)
  })

  it('leaves text alone', () => {
    expect(coerceValue('  Beijing  ', 'text')).toBe('  Beijing  ')
  })

  it('maps an empty string to null for every type', () => {
    expect(coerceValue('', 'integer')).toBeNull()
    expect(coerceValue('', 'text')).toBeNull()
  })

  it('throws for a non-numeric value in a numeric column', () => {
    expect(() => coerceValue('abc', 'integer')).toThrow(/number/i)
  })

  it('throws for an unparseable boolean', () => {
    expect(() => coerceValue('maybe', 'boolean')).toThrow(/boolean/i)
  })

  it('parses JSON columns', () => {
    expect(coerceValue('{"a":1}', 'jsonb')).toEqual({ a: 1 })
    expect(() => coerceValue('{oops', 'jsonb')).toThrow(/json/i)
  })
})

describe('formatValue', () => {
  it('renders null as an empty string', () => {
    expect(formatValue(null)).toBe('')
    expect(formatValue(undefined)).toBe('')
  })

  it('stringifies objects', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}')
  })

  it('passes primitives through', () => {
    expect(formatValue(42)).toBe('42')
    expect(formatValue(true)).toBe('true')
  })
})
