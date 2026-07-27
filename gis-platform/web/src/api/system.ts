import { apiFetch } from './client'
import type { MemoryReport, RasterStatistics } from './types'

export const getMemoryReport = () => apiFetch<MemoryReport>('/system/memory')

export const getRasterStatistics = (layerId: string) =>
  apiFetch<RasterStatistics>(`/layers/${layerId}/statistics`)
