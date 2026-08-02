import { API_BASE, apiFetch } from './client'
import type {
  AttributeFilter,
  AttributePage,
  Extent,
  FeatureCollection,
  FieldList,
  GeoFeature,
} from './types'

export interface GetFeaturesOptions {
  limit?: number
  /** ST_SimplifyPreserveTopology tolerance in degrees; omit for full detail. */
  simplify?: number
  /** Max coordinate decimal digits (server default 6). */
  precision?: number
  signal?: AbortSignal
}

export const getFeatures = (layerId: string, bbox: Extent, options: GetFeaturesOptions = {}) => {
  const params = new URLSearchParams({ bbox: bbox.join(',') })
  if (options.limit) params.set('limit', String(options.limit))
  if (options.simplify) params.set('simplify', String(options.simplify))
  if (options.precision !== undefined) params.set('precision', String(options.precision))
  return apiFetch<FeatureCollection>(`/layers/${layerId}/features?${params}`, {
    signal: options.signal ?? null,
  })
}

export const getFields = (layerId: string) => apiFetch<FieldList>(`/layers/${layerId}/fields`)

export const getAttributes = (
  layerId: string,
  options: {
    page?: number
    pageSize?: number
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
    filters?: AttributeFilter[]
  } = {},
) => {
  const params = new URLSearchParams()
  if (options.page) params.set('page', String(options.page))
  if (options.pageSize) params.set('pageSize', String(options.pageSize))
  if (options.sortBy) params.set('sortBy', options.sortBy)
  if (options.sortOrder) params.set('sortOrder', options.sortOrder)
  if (options.filters?.length) params.set('filters', JSON.stringify(options.filters))
  return apiFetch<AttributePage>(`/layers/${layerId}/attributes?${params}`)
}

export const createFeature = (
  layerId: string,
  body: { geometry: GeoJSON.Geometry; properties: Record<string, unknown> },
) => apiFetch<GeoFeature>(`/layers/${layerId}/features`, { method: 'POST', json: body })

export const updateFeature = (
  layerId: string,
  featureId: string,
  patch: { geometry?: GeoJSON.Geometry; properties?: Record<string, unknown> },
) =>
  apiFetch<GeoFeature>(`/layers/${layerId}/features/${featureId}`, {
    method: 'PATCH',
    json: patch,
  })

export const deleteFeature = (layerId: string, featureId: string) =>
  apiFetch<void>(`/layers/${layerId}/features/${featureId}`, { method: 'DELETE' })

/** Template URL for OpenLayers tile sources. */
export const tileUrl = (layerId: string, ext: 'mvt' | 'png') =>
  `${API_BASE}/layers/${layerId}/tiles/{z}/{x}/{y}.${ext}`
