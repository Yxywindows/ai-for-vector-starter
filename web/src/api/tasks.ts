import { apiFetch } from './client'
import type { Task, TaskLogEntry, TaskPage } from './types'

export interface ListTasksOptions {
  projectId?: string
  type?: string
  state?: string
  page?: number
  pageSize?: number
  signal?: AbortSignal
}

export const listTasks = (options: ListTasksOptions = {}) => {
  const params = new URLSearchParams()
  if (options.projectId) params.set('projectId', options.projectId)
  if (options.type) params.set('type', options.type)
  if (options.state) params.set('state', options.state)
  if (options.page) params.set('page', String(options.page))
  if (options.pageSize) params.set('pageSize', String(options.pageSize))
  const suffix = params.size > 0 ? `?${params}` : ''
  return apiFetch<TaskPage>(`/tasks${suffix}`, { signal: options.signal ?? null })
}

export const getTask = (taskId: string) => apiFetch<Task>(`/tasks/${taskId}`)

export const getTaskLogs = (taskId: string) =>
  apiFetch<{ taskId: string; entries: TaskLogEntry[] }>(`/tasks/${taskId}/logs`)

export const cancelTask = (taskId: string) =>
  apiFetch<Task>(`/tasks/${taskId}/cancel`, { method: 'POST' })

export const retryTask = (taskId: string) =>
  apiFetch<Task>(`/tasks/${taskId}/retry`, { method: 'POST' })
