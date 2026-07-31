import { apiFetch } from './client'
import type { ImportLimits, ImportResult } from './types'

export const getImportLimits = () => apiFetch<ImportLimits>('/system/import-limits')

export const confirmImportDraft = (
  projectId: string,
  body: { name: string; sourceFilename: string; featureCollection: unknown },
) =>
  apiFetch<ImportResult>(`/projects/${projectId}/layers/import-draft`, {
    method: 'POST',
    json: body,
  })
