import { apiFetch } from './client'
import type { Layer, MapView, Project, ProjectSummary, StyleSpec } from './types'

export const listProjects = () => apiFetch<ProjectSummary[]>('/projects')

export const createProject = (name: string) =>
  apiFetch<Project>('/projects', { method: 'POST', json: { name } })

export const getProject = (projectId: string) => apiFetch<Project>(`/projects/${projectId}`)

export const updateProject = (projectId: string, patch: { name?: string; view?: MapView }) =>
  apiFetch<Project>(`/projects/${projectId}`, { method: 'PATCH', json: patch })

export const createLayer = (projectId: string, body: Record<string, unknown>) =>
  apiFetch<Layer>(`/projects/${projectId}/layers`, { method: 'POST', json: body })

export const updateLayer = (
  layerId: string,
  patch: { name?: string; visible?: boolean; opacity?: number; style?: StyleSpec },
) => apiFetch<Layer>(`/layers/${layerId}`, { method: 'PATCH', json: patch })

export const deleteLayer = (layerId: string) =>
  apiFetch<void>(`/layers/${layerId}`, { method: 'DELETE' })

export const reorderLayers = (projectId: string, layerIds: string[]) =>
  apiFetch<Layer[]>(`/projects/${projectId}/layers/reorder`, { method: 'POST', json: { layerIds } })

export const registerPostgisTable = (
  projectId: string,
  body: {
    schemaName: string
    tableName: string
    geometryColumn: string
    idColumn: string
    name: string
  },
) => apiFetch<Layer>(`/projects/${projectId}/layers/from-postgis`, { method: 'POST', json: body })

function uploadForm(file: File, name?: string): FormData {
  const form = new FormData()
  form.append('file', file)
  if (name) form.append('name', name)
  return form
}

export const importVector = (projectId: string, file: File, name?: string) =>
  apiFetch<Layer>(`/projects/${projectId}/layers/import`, {
    method: 'POST',
    body: uploadForm(file, name),
  })

export const importRaster = (projectId: string, file: File, name?: string) =>
  apiFetch<Layer>(`/projects/${projectId}/layers/import-raster`, {
    method: 'POST',
    body: uploadForm(file, name),
  })
