import { describe, expect, it, vi } from 'vitest'

import { EditQueue, geometryTypeToDrawType } from './editSession'

const POINT: GeoJSON.Geometry = { type: 'Point', coordinates: [1, 2] }

describe('geometryTypeToDrawType', () => {
  it('maps PostGIS geometry types to OL draw types', () => {
    expect(geometryTypeToDrawType('POINT')).toBe('Point')
    expect(geometryTypeToDrawType('MULTIPOINT')).toBe('Point')
    expect(geometryTypeToDrawType('LINESTRING')).toBe('LineString')
    expect(geometryTypeToDrawType('MULTILINESTRING')).toBe('LineString')
    expect(geometryTypeToDrawType('POLYGON')).toBe('Polygon')
    expect(geometryTypeToDrawType('MULTIPOLYGON')).toBe('Polygon')
  })

  it('is case insensitive', () => {
    expect(geometryTypeToDrawType('Point')).toBe('Point')
  })

  it('returns null for an unknown or missing type', () => {
    expect(geometryTypeToDrawType('GEOMETRYCOLLECTION')).toBeNull()
    expect(geometryTypeToDrawType(null)).toBeNull()
  })
})

describe('EditQueue', () => {
  it('starts empty', () => {
    expect(new EditQueue().pending).toEqual([])
  })

  it('collapses repeated updates to the same feature', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '1', geometry: POINT })
    queue.enqueue({
      kind: 'update',
      featureId: '1',
      geometry: { type: 'Point', coordinates: [9, 9] },
    })
    expect(queue.pending).toHaveLength(1)
    expect((queue.pending[0] as { geometry: GeoJSON.Point }).geometry.coordinates).toEqual([9, 9])
  })

  it('a delete supersedes a pending update for the same feature', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '1', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '1' })
    expect(queue.pending).toEqual([{ kind: 'delete', featureId: '1' }])
  })

  it('deleting a not-yet-saved creation just drops it', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'create', tempId: 't1', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: 't1' })
    expect(queue.pending).toEqual([])
  })

  it('flush calls one handler per operation in order', async () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'create', tempId: 't1', geometry: POINT })
    queue.enqueue({ kind: 'update', featureId: '2', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '3' })

    const handlers = {
      create: vi.fn().mockResolvedValue('10'),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const result = await queue.flush(handlers)

    expect(handlers.create).toHaveBeenCalledWith(POINT)
    expect(handlers.update).toHaveBeenCalledWith('2', POINT)
    expect(handlers.remove).toHaveBeenCalledWith('3')
    expect(result.succeeded).toBe(3)
    expect(result.failures).toEqual([])
    expect(queue.pending).toEqual([])
  })

  it('keeps failed operations queued and reports them', async () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'update', featureId: '2', geometry: POINT })
    queue.enqueue({ kind: 'delete', featureId: '3' })

    const handlers = {
      create: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error('geometry is not valid')),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const result = await queue.flush(handlers)

    expect(result.succeeded).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.message).toMatch(/not valid/)
    expect(queue.pending).toHaveLength(1)
    expect(queue.pending[0]).toMatchObject({ kind: 'update', featureId: '2' })
  })

  it('discard empties the queue', () => {
    const queue = new EditQueue()
    queue.enqueue({ kind: 'delete', featureId: '1' })
    queue.discard()
    expect(queue.pending).toEqual([])
  })
})
