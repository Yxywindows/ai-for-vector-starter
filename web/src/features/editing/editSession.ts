import type { Feature } from 'ol'
import GeoJSON from 'ol/format/GeoJSON'

export type DrawType = 'Point' | 'LineString' | 'Polygon'

const DRAW_TYPES: Record<string, DrawType> = {
  point: 'Point',
  multipoint: 'Point',
  linestring: 'LineString',
  multilinestring: 'LineString',
  polygon: 'Polygon',
  multipolygon: 'Polygon',
}

export function geometryTypeToDrawType(geometryType: string | null): DrawType | null {
  if (!geometryType) return null
  return DRAW_TYPES[geometryType.toLowerCase()] ?? null
}

const format = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })

export function featureToGeoJson(feature: Feature): GeoJSON.Geometry {
  const geometry = feature.getGeometry()
  if (!geometry) throw new Error('Feature has no geometry')
  return format.writeGeometryObject(geometry) as GeoJSON.Geometry
}

export type EditOperation =
  | { kind: 'create'; tempId: string; geometry: GeoJSON.Geometry }
  | { kind: 'update'; featureId: string; geometry: GeoJSON.Geometry }
  | { kind: 'delete'; featureId: string }

export interface FlushHandlers {
  create: (geometry: GeoJSON.Geometry) => Promise<string>
  update: (featureId: string, geometry: GeoJSON.Geometry) => Promise<void>
  remove: (featureId: string) => Promise<void>
}

export interface FlushResult {
  succeeded: number
  failures: Error[]
}

/**
 * A QGIS-style edit buffer.
 *
 * Edits accumulate locally so a user can drag a vertex twenty times without
 * twenty PATCHes, and can abandon the whole session. The queue collapses
 * redundant work: repeated updates to one feature keep only the last
 * geometry, a delete supersedes a pending update, and deleting something
 * that was never saved simply removes it from the queue.
 *
 * On flush, failures stay queued. A geometry the server rejects should not
 * silently vanish from the user's pending list.
 */
export class EditQueue {
  private operations: EditOperation[] = []

  get pending(): EditOperation[] {
    return [...this.operations]
  }

  enqueue(operation: EditOperation): void {
    if (operation.kind === 'update') {
      const index = this.operations.findIndex(
        (existing) =>
          (existing.kind === 'update' && existing.featureId === operation.featureId) ||
          (existing.kind === 'create' && existing.tempId === operation.featureId),
      )
      if (index >= 0) {
        const existing = this.operations[index]!
        this.operations[index] =
          existing.kind === 'create' ? { ...existing, geometry: operation.geometry } : operation
        return
      }
      this.operations.push(operation)
      return
    }

    if (operation.kind === 'delete') {
      const createdIndex = this.operations.findIndex(
        (existing) => existing.kind === 'create' && existing.tempId === operation.featureId,
      )
      if (createdIndex >= 0) {
        this.operations.splice(createdIndex, 1)
        return
      }
      this.operations = this.operations.filter(
        (existing) => !(existing.kind === 'update' && existing.featureId === operation.featureId),
      )
      this.operations.push(operation)
      return
    }

    this.operations.push(operation)
  }

  async flush(handlers: FlushHandlers): Promise<FlushResult> {
    const failures: Error[] = []
    const stillPending: EditOperation[] = []
    let succeeded = 0

    for (const operation of this.operations) {
      try {
        if (operation.kind === 'create') await handlers.create(operation.geometry)
        else if (operation.kind === 'update')
          await handlers.update(operation.featureId, operation.geometry)
        else await handlers.remove(operation.featureId)
        succeeded += 1
      } catch (error) {
        failures.push(error as Error)
        stillPending.push(operation)
      }
    }

    this.operations = stillPending
    return { succeeded, failures }
  }

  discard(): void {
    this.operations = []
  }
}
