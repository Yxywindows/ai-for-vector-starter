import { API_BASE, apiFetch } from './client'
import type { AttributeFilter, Task } from './types'

export type VectorExportFormat = 'geojson' | 'csv' | 'gpkg' | 'shp'

export interface VectorExportBody {
  layerId: string
  format: VectorExportFormat
  /** Omit to export every attribute column. */
  fields?: string[]
  /** EPSG code for the output coordinates (default 4326). */
  crs?: number
  filters?: AttributeFilter[]
  featureIds?: string[]
  /** [minX, minY, maxX, maxY] in EPSG:4326. */
  bbox?: number[]
  filename?: string
}

export interface RasterExportBody {
  layerId: string
  filename?: string
}

export const submitVectorExport = (projectId: string, body: VectorExportBody) =>
  apiFetch<Task>(`/projects/${projectId}/exports/vector`, { method: 'POST', json: body })

export const submitRasterExport = (projectId: string, body: RasterExportBody) =>
  apiFetch<Task>(`/projects/${projectId}/exports/raster`, { method: 'POST', json: body })

/** Direct link for the browser's own downloader — not an XHR. */
export const exportDownloadUrl = (taskId: string) => `${API_BASE}/tasks/${taskId}/download`
