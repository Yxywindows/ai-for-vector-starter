import { apiFetch } from './client'
import type { MemoryReport, RasterStatistics, SystemOverview } from './types'

export const getMemoryReport = () => apiFetch<MemoryReport>('/system/memory')

export const getOverview = () => apiFetch<SystemOverview>('/system/overview')

export const getRasterStatistics = (layerId: string) =>
  apiFetch<RasterStatistics>(`/layers/${layerId}/statistics`)
