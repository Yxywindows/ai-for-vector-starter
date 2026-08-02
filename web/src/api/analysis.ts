import { apiFetch } from './client'
import type { Task } from './types'

export type AnalysisTool =
  | 'buffer'
  | 'clip'
  | 'intersection'
  | 'dissolve'
  | 'spatial-join'
  | 'validate-repair'
  | 'point-in-polygon'

export const submitAnalysis = (
  projectId: string,
  tool: AnalysisTool,
  body: Record<string, unknown>,
) => apiFetch<Task>(`/projects/${projectId}/analysis/${tool}`, { method: 'POST', json: body })
